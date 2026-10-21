package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Admin is a back-office account, fully isolated from regular users.
type Admin struct {
	ID           string     `json:"id"`
	Username     string     `json:"username"`
	PasswordHash string     `json:"-"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	LastLoginAt  *time.Time `json:"last_login_at"`
}

// Owner is one QQ identity granted 主人 privileges.
type Owner struct {
	QQ        string    `json:"qq"`
	Note      string    `json:"note"`
	CreatedAt time.Time `json:"created_at"`
}

// AuditEntry records one administrative write.
type AuditEntry struct {
	ID        int64     `json:"id"`
	AdminID   string    `json:"admin_id"`
	Username  string    `json:"username"`
	Action    string    `json:"action"`
	Detail    string    `json:"detail"`
	CreatedAt time.Time `json:"created_at"`
}

// CountAdmins reports how many back-office accounts exist.
func (s *Store) CountAdmins(ctx context.Context) (int, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM admins`).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

// CreateAdmin inserts a back-office account.
func (s *Store) CreateAdmin(ctx context.Context, username, passwordHash string) (*Admin, error) {
	now := time.Now().UTC()
	a := &Admin{
		ID:           uuid.NewString(),
		Username:     username,
		PasswordHash: passwordHash,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO admins (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		a.ID, a.Username, a.PasswordHash, now.Unix(), now.Unix())
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return nil, ErrDuplicateKey
		}
		return nil, err
	}
	return a, nil
}

// GetAdminByUsername loads an admin account by login name.
func (s *Store) GetAdminByUsername(ctx context.Context, username string) (*Admin, error) {
	return scanAdmin(s.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, created_at, updated_at, last_login_at FROM admins WHERE username = ?`,
		username))
}

// GetAdminByID loads an admin account by id.
func (s *Store) GetAdminByID(ctx context.Context, id string) (*Admin, error) {
	return scanAdmin(s.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, created_at, updated_at, last_login_at FROM admins WHERE id = ?`,
		id))
}

// TouchAdminLogin records a successful login time.
func (s *Store) TouchAdminLogin(ctx context.Context, id string, at time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE admins SET last_login_at = ?, updated_at = ? WHERE id = ?`,
		at.Unix(), at.Unix(), id)
	return err
}

func scanAdmin(row rowScanner) (*Admin, error) {
	var (
		a           Admin
		createdAt   sql.NullInt64
		updatedAt   sql.NullInt64
		lastLoginAt sql.NullInt64
	)
	if err := row.Scan(&a.ID, &a.Username, &a.PasswordHash, &createdAt, &updatedAt, &lastLoginAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	a.CreatedAt = timeVal(createdAt)
	a.UpdatedAt = timeVal(updatedAt)
	a.LastLoginAt = timePtr(lastLoginAt)
	return &a, nil
}

// --- settings ---

// LoadSettings returns every persisted runtime setting (key -> raw JSON).
func (s *Store) LoadSettings(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key, value FROM settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// UpsertSetting writes one runtime setting value.
func (s *Store) UpsertSetting(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key, value, time.Now().Unix())
	return err
}

// --- owners ---

// ListOwners returns the extra 主人 QQ identities (the built-in control QQ is not
// stored here).
func (s *Store) ListOwners(ctx context.Context) ([]Owner, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT qq, note, created_at FROM owner_qqs ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Owner
	for rows.Next() {
		var (
			o         Owner
			createdAt sql.NullInt64
		)
		if err := rows.Scan(&o.QQ, &o.Note, &createdAt); err != nil {
			return nil, err
		}
		o.CreatedAt = timeVal(createdAt)
		out = append(out, o)
	}
	return out, rows.Err()
}

// AddOwner inserts an owner QQ.
func (s *Store) AddOwner(ctx context.Context, qq, note string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO owner_qqs (qq, note, created_at) VALUES (?, ?, ?)`,
		qq, note, time.Now().Unix())
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return ErrDuplicateKey
		}
		return err
	}
	return nil
}

// DeleteOwner removes an owner QQ.
func (s *Store) DeleteOwner(ctx context.Context, qq string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM owner_qqs WHERE qq = ?`, qq)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// --- audit ---

// AddAudit appends one administrative action record.
func (s *Store) AddAudit(ctx context.Context, adminID, action, detail string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO admin_audit (admin_id, action, detail, created_at) VALUES (?, ?, ?, ?)`,
		adminID, action, detail, time.Now().Unix())
	return err
}

// ListAudit returns the most recent audit entries (newest first).
func (s *Store) ListAudit(ctx context.Context, limit int) ([]AuditEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT a.id, a.admin_id, COALESCE(ad.username, ''), a.action, a.detail, a.created_at
		 FROM admin_audit a LEFT JOIN admins ad ON ad.id = a.admin_id
		 ORDER BY a.id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("list audit: %w", err)
	}
	defer rows.Close()
	var out []AuditEntry
	for rows.Next() {
		var (
			e         AuditEntry
			createdAt sql.NullInt64
		)
		if err := rows.Scan(&e.ID, &e.AdminID, &e.Username, &e.Action, &e.Detail, &createdAt); err != nil {
			return nil, err
		}
		e.CreatedAt = timeVal(createdAt)
		out = append(out, e)
	}
	return out, rows.Err()
}
