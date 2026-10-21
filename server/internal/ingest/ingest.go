// Package ingest normalizes inbound OneBot events, de-duplicates them by
// fingerprint, persists them and enqueues extracted content assets.
package ingest

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/qqsched/server/internal/onebot"
	"github.com/qqsched/server/internal/store"
)

// AssetSink accepts extracted content assets for background processing.
type AssetSink interface {
	Enqueue(a store.ContentAsset)
}

// BindVerifier confirms an in-group "#bind <code>" verification.
type BindVerifier interface {
	VerifyGroupBindCode(ctx context.Context, senderQQ, groupID, code string) (bool, error)
}

// Responder optionally answers chat messages (bot persona / shell control).
type Responder interface {
	HandleMessage(ctx context.Context, ev onebot.Event) error
}

// GroupNamer resolves and persists friendly group names for display.
type GroupNamer interface {
	Ensure(ctx context.Context, groupID string)
}

var bindPattern = regexp.MustCompile(`(?i)#bind\s+([0-9]{4,8})`)

// Service consumes normalized events.
type Service struct {
	store         *store.Store
	sink          AssetSink
	log           *slog.Logger
	allowedGroups map[string]bool

	mu     sync.RWMutex
	binder BindVerifier

	responder  Responder
	groupNamer GroupNamer
}

// New builds the ingest service. An empty allowedGroups list observes every group.
func New(st *store.Store, sink AssetSink, log *slog.Logger, allowedGroups []string) *Service {
	if log == nil {
		log = slog.Default()
	}
	allowed := make(map[string]bool, len(allowedGroups))
	for _, g := range allowedGroups {
		if g != "" {
			allowed[g] = true
		}
	}
	return &Service{store: st, sink: sink, log: log, allowedGroups: allowed}
}

// SetBindVerifier wires the QQ binding verification service.
func (s *Service) SetBindVerifier(v BindVerifier) {
	s.mu.Lock()
	s.binder = v
	s.mu.Unlock()
}

// SetResponder wires the in-chat bot controller.
func (s *Service) SetResponder(r Responder) {
	s.mu.Lock()
	s.responder = r
	s.mu.Unlock()
}

// SetGroupNamer wires the group-name resolver.
func (s *Service) SetGroupNamer(g GroupNamer) {
	s.mu.Lock()
	s.groupNamer = g
	s.mu.Unlock()
}

// Run consumes the event stream until the context is cancelled.
func (s *Service) Run(ctx context.Context, events <-chan onebot.Event) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-events:
			if !ok {
				return
			}
			if err := s.HandleEvent(ctx, ev); err != nil {
				s.log.Error("ingest event", "kind", ev.Kind, "group", ev.GroupID, "err", err)
			}
		}
	}
}

// HandleEvent stores one normalized event and enqueues its assets.
func (s *Service) HandleEvent(ctx context.Context, ev onebot.Event) error {
	switch ev.Kind {
	case onebot.KindMessage:
		return s.handleMessage(ctx, ev)
	case onebot.KindNotice, onebot.KindMeta, onebot.KindRequest:
		s.log.Debug("ignoring non-message event", "kind", ev.Kind, "notice", ev.NoticeType)
		return nil
	default:
		return nil
	}
}

