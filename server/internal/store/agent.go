package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

// AgentAction is one command emitted by an LLM / the QQ bot for a user's
// Autonotice clients (in-app reminder, vibration alarm, ...). Clients poll the
// pending list and acknowledge after executing it.
type AgentAction struct {
	ID          string          `json:"id"`
	UserID      string          `json:"user_id"`
	UserQQ      string          `json:"user_qq,omitempty"`
	Action      string          `json:"action"`
	Title       string          `json:"title"`
	Body        string          `json:"body"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	Source      string          `json:"source"`
	DueAt       *time.Time      `json:"due_at,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
	DeliveredAt *time.Time      `json:"delivered_at,omitempty"`
	AckedAt     *time.Time      `json:"acked_at,omitempty"`
}

const agentActionCols = `id, user_id, user_qq, action, title, body, payload, source,
	due_at, created_at, delivered_at, acked_at`

// InsertAgentAction appends an action to the user's queue.
func (s *Store) InsertAgentAction(ctx context.Context, a AgentAction) (*AgentAction, error) {
	if a.ID == "" {
		a.ID = uuid.NewString()
	}
	if a.CreatedAt.IsZero() {
		a.CreatedAt = time.Now().UTC()
	}
	if len(a.Payload) == 0 {
		a.Payload = json.RawMessage("{}")
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO agent_actions (`+agentActionCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
		a.ID, a.UserID, a.UserQQ, a.Action, a.Title, a.Body, string(a.Payload), a.Source,
		unixPtr(a.DueAt), a.CreatedAt.Unix())
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// ListPendingAgentActions returns unacknowledged actions for a user, oldest
// first. since (when non-zero) filters by creation time for incremental polls.
func (s *Store) ListPendingAgentActions(ctx context.Context, userID string, since time.Time, limit int) ([]AgentAction, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := `SELECT ` + agentActionCols + ` FROM agent_actions WHERE user_id = ? AND acked_at IS NULL`
	args := []any{userID}
	if !since.IsZero() {
		q += ` AND created_at >= ?`
		args = append(args, since.Unix())
	}
	q += ` ORDER BY created_at ASC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []AgentAction
	for rows.Next() {
		a, err := scanAgentAction(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// AckAgentAction marks an action executed; scoped to its owner.
func (s *Store) AckAgentAction(ctx context.Context, userID, id string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE agent_actions SET acked_at = ?, delivered_at = COALESCE(delivered_at, ?)
		 WHERE id = ? AND user_id = ? AND acked_at IS NULL`,
		time.Now().Unix(), time.Now().Unix(), id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var exists int
		err := s.db.QueryRowContext(ctx,
			`SELECT 1 FROM agent_actions WHERE id = ? AND user_id = ?`, id, userID).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

// MarkAgentActionDelivered flips delivered_at without acknowledging.
func (s *Store) MarkAgentActionDelivered(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE agent_actions SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?`,
		time.Now().Unix(), id)
	return err
}

func scanAgentAction(row rowScanner) (*AgentAction, error) {
	var (
		a        AgentAction
		payload  sql.NullString
		dueAt    sql.NullInt64
		created  sql.NullInt64
		deliv    sql.NullInt64
		acked    sql.NullInt64
	)
	if err := row.Scan(&a.ID, &a.UserID, &a.UserQQ, &a.Action, &a.Title, &a.Body,
		&payload, &a.Source, &dueAt, &created, &deliv, &acked); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if payload.Valid && payload.String != "" {
		a.Payload = json.RawMessage(payload.String)
	}
	a.DueAt = timePtr(dueAt)
	a.CreatedAt = timeVal(created)
	a.DeliveredAt = timePtr(deliv)
	a.AckedAt = timePtr(acked)
	return &a, nil
}
