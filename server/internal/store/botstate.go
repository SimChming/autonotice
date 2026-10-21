package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// BotTurn is one persisted line of a chat session. Persisting turns (instead of
// keeping them only in memory) is what lets the robot remember a conversation
// across restarts and process upgrades.
type BotTurn struct {
	ID         int64
	SessionKey string
	Role       string // user | assistant | tool
	SenderQQ   string
	Text       string
	CreatedAt  time.Time
}

// BotSummary is the rolling compression of everything older than the recent
// turn window, so long sessions cost a bounded number of prompt tokens.
type BotSummary struct {
	SessionKey string
	Summary    string
	CoveredID  int64
	UpdatedAt  time.Time
}

// turnCap bounds persisted turns per session.
const turnCap = 120

// AppendTurn persists one turn and trims the session's oldest entries.
func (s *Store) AppendTurn(ctx context.Context, sessionKey, role, senderQQ, text string) (int64, error) {
	text = strings.TrimSpace(text)
	if sessionKey == "" || text == "" {
		return 0, nil
	}
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO bot_turns (session_key, role, sender_qq, text, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		sessionKey, strings.TrimSpace(role), strings.TrimSpace(senderQQ), text, time.Now().Unix())
	if err != nil {
		return 0, fmt.Errorf("append bot turn: %w", err)
	}
	id, _ := res.LastInsertId()
	_, err = s.db.ExecContext(ctx,
		`DELETE FROM bot_turns WHERE session_key = ? AND id NOT IN (
			SELECT id FROM bot_turns WHERE session_key = ? ORDER BY id DESC LIMIT ?
		)`, sessionKey, sessionKey, turnCap)
	if err != nil {
		return id, fmt.Errorf("trim bot turns: %w", err)
	}
	return id, nil
}

