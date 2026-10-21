package bot

import (
	"strings"
	"sync"
	"time"
)

// turn is one line of the emulated conversation handed back to the model.
type turn struct {
	role   string // "user" | "assistant" | "tool"
	sender string // QQ of the speaker; only set for "user" turns
	text   string
}

type entry struct {
	turns []turn
	at    time.Time
}

// history is a tiny in-memory, per-session, TTL-bounded conversation log. The
// bot has no persistence requirements, so a map is enough.
type history struct {
	ttl   time.Duration
	turns int

	mu sync.Mutex
	m  map[string]*entry
}

func newHistory(ttl time.Duration, turns int) *history {
	if ttl <= 0 {
		ttl = 2 * time.Hour
	}
	if turns <= 0 {
		turns = 12
	}
	return &history{ttl: ttl, turns: turns, m: map[string]*entry{}}
}

// appendTurn records a fully specified turn.
func (h *history) appendTurn(key string, t turn) []turn {
	return h.appendFrom(key, t)
}

// hydrate seeds a session from persisted turns when it is not already loaded.
func (h *history) hydrate(key string, turns []turn) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if e := h.m[key]; e != nil && len(e.turns) > 0 {
		return false
	}
	e := &entry{turns: append([]turn(nil), turns...), at: time.Now()}
	if len(e.turns) > h.turns {
		e.turns = e.turns[len(e.turns)-h.turns:]
	}
	h.m[key] = e
	return true
}

// append records a turn and returns a snapshot (oldest first) for prompting.
func (h *history) append(key, role, text string) []turn {
	return h.appendFrom(key, turn{role: role, text: text})
}

// appendUser records a user turn tagged with the sender's QQ, so group history
// keeps track of who said what (master vs classmates) when prompting.
func (h *history) appendUser(key, qq, text string) []turn {
	return h.appendFrom(key, turn{role: "user", sender: qq, text: text})
}

func (h *history) appendFrom(key string, t turn) []turn {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.gc()
	e := h.m[key]
	if e == nil {
		e = &entry{}
		h.m[key] = e
	}
	if strings.TrimSpace(t.text) != "" {
		e.turns = append(e.turns, t)
	}
	if len(e.turns) > h.turns {
		e.turns = e.turns[len(e.turns)-h.turns:]
	}
	e.at = time.Now()
	return append([]turn(nil), e.turns...)
}

func (h *history) gc() {
	cutoff := time.Now().Add(-h.ttl)
	for k, e := range h.m {
		if e.at.Before(cutoff) {
			delete(h.m, k)
		}
	}
}
