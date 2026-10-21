// Package notify pushes "schedule updated" and alert events to connected
// clients over websocket, plus an optional rate-limited QQ private push.
package notify

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/qqsched/server/internal/store"
)

// Event types pushed to clients.
const (
	EventScheduleUpdated = "schedule.updated"
	EventAlertCreated    = "alert.created"
	EventAgentAction     = "agent.action"
)

// Event is the websocket envelope.
type Event struct {
	Type        string             `json:"type"`
	UserID      string             `json:"user_id"`
	Revision    int64              `json:"revision,omitempty"`
	Alert       *store.Alert       `json:"alert,omitempty"`
	AgentAction *store.AgentAction `json:"agent_action,omitempty"`
	SentAt      time.Time          `json:"sent_at"`
}

// Hub tracks connected websocket clients per user.
type Hub struct {
	log      *slog.Logger
	upgrader websocket.Upgrader

	mu      sync.RWMutex
	clients map[string]map[*client]struct{}
}

type client struct {
	conn   *websocket.Conn
	userID string
	hub    *Hub
	send   chan []byte
	once   sync.Once
}

// NewHub builds a notification hub.
func NewHub(log *slog.Logger) *Hub {
	if log == nil {
		log = slog.Default()
	}
	return &Hub{
		log:      log,
		clients:  map[string]map[*client]struct{}{},
		upgrader: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
	}
}

// ServeWS upgrades the request (already authenticated) into a push channel.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request, userID string) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.log.Warn("notify ws upgrade failed", "err", err)
		return
	}
	c := &client{conn: conn, userID: userID, hub: h, send: make(chan []byte, 64)}
	h.register(c)
	go c.writeLoop()
	c.readLoop()
	h.unregister(c)
}

func (h *Hub) register(c *client) {
	h.mu.Lock()
	if h.clients[c.userID] == nil {
		h.clients[c.userID] = map[*client]struct{}{}
	}
	h.clients[c.userID][c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) unregister(c *client) {
	h.mu.Lock()
	if set, ok := h.clients[c.userID]; ok {
		delete(set, c)
		if len(set) == 0 {
			delete(h.clients, c.userID)
		}
	}
	h.mu.Unlock()
	c.close()
}

// SendToUser delivers an event to every connection of a user.
func (h *Hub) SendToUser(userID string, ev Event) {
	if userID == "" {
		return
	}
	ev.UserID = userID
	if ev.SentAt.IsZero() {
		ev.SentAt = time.Now().UTC()
	}
	buf, err := json.Marshal(ev)
	if err != nil {
		h.log.Error("marshal notify event", "err", err)
		return
	}
	h.mu.RLock()
	set := h.clients[userID]
	targets := make([]*client, 0, len(set))
	for c := range set {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	for _, c := range targets {
		select {
		case c.send <- buf:
		default:
			h.log.Warn("notify client buffer full, dropping event", "user", userID)
		}
	}
}

// PushScheduleUpdate notifies a user that their schedule revision changed.
func (h *Hub) PushScheduleUpdate(userID string, revision int64) {
	h.SendToUser(userID, Event{Type: EventScheduleUpdated, Revision: revision})
}

// PushAlert notifies a user about a new "needs human review" alert.
func (h *Hub) PushAlert(userID string, alert store.Alert) {
	a := alert
	h.SendToUser(userID, Event{Type: EventAlertCreated, Alert: &a})
}

// PushAgentAction delivers an LLM/bot command to the user's live clients.
func (h *Hub) PushAgentAction(userID string, act store.AgentAction) {
	a := act
	h.SendToUser(userID, Event{Type: EventAgentAction, AgentAction: &a})
}

// ClientCount returns the number of live connections (for /metrics).
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	n := 0
	for _, set := range h.clients {
		n += len(set)
	}
	return n
}

func (c *client) readLoop() {
	defer c.hub.unregister(c)
	c.conn.SetReadLimit(1 << 20)
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}

func (c *client) writeLoop() {
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case buf, ok := <-c.send:
			if !ok {
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, buf); err != nil {
				return
			}
		case <-ping.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *client) close() {
	c.once.Do(func() {
		close(c.send)
		_ = c.conn.Close()
	})
}

// QQAPI is the subset of the OneBot caller needed for private pushes.
type QQAPI interface {
	SendPrivateMsg(ctx context.Context, userID, message string) (int64, error)
}

// QQPusher optionally mirrors alerts into QQ private messages with per-user
// hourly rate limiting.
type QQPusher struct {
	api     QQAPI
	enabled bool
	limit   int
	log     *slog.Logger

	mu     sync.Mutex
	counts map[string][]time.Time
}

// NewQQPusher builds the QQ private pusher.
func NewQQPusher(api QQAPI, enabled bool, perHour int, log *slog.Logger) *QQPusher {
	if log == nil {
		log = slog.Default()
	}
	if perHour <= 0 {
		perHour = 5
	}
	return &QQPusher{api: api, enabled: enabled, limit: perHour, log: log, counts: map[string][]time.Time{}}
}

// Enabled reports whether QQ private push is active.
func (p *QQPusher) Enabled() bool { return p != nil && p.enabled && p.api != nil }

// Push sends a rate-limited private message to a QQ identity.
func (p *QQPusher) Push(ctx context.Context, qqUID, message string) error {
	if !p.Enabled() || qqUID == "" || message == "" {
		return nil
	}
	if !p.allow(qqUID) {
		p.log.Warn("qq private push rate limited", "qq", qqUID)
		return nil
	}
	_, err := p.api.SendPrivateMsg(ctx, qqUID, message)
	return err
}

// PushAlert mirrors an alert into a QQ private message.
func (p *QQPusher) PushAlert(ctx context.Context, alert store.Alert) error {
	if !p.Enabled() {
		return nil
	}
	msg := buildQQMessage(alert)
	return p.Push(ctx, alert.UserQQ, msg)
}

func (p *QQPusher) allow(qqUID string) bool {
	now := time.Now()
	cutoff := now.Add(-time.Hour)
	p.mu.Lock()
	defer p.mu.Unlock()
	times := p.counts[qqUID]
	kept := times[:0]
	for _, t := range times {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= p.limit {
		p.counts[qqUID] = kept
		return false
	}
	p.counts[qqUID] = append(kept, now)
	return true
}

func buildQQMessage(a store.Alert) string {
	var b strings.Builder
	b.WriteString("【需人工查看】")
	b.WriteString(a.Title)
	b.WriteString("\n")
	b.WriteString(a.Summary)
	if a.ContextExcerpt != "" {
		b.WriteString("\n上文：")
		b.WriteString(a.ContextExcerpt)
	}
	return b.String()
}
