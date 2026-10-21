package v11

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/qqsched/server/internal/onebot"
)

// Config configures the reverse websocket server.
type Config struct {
	Token        string
	Path         string
	CallTimeout  time.Duration
	EventsBuffer int
}

// Server accepts inbound OneBot v11 reverse websocket connections and exposes a
// duplex action caller over them.
type Server struct {
	cfg      Config
	log      *slog.Logger
	upgrader websocket.Upgrader
	events   chan onebot.Event
	api      *API

	mu      sync.RWMutex
	conns   map[string]*clientConn
	pending map[string]chan callResult
	seq     atomic.Uint64
	started atomic.Bool
}

type clientConn struct {
	id      string
	conn    *websocket.Conn
	writeMu sync.Mutex
	selfID  string
}

type callResult struct {
	raw json.RawMessage
	err error
}

// NewServer builds a reverse-WS provider.
func NewServer(cfg Config, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	if cfg.Path == "" {
		cfg.Path = "/onebot/v11/ws"
	}
	if cfg.CallTimeout <= 0 {
		cfg.CallTimeout = 15 * time.Second
	}
	if cfg.EventsBuffer <= 0 {
		cfg.EventsBuffer = 512
	}
	s := &Server{
		cfg:     cfg,
		log:     log,
		events:  make(chan onebot.Event, cfg.EventsBuffer),
		conns:   map[string]*clientConn{},
		pending: map[string]chan callResult{},
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1 << 16,
			WriteBufferSize: 1 << 16,
			CheckOrigin:     func(*http.Request) bool { return true },
		},
	}
	s.api = NewAPI(s, log)
	return s
}

// Name identifies the provider.
func (s *Server) Name() string { return "onebot-v11-reverse-ws" }

// Start marks the provider ready.
func (s *Server) Start(context.Context) error {
	s.started.Store(true)
	return nil
}

// Stop closes every live websocket connection.
func (s *Server) Stop(context.Context) error {
	s.mu.Lock()
	conns := make([]*clientConn, 0, len(s.conns))
	for _, c := range s.conns {
		conns = append(conns, c)
	}
	s.conns = map[string]*clientConn{}
	s.mu.Unlock()
	for _, c := range conns {
		_ = c.conn.Close()
	}
	return nil
}

// Events exposes the normalized event stream.
func (s *Server) Events() <-chan onebot.Event { return s.events }

// API exposes the action caller.
func (s *Server) API() onebot.APICaller { return s.api }

// Path returns the configured websocket route.
func (s *Server) Path() string { return s.cfg.Path }

// Handler serves the websocket upgrade endpoint.
func (s *Server) Handler() http.Handler { return http.HandlerFunc(s.ServeWS) }

// ServeWS upgrades an authorized HTTP request into a bot connection.
func (s *Server) ServeWS(w http.ResponseWriter, r *http.Request) {
	if !authorized(r, s.cfg.Token) {
		s.log.Warn("rejected onebot connection: bad token", "remote", r.RemoteAddr)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.log.Warn("websocket upgrade failed", "err", err)
		return
	}
	cl := &clientConn{
		id:   fmt.Sprintf("conn-%d", s.seq.Add(1)),
		conn: conn,
	}
	s.register(cl)
	s.log.Info("onebot connection established", "conn", cl.id, "remote", r.RemoteAddr)
	defer func() {
		s.unregister(cl)
		_ = conn.Close()
		s.log.Info("onebot connection closed", "conn", cl.id)
	}()

	conn.SetReadLimit(8 << 20)
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			if !isNormalClose(err) {
				s.log.Debug("read loop ended", "conn", cl.id, "err", err)
			}
			return
		}
		s.handle(cl, data)
	}
}

func (s *Server) handle(cl *clientConn, data []byte) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var payload map[string]any
	if err := dec.Decode(&payload); err != nil {
		s.log.Debug("decode inbound frame failed", "err", err)
		return
	}

	// Action response detection: responses always carry an echo.
	if echo, ok := payload["echo"]; ok {
		if _, isEvent := payload["post_type"]; !isEvent {
			s.resolveEcho(anyToString(echo), json.RawMessage(data))
			return
		}
	}

	ev, ok := onebot.NormalizeV11(payload)
	if !ok {
		s.log.Debug("ignored unrecognized event", "post_type", payload["post_type"])
		return
	}
	s.emit(ev)
}

func (s *Server) emit(ev onebot.Event) {
	select {
	case s.events <- ev:
	default:
		s.log.Warn("event buffer full, dropping event", "kind", ev.Kind, "group", ev.GroupID)
	}
}

// Call implements Caller by writing an action frame and awaiting its echo.
func (s *Server) Call(ctx context.Context, action string, params map[string]any) (json.RawMessage, error) {
	cl := s.pickConn()
	if cl == nil {
		return nil, errors.New("onebot: no connected client")
	}
	echo := fmt.Sprintf("srv-%d", s.seq.Add(1))
	ch := make(chan callResult, 1)
	s.mu.Lock()
	s.pending[echo] = ch
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.pending, echo)
		s.mu.Unlock()
	}()

	frame := map[string]any{"action": action, "params": params, "echo": echo}
	if err := cl.writeJSON(frame); err != nil {
		return nil, fmt.Errorf("onebot: write action %s: %w", action, err)
	}

	timer := time.NewTimer(s.cfg.CallTimeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, fmt.Errorf("onebot: action %s timed out after %s", action, s.cfg.CallTimeout)
	case res := <-ch:
		return res.raw, res.err
	}
}

func (s *Server) resolveEcho(echo string, raw json.RawMessage) {
	if echo == "" {
		return
	}
	s.mu.RLock()
	ch, ok := s.pending[echo]
	s.mu.RUnlock()
	if !ok {
		return
	}
	select {
	case ch <- callResult{raw: raw}:
	default:
	}
}

func (s *Server) register(cl *clientConn) {
	s.mu.Lock()
	s.conns[cl.id] = cl
	s.mu.Unlock()
}

func (s *Server) unregister(cl *clientConn) {
	s.mu.Lock()
	delete(s.conns, cl.id)
	s.mu.Unlock()
}

func (s *Server) pickConn() *clientConn {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, c := range s.conns {
		return c
	}
	return nil
}

func (c *clientConn) writeJSON(v any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.WriteJSON(v)
}

func authorized(r *http.Request, token string) bool {
	if token == "" {
		return true
	}
	got := ""
	if h := r.Header.Get("Authorization"); h != "" {
		if strings.HasPrefix(h, "Bearer ") {
			got = strings.TrimPrefix(h, "Bearer ")
		} else {
			got = h
		}
	}
	if got == "" {
		got = r.URL.Query().Get("access_token")
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1
}

func isNormalClose(err error) bool {
	return websocket.IsCloseError(err,
		websocket.CloseNormalClosure,
		websocket.CloseGoingAway,
		websocket.CloseNoStatusReceived,
		websocket.CloseAbnormalClosure,
	)
}

func anyToString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		return fmt.Sprintf("%v", t)
	default:
		return ""
	}
}
