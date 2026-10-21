package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// SummaryCursor is the per-(user, group) pointer that tells the summarizer where
// it stopped last time. It pairs a message time with the SQLite rowid so two
// messages sharing the same second are still processed exactly once.
type SummaryCursor struct {
	UserID      string    `json:"user_id"`
	GroupID     string    `json:"group_id"`
	LastMsgTime time.Time `json:"last_msg_time"`
	LastRowID   int64     `json:"last_row_id"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// GetSummaryCursor returns the stored pointer or ErrNotFound when none exists.
func (s *Store) GetSummaryCursor(ctx context.Context, userID, groupID string) (*SummaryCursor, error) {
	var (
		c       SummaryCursor
		msgTime int64
		updated int64
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT user_id, group_id, last_msg_time, last_row_id, updated_at
		   FROM summary_cursors WHERE user_id = ? AND group_id = ?`, userID, groupID).
		Scan(&c.UserID, &c.GroupID, &msgTime, &c.LastRowID, &updated)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get summary cursor: %w", err)
	}
	if msgTime > 0 {
		c.LastMsgTime = time.Unix(msgTime, 0).UTC()
	}
	c.UpdatedAt = time.Unix(updated, 0).UTC()
	return &c, nil
}

// SetSummaryCursor advances the pointer for one (user, group) pair.
func (s *Store) SetSummaryCursor(ctx context.Context, userID, groupID string, at time.Time, lastRowID int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO summary_cursors (user_id, group_id, last_msg_time, last_row_id, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, group_id) DO UPDATE SET
		   last_msg_time = excluded.last_msg_time,
		   last_row_id = excluded.last_row_id,
		   updated_at = excluded.updated_at`,
		userID, groupID, at.Unix(), lastRowID, time.Now().Unix())
	if err != nil {
		return fmt.Errorf("set summary cursor: %w", err)
	}
	return nil
}

// --- babble counters ---

// BabbleCount returns how many unprompted group messages were sent on day.
func (s *Store) BabbleCount(ctx context.Context, day string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT count FROM babble_stats WHERE day = ?`, day).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return n, err
}

// BabbleBump increments the daily counter and returns the new value.
func (s *Store) BabbleBump(ctx context.Context, day string) (int, error) {
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO babble_stats (day, count, updated_at) VALUES (?, 1, ?)
		 ON CONFLICT(day) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
		day, time.Now().Unix()); err != nil {
		return 0, fmt.Errorf("bump babble stats: %w", err)
	}
	return s.BabbleCount(ctx, day)
}
