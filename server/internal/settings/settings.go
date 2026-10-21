// Package settings holds runtime-tunable configuration persisted in SQLite.
// The current values live in an atomic snapshot so hot paths never touch the DB,
// and changes are pushed to subscribed components immediately.
package settings

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/qqsched/server/internal/store"
)

// DeepSeek holds the hot-swappable model credentials.
type DeepSeek struct {
	APIKey         string `json:"api_key"`
	BaseURL        string `json:"base_url"`
	Model          string `json:"model"`
	EnableThinking *bool  `json:"enable_thinking"`
}

// Capabilities gates OneBot media actions by category.
type Capabilities struct {
	Image   bool `json:"image"`
	Sticker bool `json:"sticker"`
	Voice   bool `json:"voice"`
	Video   bool `json:"video"`
	File    bool `json:"file"`
	Recall  bool `json:"recall"`
	AtAll   bool `json:"at_all"`
}

// AutoSegment controls the delayed self-driven follow-up messages.
type AutoSegment struct {
	Enabled     bool     `json:"enabled"`
	Targets     []string `json:"targets"`
	MinDelayMS  int      `json:"min_delay_ms"`
	MaxDelayMS  int      `json:"max_delay_ms"`
	MaxSegments int      `json:"max_segments"`
	StartIndex  int      `json:"start_index"`
}

// Docs tunes document generation.
type Docs struct {
	QuotaPerDay int `json:"quota_per_day"`
}

// Settings is the full runtime configuration snapshot.
type Settings struct {
	DeepSeek     DeepSeek     `json:"deepseek"`
	Capabilities Capabilities `json:"capabilities"`
	AutoSegment  AutoSegment  `json:"auto_segment"`
	Docs         Docs         `json:"docs"`
	// OwnerQQs is derived from the owner_qqs table and never persisted inside
	// the runtime JSON blob.
	OwnerQQs []string `json:"-"`
}

// DefaultCapabilities enables every media category.
func DefaultCapabilities() Capabilities {
	return Capabilities{
		Image: true, Sticker: true, Voice: true, Video: true,
		File: true, Recall: true, AtAll: true,
	}
}

// DefaultAutoSegment is disabled until an administrator opts in.
func DefaultAutoSegment() AutoSegment {
	return AutoSegment{
		Enabled:     false,
		Targets:     []string{"owner"},
		MinDelayMS:  1500,
		MaxDelayMS:  3500,
		MaxSegments: 3,
		StartIndex:  2,
	}
}

// normalize fills structural defaults and clamps unsafe values.
func (s *Settings) normalize() {
	if s.AutoSegment.Targets == nil {
		s.AutoSegment.Targets = []string{"owner"}
	}
	if s.AutoSegment.MinDelayMS < 0 {
		s.AutoSegment.MinDelayMS = 0
	}
	if s.AutoSegment.MaxDelayMS < s.AutoSegment.MinDelayMS {
		s.AutoSegment.MaxDelayMS = s.AutoSegment.MinDelayMS
	}
	if s.AutoSegment.MinDelayMS == 0 && s.AutoSegment.MaxDelayMS == 0 {
		s.AutoSegment.MinDelayMS = 1500
		s.AutoSegment.MaxDelayMS = 3500
	}
	if s.AutoSegment.MaxSegments <= 0 {
		s.AutoSegment.MaxSegments = 3
	}
	if s.AutoSegment.MaxSegments > 10 {
		s.AutoSegment.MaxSegments = 10
	}
	if s.AutoSegment.StartIndex < 2 {
		s.AutoSegment.StartIndex = 2
	}
	if s.Docs.QuotaPerDay <= 0 {
		s.Docs.QuotaPerDay = 2
	}
	if s.Docs.QuotaPerDay > 20 {
		s.Docs.QuotaPerDay = 20
	}
}

const settingsKey = "runtime"

// Store owns the settings snapshot and its persistence.
type Store struct {
	st  *store.Store
	log *slog.Logger

	mu      sync.Mutex
	subs    []func(*Settings)
	current atomic.Value // *Settings
}