// RecentTurns returns the newest turns of a session, oldest first.
func (s *Store) RecentTurns(ctx context.Context, sessionKey string, limit int) ([]BotTurn, error) {
	if sessionKey == "" || limit <= 0 {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, session_key, role, COALESCE(sender_qq, ''), text, created_at
		   FROM bot_turns WHERE session_key = ?
		  ORDER BY id DESC LIMIT ?`, sessionKey, limit)
	if err != nil {
		return nil, fmt.Errorf("recent bot turns: %w", err)
	}
	defer rows.Close()
	var out []BotTurn
	for rows.Next() {
		var t BotTurn
		var created int64
		if err := rows.Scan(&t.ID, &t.SessionKey, &t.Role, &t.SenderQQ, &t.Text, &created); err != nil {
			return nil, err
		}
		t.CreatedAt = time.Unix(created, 0)
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

// TurnsForSummary returns up to limit unsummarized turns after afterID.
func (s *Store) TurnsForSummary(ctx context.Context, sessionKey string, afterID int64, limit int) ([]BotTurn, error) {
	if sessionKey == "" || limit <= 0 {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, session_key, role, COALESCE(sender_qq, ''), text, created_at
		   FROM bot_turns WHERE session_key = ? AND id > ?
		  ORDER BY id ASC LIMIT ?`, sessionKey, afterID, limit)
	if err != nil {
		return nil, fmt.Errorf("turns for summary: %w", err)
	}
	defer rows.Close()
	var out []BotTurn
	for rows.Next() {
		var t BotTurn
		var created int64
		if err := rows.Scan(&t.ID, &t.SessionKey, &t.Role, &t.SenderQQ, &t.Text, &created); err != nil {
			return nil, err
		}
		t.CreatedAt = time.Unix(created, 0)
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetBotSummary returns the rolling summary of a session (empty when none).
func (s *Store) GetBotSummary(ctx context.Context, sessionKey string) (BotSummary, error) {
	var out BotSummary
	var updated int64
	err := s.db.QueryRowContext(ctx,
		`SELECT session_key, summary, covered_turn_id, updated_at FROM bot_summaries WHERE session_key = ?`,
		sessionKey).Scan(&out.SessionKey, &out.Summary, &out.CoveredID, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, fmt.Errorf("get bot summary: %w", err)
	}
	out.UpdatedAt = time.Unix(updated, 0)
	return out, nil
}

// SetBotSummary upserts the rolling summary.
func (s *Store) SetBotSummary(ctx context.Context, sessionKey, summary string, coveredID int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO bot_summaries (session_key, summary, covered_turn_id, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(session_key) DO UPDATE SET
		   summary = excluded.summary,
		   covered_turn_id = excluded.covered_turn_id,
		   updated_at = excluded.updated_at`,
		sessionKey, strings.TrimSpace(summary), coveredID, time.Now().Unix())
	if err != nil {
		return fmt.Errorf("set bot summary: %w", err)
	}
	return nil
}

// --- roles ---

// QQ roles. owner is the master, admin can drive the robot like an owner but may
// not run shell or publish system preferences, member is a normal classmate and
// guest may only chat.
const (
	RoleOwner  = "owner"
	RoleAdmin  = "admin"
	RoleMember = "member"
	RoleGuest  = "guest"
)

// BotRole is one QQ permission row.
type BotRole struct {
	QQ        string    `json:"qq"`
	Role      string    `json:"role"`
	Note      string    `json:"note"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ValidRole reports whether role is one of the four known roles.
func ValidRole(role string) bool {
	switch role {
	case RoleOwner, RoleAdmin, RoleMember, RoleGuest:
		return true
	}
	return false
}

// ListBotRoles returns all configured roles, owners first.
func (s *Store) ListBotRoles(ctx context.Context) ([]BotRole, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT qq, role, COALESCE(note, ''), enabled, created_at, updated_at
		   FROM bot_roles
		  ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list bot roles: %w", err)
	}
	defer rows.Close()
	var out []BotRole
	for rows.Next() {
		var r BotRole
		var enabled, created, updated int64
		if err := rows.Scan(&r.QQ, &r.Role, &r.Note, &enabled, &created, &updated); err != nil {
			return nil, err
		}
		r.Enabled = enabled != 0
		r.CreatedAt = time.Unix(created, 0)
		r.UpdatedAt = time.Unix(updated, 0)
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetBotRole returns one role row.
func (s *Store) GetBotRole(ctx context.Context, qq string) (BotRole, error) {
	var r BotRole
	var enabled, created, updated int64
	err := s.db.QueryRowContext(ctx,
		`SELECT qq, role, COALESCE(note, ''), enabled, created_at, updated_at FROM bot_roles WHERE qq = ?`,
		strings.TrimSpace(qq)).Scan(&r.QQ, &r.Role, &r.Note, &enabled, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrNotFound
	}
	if err != nil {
		return r, fmt.Errorf("get bot role: %w", err)
	}
	r.Enabled = enabled != 0
	r.CreatedAt = time.Unix(created, 0)
	r.UpdatedAt = time.Unix(updated, 0)
	return r, nil
}

// UpsertBotRole creates or updates a role row.
func (s *Store) UpsertBotRole(ctx context.Context, qq, role, note string) error {
	qq = strings.TrimSpace(qq)
	role = strings.TrimSpace(role)
	if qq == "" || !ValidRole(role) {
		return fmt.Errorf("invalid role %q", role)
	}
	now := time.Now().Unix()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO bot_roles (qq, role, note, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, 1, ?, ?)
		 ON CONFLICT(qq) DO UPDATE SET role = excluded.role, note = excluded.note, enabled = 1, updated_at = excluded.updated_at`,
		qq, role, strings.TrimSpace(note), now, now)
	if err != nil {
		return fmt.Errorf("upsert bot role: %w", err)
	}
	return nil
}

// EnsureBotRole inserts a role only when the QQ has no row yet, so a manual
// admin change is never overwritten by startup seeding.
func (s *Store) EnsureBotRole(ctx context.Context, qq, role, note string) error {
	qq = strings.TrimSpace(qq)
	role = strings.TrimSpace(role)
	if qq == "" || !ValidRole(role) {
		return nil
	}
	now := time.Now().Unix()
	_, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO bot_roles (qq, role, note, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, 1, ?, ?)`, qq, role, strings.TrimSpace(note), now, now)
	if err != nil {
		return fmt.Errorf("ensure bot role: %w", err)
	}
	return nil
}

// DeleteBotRole removes a role row.
func (s *Store) DeleteBotRole(ctx context.Context, qq string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM bot_roles WHERE qq = ?`, strings.TrimSpace(qq))
	if err != nil {
		return fmt.Errorf("delete bot role: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// RecallMemories returns long-term fragments relevant to a message. Unlike the
// old session-only LIKE search it also considers this speaker's fragments from
// other chats (private <-> group), which is what makes the robot feel like it
// actually remembers the person.
func (s *Store) RecallMemories(ctx context.Context, sessionKey, senderQQ string, limit int) ([]Memory, error) {
	if limit <= 0 {
		limit = 6
	}
	fetch := 200
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, session_key, sender_qq, tags, content, kind, scope, created_at
		   FROM memories
		  WHERE kind = ? AND (session_key = ? OR (sender_qq <> '' AND sender_qq = ?))
		  ORDER BY created_at DESC, id DESC LIMIT ?`,
		MemoryKindChat, sessionKey, strings.TrimSpace(senderQQ), fetch)
	if err != nil {
		return nil, fmt.Errorf("recall memories: %w", err)
	}
	defer rows.Close()
	var out []Memory
	for rows.Next() {
		var m Memory
		var created int64
		if err := rows.Scan(&m.ID, &m.SessionKey, &m.SenderQQ, &m.Tags, &m.Content, &m.Kind, &m.Scope, &created); err != nil {
			return nil, err
		}
		m.CreatedAt = time.Unix(created, 0).UTC()
		out = append(out, m)
	}
	return out, rows.Err()
}
