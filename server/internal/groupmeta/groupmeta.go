// Package groupmeta backfills QQ group display names so schedule sources and
// the client can show a readable group name instead of a bare number.
package groupmeta

import (
	"context"
	"log/slog"
	"sync"

	"github.com/qqsched/server/internal/onebot"
	"github.com/qqsched/server/internal/store"
)

// Service resolves group names at most once per group per process.
type Service struct {
	api onebot.APICaller
	st  *store.Store
	log *slog.Logger

	mu   sync.Mutex
	seen map[string]bool
}

// New builds the group-name resolver.
func New(api onebot.APICaller, st *store.Store, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{api: api, st: st, log: log, seen: map[string]bool{}}
}

// Ensure fetches and stores the group name the first time a group is observed.
// Failures are logged and ignored: the client falls back to showing the id.
func (s *Service) Ensure(ctx context.Context, groupID string) {
	if s == nil || s.api == nil || groupID == "" {
		return
	}
	s.mu.Lock()
	if s.seen[groupID] {
		s.mu.Unlock()
		return
	}
	s.seen[groupID] = true
	s.mu.Unlock()

	name, err := s.api.GetGroupInfo(ctx, groupID)
	if err != nil {
		s.log.Debug("get_group_info failed", "group", groupID, "err", err)
		return
	}
	if name == "" {
		return
	}
	if err := s.st.UpsertGroup(ctx, groupID, name); err != nil {
		s.log.Warn("store group name", "group", groupID, "err", err)
		return
	}
	s.log.Info("group name resolved", "group", groupID, "name", name)
}