// Load builds the settings store: persisted values override the supplied
// defaults, and the owner list is read from its own table.
func Load(ctx context.Context, st *store.Store, defaults Settings, log *slog.Logger) (*Store, error) {
	if log == nil {
		log = slog.Default()
	}
	defaults.normalize()
	persisted, err := st.LoadSettings(ctx)
	if err != nil {
		return nil, err
	}
	if raw, ok := persisted[settingsKey]; ok && raw != "" {
		if err := json.Unmarshal([]byte(raw), &defaults); err != nil {
			log.Warn("invalid persisted settings, using defaults", "err", err)
		}
	}
	owners, err := st.ListOwners(ctx)
	if err != nil {
		return nil, err
	}
	defaults.OwnerQQs = ownerList(owners)
	defaults.normalize()

	s := &Store{st: st, log: log}
	s.current.Store(&defaults)
	return s, nil
}

// Snapshot returns the current immutable settings snapshot.
func (s *Store) Snapshot() *Settings {
	if v, ok := s.current.Load().(*Settings); ok && v != nil {
		return v
	}
	return &Settings{}
}

// Subscribe registers a callback fired after every successful update.
func (s *Store) Subscribe(fn func(*Settings)) {
	if fn == nil {
		return
	}
	s.mu.Lock()
	s.subs = append(s.subs, fn)
	s.mu.Unlock()
}

// Update merges a partial JSON patch into the current settings, persists the
// result and notifies subscribers.
func (s *Store) Update(ctx context.Context, patch json.RawMessage) (*Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	prev := s.Snapshot()
	next := *prev
	next.OwnerQQs = nil
	if len(patch) > 0 {
		if err := json.Unmarshal(patch, &next); err != nil {
			return nil, err
		}
	}
	// An empty API key means "keep the current secret"; the admin UI never
	// receives the real value, so it cannot echo it back.
	if next.DeepSeek.APIKey == "" {
		next.DeepSeek.APIKey = prev.DeepSeek.APIKey
	}
	next.normalize()

	owners, err := s.st.ListOwners(ctx)
	if err != nil {
		return nil, err
	}
	next.OwnerQQs = ownerList(owners)

	if err := s.persist(ctx, &next); err != nil {
		return nil, err
	}
	s.current.Store(&next)

	subs := append([]func(*Settings){}, s.subs...)
	go func(snap *Settings) {
		for _, fn := range subs {
			fn(snap)
		}
	}(&next)
	return &next, nil
}

// Owners returns the extra owner rows (with notes) for the admin UI.
func (s *Store) Owners(ctx context.Context) ([]store.Owner, error) {
	return s.st.ListOwners(ctx)
}

// AddOwner grants 主人 privileges to another QQ and refreshes the snapshot.
func (s *Store) AddOwner(ctx context.Context, qq, note string) error {
	if err := s.st.AddOwner(ctx, qq, note); err != nil {
		return err
	}
	return s.refreshOwners(ctx)
}

// DeleteOwner revokes an extra owner QQ.
func (s *Store) DeleteOwner(ctx context.Context, qq string) error {
	if err := s.st.DeleteOwner(ctx, qq); err != nil {
		return err
	}
	return s.refreshOwners(ctx)
}

func (s *Store) refreshOwners(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	owners, err := s.st.ListOwners(ctx)
	if err != nil {
		return err
	}
	next := *s.Snapshot()
	next.OwnerQQs = ownerList(owners)
	s.current.Store(&next)
	subs := append([]func(*Settings){}, s.subs...)
	go func(snap *Settings) {
		for _, fn := range subs {
			fn(snap)
		}
	}(&next)
	return nil
}

func (s *Store) persist(ctx context.Context, snap *Settings) error {
	buf, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	return s.st.UpsertSetting(ctx, settingsKey, string(buf))
}

func ownerList(rows []store.Owner) []string {
	out := make([]string, 0, len(rows))
	for _, o := range rows {
		if o.QQ != "" {
			out = append(out, o.QQ)
		}
	}
	return out
}