func (s *Service) handleMessage(ctx context.Context, ev onebot.Event) error {
	// In-chat bot (persona / shell control) runs detached so ingestion is never
	// blocked by a slow model call or command; failures only get logged.
	s.dispatchResponder(ctx, ev)

	if !s.allowed(ev) {
		s.log.Debug("group not allowed, skipping", "group", ev.GroupID)
		return nil
	}

	// In-group binding verification: "#bind 123456".
	if ev.IsGroup() {
		if m := bindPattern.FindStringSubmatch(ev.Text); len(m) == 2 {
			s.tryVerifyBind(ctx, ev, m[1])
		}
	}

	now := time.Now().UTC()
	msgTime := now
	if ev.Time > 0 {
		msgTime = time.Unix(ev.Time, 0).UTC()
	}

	msg := store.Message{
		GroupID:      ev.GroupID,
		MessageID:    ev.MessageID,
		SenderQQ:     ev.UserID,
		SenderName:   ev.Sender.DisplayName(),
		MessageType:  messageType(ev),
		SubType:      ev.SubType,
		Text:         ev.Text,
		RawMessage:   ev.RawMessage,
		SegmentsJSON: encodeSegments(ev.Segments),
		Mentions:     ev.Mentions,
		ReplyToMsgID: ev.ReplyTo,
		Fingerprint:  fingerprint(ev.GroupID, ev.MessageID, ev.SubType),
		MsgTime:      msgTime,
		CreatedAt:    now,
	}

	inserted, err := s.store.InsertMessage(ctx, msg)
	if err != nil {
		return fmt.Errorf("insert message: %w", err)
	}
	if !inserted {
		s.log.Debug("duplicate message ignored", "group", ev.GroupID, "message_id", ev.MessageID)
		return nil
	}

	if ev.IsGroup() && ev.GroupID != "" {
		if err := s.store.UpsertGroup(ctx, ev.GroupID, ""); err != nil {
			s.log.Warn("upsert group", "group", ev.GroupID, "err", err)
		}
		s.ensureGroupName(ctx, ev.GroupID)
	}

	assets := ExtractAssets(ev, msg.ID, msg.GroupID, msg.SenderQQ, now)
	for i := range assets {
		saved, isNew, err := s.store.InsertAsset(ctx, assets[i])
		if err != nil {
			s.log.Error("insert asset", "kind", assets[i].Kind, "err", err)
			continue
		}
		if !isNew {
			s.log.Debug("duplicate asset ignored", "fingerprint", assets[i].Fingerprint)
			continue
		}
		if s.sink != nil {
			s.sink.Enqueue(*saved)
		}
	}
	return nil
}

func (s *Service) tryVerifyBind(ctx context.Context, ev onebot.Event, code string) {
	s.mu.RLock()
	binder := s.binder
	s.mu.RUnlock()
	if binder == nil {
		return
	}
	ok, err := binder.VerifyGroupBindCode(ctx, ev.UserID, ev.GroupID, code)
	if err != nil {
		s.log.Warn("bind verification failed", "qq", ev.UserID, "err", err)
		return
	}
	if ok {
		s.log.Info("qq binding verified", "qq", ev.UserID, "group", ev.GroupID)
	}
}

// dispatchResponder hands the message to the in-chat bot without blocking the
// ingest pipeline.
func (s *Service) dispatchResponder(ctx context.Context, ev onebot.Event) {
	s.mu.RLock()
	r := s.responder
	s.mu.RUnlock()
	if r == nil {
		return
	}
	go func() {
		if err := r.HandleMessage(ctx, ev); err != nil {
			s.log.Warn("bot handle message", "group", ev.GroupID, "user", ev.UserID, "err", err)
		}
	}()
}

// ensureGroupName asks the namer (idempotent per group) to resolve the name.
func (s *Service) ensureGroupName(ctx context.Context, groupID string) {
	s.mu.RLock()
	g := s.groupNamer
	s.mu.RUnlock()
	if g == nil {
		return
	}
	g.Ensure(ctx, groupID)
}

func (s *Service) allowed(ev onebot.Event) bool {
	if len(s.allowedGroups) == 0 {
		return true
	}
	if ev.GroupID == "" {
		// Private messages are always observed (needed for private #bind).
		return true
	}
	return s.allowedGroups[ev.GroupID]
}

func messageType(ev onebot.Event) string {
	if ev.MessageType != "" {
		return ev.MessageType
	}
	if ev.GroupID != "" {
		return "group"
	}
	return "private"
}

func fingerprint(groupID, messageID, subType string) string {
	sum := sha1.Sum([]byte(groupID + "|" + messageID + "|" + subType))
	return "msg-" + hex.EncodeToString(sum[:12])
}

func encodeSegments(segs []onebot.Segment) string {
	if len(segs) == 0 {
		return ""
	}
	buf, err := json.Marshal(segs)
	if err != nil {
		return ""
	}
	return string(buf)
}

// Used by extract.go as well.
func hashKey(parts ...string) string {
	sum := sha1.Sum([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(sum[:12])
}
