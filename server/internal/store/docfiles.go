package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
)

// DocFile is one generated document (xlsx/docx/pdf) with its local path.
type DocFile struct {
	ID        string    `json:"id"`
	UserQQ    string    `json:"user_qq"`
	ChatKey   string    `json:"chat_key"`
	Filename  string    `json:"filename"`
	Type      string    `json:"type"`
	Path      string    `json:"-"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
}

// DocDraft is the multi-turn slot state for a document being collected.
type DocDraft struct {
	ChatKey   string    `json:"chat_key"`
	Type      string    `json:"type"`
	SlotJSON  string    `json:"slot_json"`
	UpdatedAt time.Time `json:"updated_at"`
}

// CreateDocFile records a generated document.
func (s *Store) CreateDocFile(ctx context.Context, f *DocFile) error {
	if f.ID == "" {
		f.ID = uuid.NewString()
	}
	if f.CreatedAt.IsZero() {
		f.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO doc_files (id, user_qq, chat_key, filename, type, path, size_bytes, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		f.ID, f.UserQQ, f.ChatKey, f.Filename, f.Type, f.Path, f.SizeBytes, f.CreatedAt.Unix())
	return err
}

// GetDocFile loads one generated document by id.
func (s *Store) GetDocFile(ctx context.Context, id string) (*DocFile, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, user_qq, chat_key, filename, type, path, size_bytes, created_at FROM doc_files WHERE id = ?`, id)
	return scanDocFile(row)
}

// ListDocFiles returns the most recently generated documents.
func (s *Store) ListDocFiles(ctx context.Context, limit int) ([]DocFile, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_qq, chat_key, filename, type, path, size_bytes, created_at
		 FROM doc_files ORDER BY created_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DocFile
	for rows.Next() {
		f, err := scanDocFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *f)
	}
	return out, rows.Err()
}

// CountDocFilesSince counts documents produced by a QQ since the given time.
func (s *Store) CountDocFilesSince(ctx context.Context, userQQ string, since time.Time) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM doc_files WHERE user_qq = ? AND created_at >= ?`, userQQ, since.Unix()).Scan(&n)
	return n, err
}

// CountDocFilesSinceAll counts documents produced by everyone since the given time.
func (s *Store) CountDocFilesSinceAll(ctx context.Context, since time.Time) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM doc_files WHERE created_at >= ?`, since.Unix()).Scan(&n)
	return n, err
}

func scanDocFile(row rowScanner) (*DocFile, error) {
	var (
		f         DocFile
		createdAt sql.NullInt64
	)
	if err := row.Scan(&f.ID, &f.UserQQ, &f.ChatKey, &f.Filename, &f.Type, &f.Path, &f.SizeBytes, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	f.CreatedAt = timeVal(createdAt)
	return &f, nil
}

// SaveDocDraft upserts the per-chat document slot state.
func (s *Store) SaveDocDraft(ctx context.Context, chatKey, typ, slotJSON string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO doc_drafts (chat_key, type, slot_json, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(chat_key) DO UPDATE SET type = excluded.type, slot_json = excluded.slot_json, updated_at = excluded.updated_at`,
		chatKey, typ, slotJSON, time.Now().Unix())
	return err
}

// GetDocDraft returns the draft for a chat, or nil when absent.
func (s *Store) GetDocDraft(ctx context.Context, chatKey string) (*DocDraft, error) {
	var (
		d         DocDraft
		updatedAt sql.NullInt64
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT chat_key, type, slot_json, updated_at FROM doc_drafts WHERE chat_key = ?`, chatKey).
		Scan(&d.ChatKey, &d.Type, &d.SlotJSON, &updatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	d.UpdatedAt = timeVal(updatedAt)
	return &d, nil
}

// ClearDocDraft removes the draft for a chat.
func (s *Store) ClearDocDraft(ctx context.Context, chatKey string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM doc_drafts WHERE chat_key = ?`, chatKey)
	return err
}
