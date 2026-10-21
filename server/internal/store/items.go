package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/qqsched/server/internal/schedule"
)

const itemCols = `id, user_id, title, type, status, priority, due_at, remind_at, all_day,
	notes, locked_by_user, source_json, revision, created_at, updated_at`

// ListItems returns all live schedule items for a user (deleted rows excluded).
func (s *Store) ListItems(ctx context.Context, userID string) ([]schedule.Item, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+itemCols+` FROM schedule_items WHERE user_id = ? AND deleted = 0 ORDER BY created_at ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanItems(rows)
}

// ItemsChangedSince returns items whose revision is greater than sinceRev.
func (s *Store) ItemsChangedSince(ctx context.Context, userID string, sinceRev int64) ([]schedule.Item, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+itemCols+` FROM schedule_items WHERE user_id = ? AND deleted = 0 AND revision > ? ORDER BY revision ASC`,
		userID, sinceRev)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanItems(rows)
}

// DeletedIDsSince returns ids soft-deleted after sinceRev.
func (s *Store) DeletedIDsSince(ctx context.Context, userID string, sinceRev int64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id FROM schedule_items WHERE user_id = ? AND deleted = 1 AND revision > ? ORDER BY revision ASC`,
		userID, sinceRev)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// GetItem loads a single item by id scoped to a user.
func (s *Store) GetItem(ctx context.Context, userID, id string) (*schedule.Item, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+itemCols+` FROM schedule_items WHERE user_id = ? AND id = ? AND deleted = 0`, userID, id)
	return scanItem(row)
}

// UpsertItem inserts or fully updates an item row keyed by (id, user_id).
func (s *Store) UpsertItem(ctx context.Context, userID string, it schedule.Item) error {
	if it.ID == "" {
		it.ID = uuid.NewString()
	}
	if it.CreatedAt.IsZero() {
		it.CreatedAt = time.Now().UTC()
	}
	if it.UpdatedAt.IsZero() {
		it.UpdatedAt = it.CreatedAt
	}
	src, err := json.Marshal(it.Source)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO schedule_items (`+itemCols+`, deleted)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   title = excluded.title,
		   type = excluded.type,
		   status = excluded.status,
		   priority = excluded.priority,
		   due_at = excluded.due_at,
		   remind_at = excluded.remind_at,
		   all_day = excluded.all_day,
		   notes = excluded.notes,
		   locked_by_user = excluded.locked_by_user,
		   source_json = excluded.source_json,
		   revision = excluded.revision,
		   deleted = 0,
		   updated_at = excluded.updated_at`,
		it.ID, userID, it.Title, it.Type, it.Status, it.Priority, unixPtr(it.DueAt), unixPtr(it.RemindAt),
		boolInt(it.AllDay), it.Notes, boolInt(it.LockedByUser), string(src), it.Revision,
		it.CreatedAt.Unix(), it.UpdatedAt.Unix())
	return err
}

// SoftDeleteItem marks an item deleted at the given revision.
func (s *Store) SoftDeleteItem(ctx context.Context, userID, id string, rev int64) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE schedule_items SET deleted = 1, revision = ?, updated_at = ? WHERE user_id = ? AND id = ? AND deleted = 0`,
		rev, time.Now().Unix(), userID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// PurgeDeletedItems removes soft-deleted rows older than the cutoff.
func (s *Store) PurgeDeletedItems(ctx context.Context, cutoff time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM schedule_items WHERE deleted = 1 AND updated_at < ?`, cutoff.Unix())
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

func scanItems(rows *sql.Rows) ([]schedule.Item, error) {
	var out []schedule.Item
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *it)
	}
	return out, rows.Err()
}

func scanItem(row rowScanner) (*schedule.Item, error) {
	var (
		it         schedule.Item
		userID     string
		dueAt      sql.NullInt64
		remindAt   sql.NullInt64
		allDay     int
		locked     int
		notes      sql.NullString
		sourceJSON sql.NullString
		createdAt  sql.NullInt64
		updatedAt  sql.NullInt64
	)
	if err := row.Scan(&it.ID, &userID, &it.Title, &it.Type, &it.Status, &it.Priority, &dueAt, &remindAt,
		&allDay, &notes, &locked, &sourceJSON, &it.Revision, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	it.DueAt = timePtr(dueAt)
	it.RemindAt = timePtr(remindAt)
	it.AllDay = allDay != 0
	it.LockedByUser = locked != 0
	it.Notes = notes.String
	it.CreatedAt = timeVal(createdAt)
	it.UpdatedAt = timeVal(updatedAt)
	if sourceJSON.Valid && sourceJSON.String != "" {
		_ = json.Unmarshal([]byte(sourceJSON.String), &it.Source)
	}
	return &it, nil
}

// --- user_state (per-user document revision) ---

// GetUserState returns the revision state for a user, creating it lazily.
func (s *Store) GetUserState(ctx context.Context, userID string) (*UserState, error) {
	var (
		st        UserState
		lastSum   sql.NullInt64
		updatedAt sql.NullInt64
		digest    sql.NullString
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT user_id, revision, digest, last_summary_at, updated_at FROM user_state WHERE user_id = ?`, userID).
		Scan(&st.UserID, &st.Revision, &digest, &lastSum, &updatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			now := time.Now().UTC()
			if _, execErr := s.db.ExecContext(ctx,
				`INSERT INTO user_state (user_id, revision, digest, last_summary_at, updated_at) VALUES (?, 0, '', NULL, ?)
				 ON CONFLICT(user_id) DO NOTHING`, userID, now.Unix()); execErr != nil {
				return nil, execErr
			}
			return &UserState{UserID: userID, Revision: 0, UpdatedAt: now}, nil
		}
		return nil, err
	}
	st.Digest = digest.String
	st.LastSummaryAt = timePtr(lastSum)
	st.UpdatedAt = timeVal(updatedAt)
	return &st, nil
}

