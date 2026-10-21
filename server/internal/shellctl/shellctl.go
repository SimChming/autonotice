// Package shellctl keeps long-lived shell processes so the bot can offer an
// interactive-feeling (stateful) command session: the working directory,
// environment and shell variables survive across separate commands.
//
// There is no PTY involved — stdin/stdout are pipes — so full-screen
// interactive programs (vim, top, ...) do not work. Everything else behaves
// like an ordinary SSH session.
package shellctl

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ErrTimeout reports that a command produced no completion marker in time. The
// session is discarded so the next command starts from a clean shell.
var ErrTimeout = errors.New("shellctl: command timed out")

const (
	// sentinelPrefix starts the marker line printed after every command.
	sentinelPrefix = "__QQSA_DONE__"
	// maxOutputBytes caps how much output one command may produce.
	maxOutputBytes = 256 * 1024
	// defaultIdle is how long an unused session is kept alive.
	defaultIdle = 30 * time.Minute
)

// Manager owns the per-key shell sessions.
type Manager struct {
	idle time.Duration
	log  *slog.Logger

	mu       sync.Mutex
	sessions map[string]*session
}

// New builds a session manager. A non-positive idle duration falls back to
// 30 minutes.
func New(idle time.Duration, log *slog.Logger) *Manager {
	if idle <= 0 {
		idle = defaultIdle
	}
	if log == nil {
		log = slog.Default()
	}
	return &Manager{idle: idle, log: log, sessions: map[string]*session{}}
}

// Start launches the idle-reaper until ctx is cancelled.
func (m *Manager) Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.reap()
			}
		}
	}()
}

// Run executes one command inside the session identified by key and returns its
// combined output (stdout+stderr) plus the exit code.
func (m *Manager) Run(ctx context.Context, key, command string) (string, int, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		key = "default"
	}
	for attempt := 0; attempt < 2; attempt++ {
		s, err := m.acquire(key)
		if err != nil {
			return "", -1, err
		}
		s.mu.Lock()
		if s.dead {
			// Replaced concurrently; drop it and start a fresh shell.
			s.mu.Unlock()
			m.forget(key, s)
			continue
		}
		out, code, runErr := s.run(ctx, command)
		s.last = time.Now()
		if errors.Is(runErr, ErrTimeout) {
			s.dead = true
		}
		s.mu.Unlock()

		if errors.Is(runErr, ErrTimeout) {
			// Discard the wedged session outside of any lock to avoid nesting
			// s.mu and m.mu (which would deadlock against the idle reaper).
			s.close()
			m.forget(key, s)
		}
		return out, code, runErr
	}
	return "", -1, errors.New("shellctl: session unavailable")
}

// Reset kills the session so the next command starts in a fresh shell.
func (m *Manager) Reset(key string) {
	key = strings.TrimSpace(key)
	if key == "" {
		key = "default"
	}
	m.mu.Lock()
	s, ok := m.sessions[key]
	if ok {
		delete(m.sessions, key)
	}
	m.mu.Unlock()
	if ok {
		s.mu.Lock()
		s.dead = true
		s.close()
		s.mu.Unlock()
	}
}

// CloseAll terminates every live session.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	sessions := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.sessions = map[string]*session{}
	m.mu.Unlock()
	for _, s := range sessions {
		s.mu.Lock()
		s.dead = true
		s.close()
		s.mu.Unlock()
	}
}

func (m *Manager) acquire(key string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[key]; ok && !s.dead {
		return s, nil
	}
	s, err := startSession()
	if err != nil {
		return nil, err
	}
	m.sessions[key] = s
	m.log.Info("shell session started", "key", key)
	return s, nil
}

func (m *Manager) replace(key string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := startSession()
	if err != nil {
		return nil, err
	}
	m.sessions[key] = s
	m.log.Info("shell session restarted", "key", key)
	return s, nil
}

func (m *Manager) forget(key string, s *session) {
	m.mu.Lock()
	if cur, ok := m.sessions[key]; ok && cur == s {
		delete(m.sessions, key)
	}
	m.mu.Unlock()
}

func (m *Manager) reap() {
	cutoff := time.Now().Add(-m.idle)
	m.mu.Lock()
	var expired []*session
	for key, s := range m.sessions {
		s.mu.Lock()
		stale := !s.dead && s.last.Before(cutoff)
		if stale {
			s.dead = true
			s.close()
			expired = append(expired, s)
			delete(m.sessions, key)
		}
		s.mu.Unlock()
	}
	m.mu.Unlock()
	for range expired {
		m.log.Info("shell session reaped (idle)")
	}
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

type session struct {
	mu   sync.Mutex
	cmd  *exec.Cmd
	in   io.WriteCloser
	out  *bufio.Reader
	last time.Time
	dead bool
}

func startSession() (*session, error) {
	cmd := exec.Command("bash")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("shellctl: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("shellctl: stdout pipe: %w", err)
	}
	// Stderr is redirected to /dev/null; commands merge it into stdout with 2>&1.
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("shellctl: start bash: %w", err)
	}
	return &session{
		cmd:  cmd,
		in:   stdin,
		out:  bufio.NewReaderSize(stdout, 64*1024),
		last: time.Now(),
	}, nil
}

// run writes the command plus a completion marker and reads until the marker
// is seen. The caller must hold s.mu.
func (s *session) run(ctx context.Context, command string) (string, int, error) {
	// stdin of the user command is /dev/null so programs like `cat` cannot eat
	// the marker line we are about to write next.
	script := strings.Join([]string{
		"{ " + command + " ; } </dev/null 2>&1",
		"__qqsa_st=$?",
		"printf '" + sentinelPrefix + "%s__\\n' \"$__qqsa_st\"",
	}, "\n") + "\n"

	if _, err := io.WriteString(s.in, script); err != nil {
		return "", -1, fmt.Errorf("shellctl: write command: %w", err)
	}

	type result struct {
		out  string
		exit int
		err  error
	}
	done := make(chan result, 1)

	go func() {
		var b strings.Builder
		truncated := false
		for {
			line, err := s.out.ReadString('\n')
			if idx := strings.Index(line, sentinelPrefix); idx >= 0 {
				rest := strings.TrimSuffix(line[idx+len(sentinelPrefix):], "\n")
				rest = strings.TrimSuffix(rest, "__")
				code, convErr := strconv.Atoi(strings.TrimSpace(rest))
				if convErr != nil {
					code = -1
				}
				done <- result{out: b.String(), exit: code}
				return
			}
			if line != "" && !truncated {
				if b.Len()+len(line) > maxOutputBytes {
					remain := maxOutputBytes - b.Len()
					if remain > 0 {
						b.WriteString(line[:remain])
					}
					b.WriteString("\n…（输出过长，已截断）")
					truncated = true
				} else {
					b.WriteString(line)
				}
			}
			if err != nil {
				done <- result{out: b.String(), exit: -1, err: err}
				return
			}
		}
	}()

	select {
	case <-ctx.Done():
		return "", -1, ErrTimeout
	case r := <-done:
		return r.out, r.exit, r.err
	}
}

func (s *session) close() {
	if s.in != nil {
		_ = s.in.Close()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		_, _ = s.cmd.Process.Wait()
	}
}
