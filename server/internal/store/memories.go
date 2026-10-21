package store

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// memoryCap bounds how many fragments one session may keep; the oldest beyond
// the cap are trimmed on insert so a chatty group cannot grow unbounded.
const memoryCap = 200

// Memory is one long-lived conversational fragment kept for a chat peer.
type Memory struct {
	ID         int64     `json:"id"`
	SessionKey string    `json:"session_key"`
	SenderQQ   string    `json:"sender_qq"`
	Tags       string    `json:"tags"`
	Content    string    `json:"content"`
	CreatedAt  time.Time `json:"created_at"`
}

// InsertMemory persists one fragment and trims the session's oldest entries.
func (s *Store) InsertMemory(ctx context.Context, sessionKey, senderQQ, tags, content string) error {
	content = strings.TrimSpace(content)
	if content == "" {
		return nil
	}
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO memories (session_key, sender_qq, tags, content, created_at) VALUES (?, ?, ?, ?, ?)`,
		sessionKey, strings.TrimSpace(senderQQ), strings.TrimSpace(tags), content, time.Now().Unix()); err != nil {
		return fmt.Errorf("insert memory: %w", err)
	}
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM memories WHERE session_key = ? AND id NOT IN (
			SELECT id FROM memories WHERE session_key = ? ORDER BY id DESC LIMIT ?
		)`, sessionKey, sessionKey, memoryCap); err != nil {
		return fmt.Errorf("trim memories: %w", err)
	}
	return nil
}

// SearchMemories returns up to limit fragments of a session whose content or
// tags contain at least one of terms (most recently created first). Scoring is
// done by the caller; this is a cheap pre-filter.
func (s *Store) SearchMemories(ctx context.Context, sessionKey string, terms []string, limit int) ([]Memory, error) {
	if sessionKey == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 5
	}
	// Fetch a wider candidate window so the in-Go scorer has something to rank.
	fetch := limit * 8
	if fetch > memoryCap {
		fetch = memoryCap
	}

	query := `SELECT id, session_key, sender_qq, tags, content, created_at FROM memories WHERE session_key = ?`
	args := []any{sessionKey}
	if cleaned := cleanTerms(terms); len(cleaned) > 0 {
		clauses := make([]string, 0, len(cleaned)*2)
		for _, t := range cleaned {
			clauses = append(clauses, "content LIKE ?", "tags LIKE ?")
			args = append(args, "%"+t+"%", "%"+t+"%")
		}
		query += " AND (" + strings.Join(clauses, " OR ") + ")"
	}
	query += " ORDER BY created_at DESC, id DESC LIMIT ?"
	args = append(args, fetch)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("search memories: %w", err)
	}
	defer rows.Close()

	var out []Memory
	for rows.Next() {
		var m Memory
		var created int64
		if err := rows.Scan(&m.ID, &m.SessionKey, &m.SenderQQ, &m.Tags, &m.Content, &created); err != nil {
			return nil, err
		}
		m.CreatedAt = time.Unix(created, 0).UTC()
		out = append(out, m)
	}
	return out, rows.Err()
}

// PruneMemories drops fragments older than cutoff; returns the deleted count.
func (s *Store) PruneMemories(ctx context.Context, cutoff time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM memories WHERE created_at < ?`, cutoff.Unix())
	if err != nil {
		return 0, fmt.Errorf("prune memories: %w", err)
	}
	return res.RowsAffected()
}

// cleanTerms trims, lowercases, de-duplicates and caps the search terms so the
// generated SQL keeps a sane number of placeholders.
func cleanTerms(terms []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(terms))
	for _, t := range terms {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
		if len(out) >= 12 {
			break
		}
	}
	return out
}