// BumpRevision increments and returns the user's document revision.
func (s *Store) BumpRevision(ctx context.Context, userID string) (int64, error) {
	now := time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO user_state (user_id, revision, digest, last_summary_at, updated_at) VALUES (?, 0, '', NULL, ?)
		 ON CONFLICT(user_id) DO NOTHING`, userID, now.Unix()); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE user_state SET revision = revision + 1, updated_at = ? WHERE user_id = ?`, now.Unix(), userID); err != nil {
		return 0, err
	}
	var rev int64
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM user_state WHERE user_id = ?`, userID).Scan(&rev); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return rev, nil
}

// SetUserDigest stores the latest document digest for a user.
func (s *Store) SetUserDigest(ctx context.Context, userID, digest string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE user_state SET digest = ?, updated_at = ? WHERE user_id = ?`, digest, time.Now().Unix(), userID)
	return err
}

// SetLastSummaryAt records the timestamp of the most recent successful summary.
func (s *Store) SetLastSummaryAt(ctx context.Context, userID string, at time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE user_state SET last_summary_at = ?, updated_at = ? WHERE user_id = ?`, at.Unix(), at.Unix(), userID)
	return err
}

// --- summary runs ---

// InsertSummaryRun records the start of a summarization attempt.
func (s *Store) InsertSummaryRun(ctx context.Context, run SummaryRun) (*SummaryRun, error) {
	if run.ID == "" {
		run.ID = uuid.NewString()
	}
	if run.StartedAt.IsZero() {
		run.StartedAt = time.Now().UTC()
	}
	if run.Status == "" {
		run.Status = RunRunning
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO summary_runs (id, user_id, qq_uid, group_id, status, started_at, finished_at, message_count, item_count, revision, error)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		run.ID, run.UserID, run.QQUID, run.GroupID, run.Status, run.StartedAt.Unix(), unixPtr(run.FinishedAt),
		run.MessageCount, run.ItemCount, run.Revision, run.Error)
	if err != nil {
		return nil, err
	}
	return &run, nil
}

// FinishSummaryRun updates the outcome of a run.
func (s *Store) FinishSummaryRun(ctx context.Context, id, status string, msgCount, itemCount int, rev int64, errMsg string) error {
	now := time.Now().UTC()
	var errVal any
	if errMsg != "" {
		errVal = errMsg
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE summary_runs SET status = ?, finished_at = ?, message_count = ?, item_count = ?, revision = ?, error = ?
		 WHERE id = ?`,
		status, now.Unix(), msgCount, itemCount, rev, errVal, id)
	return err
}

// SetSummaryRunReasoning stores the thinking chain captured during a manual
// replan so the client can expand it again later.
func (s *Store) SetSummaryRunReasoning(ctx context.Context, id, reasoning, model string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE summary_runs SET reasoning = ?, reasoning_model = ? WHERE id = ?`, reasoning, model, id)
	return err
}

// ReplanRecord is the most recent thinking chain kept for a user.
type ReplanRecord struct {
	RunID     string    `json:"run_id"`
	Reasoning string    `json:"reasoning"`
	Model     string    `json:"model"`
	At        time.Time `json:"at"`
	Revision  int64     `json:"revision"`
	ItemCount int       `json:"item_count"`
}

// GetLatestReplanRecord returns the newest run that carries a thinking chain,
// or (nil, nil) when the user never ran a manual replan.
func (s *Store) GetLatestReplanRecord(ctx context.Context, userID string) (*ReplanRecord, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, reasoning, COALESCE(reasoning_model, ''), COALESCE(finished_at, started_at),
		        COALESCE(revision, 0), COALESCE(item_count, 0)
		   FROM summary_runs
		  WHERE user_id = ? AND reasoning IS NOT NULL AND reasoning <> ''
		  ORDER BY started_at DESC LIMIT 1`, userID)
	var (
		rec ReplanRecord
		at  sql.NullInt64
	)
	if err := row.Scan(&rec.RunID, &rec.Reasoning, &rec.Model, &at, &rec.Revision, &rec.ItemCount); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if at.Valid {
		rec.At = time.Unix(at.Int64, 0).UTC()
	}
	return &rec, nil
}
