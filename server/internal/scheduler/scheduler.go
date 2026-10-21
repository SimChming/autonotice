// Package scheduler drives periodic summarization, lightweight incremental
// refreshes and housekeeping via robfig/cron in the configured timezone.
package scheduler

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/robfig/cron/v3"

	"github.com/qqsched/server/internal/config"
	"github.com/qqsched/server/internal/store"
	"github.com/qqsched/server/internal/summarize"
)

// Scheduler owns the cron instance and its jobs.
type Scheduler struct {
	cron             *cron.Cron
	svc              *summarize.Service
	store            *store.Store
	log              *slog.Logger
	loc              *time.Location
	messageRetention time.Duration
}

// New builds the scheduler from the configured cron expressions.
func New(svc *summarize.Service, st *store.Store, cfg config.ScheduleConfig, log *slog.Logger) (*Scheduler, error) {
	if log == nil {
		log = slog.Default()
	}
	loc, err := time.LoadLocation(cfg.Timezone)
	if err != nil {
		log.Warn("invalid timezone, falling back to UTC", "tz", cfg.Timezone, "err", err)
		loc = time.UTC
	}
	s := &Scheduler{
		svc:              svc,
		store:            st,
		log:              log,
		loc:              loc,
		messageRetention: 60 * 24 * time.Hour,
	}
	s.cron = cron.New(
		cron.WithLocation(loc),
		cron.WithChain(cron.Recover(cron.DefaultLogger), cron.SkipIfStillRunning(cron.DefaultLogger)),
	)

	daily := cfg.DailyCron
	if daily == "" {
		daily = "0 7 * * *"
	}
	light := cfg.LightCron
	if light == "" {
		light = "0 */2 * * *"
	}
	cleanup := cfg.CleanupCron
	if cleanup == "" {
		cleanup = "30 23 * * *"
	}

	if _, err := s.cron.AddFunc(daily, func() { s.runIncremental(context.Background(), 168*time.Hour) }); err != nil {
		return nil, err
	}
	if _, err := s.cron.AddFunc(light, func() { s.runIncremental(context.Background(), 4*time.Hour) }); err != nil {
		return nil, err
	}
	if _, err := s.cron.AddFunc(cleanup, func() { s.cleanup(context.Background()) }); err != nil {
		return nil, err
	}
	return s, nil
}

// Location returns the configured timezone.
func (s *Scheduler) Location() *time.Location { return s.loc }

// Start begins the cron loop.
func (s *Scheduler) Start() { s.cron.Start() }

// Stop halts the cron loop and waits for running jobs.
func (s *Scheduler) Stop() {
	ctx := s.cron.Stop()
	select {
	case <-ctx.Done():
	case <-time.After(10 * time.Second):
		s.log.Warn("scheduler stop timed out")
	}
}

// RunIncrementalNow triggers an out-of-band incremental pass (used by the CLI /
// manual trigger endpoint).
func (s *Scheduler) RunIncrementalNow(lookback time.Duration) {
	s.runIncremental(context.Background(), lookback)
}

// runIncremental summarizes every verified binding, each in its own goroutine
// with panic recovery so one bad user never blocks the others.
func (s *Scheduler) runIncremental(ctx context.Context, lookback time.Duration) {
	bindings, err := s.store.ListVerifiedBindings(ctx)
	if err != nil {
		s.log.Error("scheduler: list verified bindings", "err", err)
		return
	}
	s.log.Info("scheduler: incremental run", "users", len(bindings), "lookback", lookback)

	var wg sync.WaitGroup
	for _, b := range bindings {
		b := b
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					s.log.Error("scheduler: user summary panic", "user", b.UserID, "qq", b.QQUID, "panic", r)
				}
			}()
			opts := summarize.RunOptions{
				Now:      time.Now().In(s.loc),
				Lookback: lookback,
			}
			if err := s.svc.RunForBinding(ctx, b, opts); err != nil {
				s.log.Error("scheduler: user summary failed", "user", b.UserID, "qq", b.QQUID, "err", err)
			}
		}()
	}
	wg.Wait()
}

// cleanup prunes old messages, expired bind codes and soft-deleted items.
func (s *Scheduler) cleanup(ctx context.Context) {
	cutoff := time.Now().Add(-s.messageRetention)
	if n, err := s.store.PruneMessagesBefore(ctx, cutoff); err != nil {
		s.log.Error("scheduler: prune messages", "err", err)
	} else if n > 0 {
		s.log.Info("scheduler: pruned messages", "count", n)
	}
	if n, err := s.store.CleanupExpiredBindCodes(ctx); err != nil {
		s.log.Error("scheduler: cleanup bind codes", "err", err)
	} else if n > 0 {
		s.log.Info("scheduler: cleaned bind codes", "count", n)
	}
	if n, err := s.store.PurgeDeletedItems(ctx, time.Now().Add(-30*24*time.Hour)); err != nil {
		s.log.Error("scheduler: purge deleted items", "err", err)
	} else if n > 0 {
		s.log.Info("scheduler: purged deleted items", "count", n)
	}
}
