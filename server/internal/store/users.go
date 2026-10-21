package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Common repository errors.
var (
	ErrNotFound     = errors.New("store: not found")
	ErrConflict     = errors.New("store: conflict")
	ErrCodeInvalid  = errors.New("store: invalid bind code")
	ErrCodeExpired  = errors.New("store: expired bind code")
	ErrCodeReused   = errors.New("store: bind code already used")
	ErrDuplicateKey = errors.New("store: duplicate key")
)

// --- users ---

// CreateUser inserts a new account and returns it.
func (s *Store) CreateUser(ctx context.Context, name, passwordHash string) (*User, error) {
	now := time.Now().UTC()
	u := &User{
		ID:           uuid.NewString(),
		Name:         name,
		PasswordHash: passwordHash,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO users (id, name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		u.ID, u.Name, u.PasswordHash, now.Unix(), now.Unix())
	if err != nil {
		return nil, err
	}
	return u, nil
}

// GetUserByName loads an account by its unique name.
func (s *Store) GetUserByName(ctx context.Context, name string) (*User, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, name, password_hash, created_at, updated_at FROM users WHERE name = ?`, name)
	return scanUser(row)
}

// GetUserByID loads an account by its id.
func (s *Store) GetUserByID(ctx context.Context, id string) (*User, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, name, password_hash, created_at, updated_at FROM users WHERE id = ?`, id)
	return scanUser(row)
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanUser(row rowScanner) (*User, error) {
	var (
		u         User
		createdAt sql.NullInt64
		updatedAt sql.NullInt64
	)
	if err := row.Scan(&u.ID, &u.Name, &u.PasswordHash, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	u.CreatedAt = timeVal(createdAt)
	u.UpdatedAt = timeVal(updatedAt)
	return &u, nil
}

// --- bindings ---

const bindingCols = `id, user_id, qq_uid, group_id, verified, verified_at, created_at, updated_at`

// UpsertBinding inserts or refreshes a binding row (keeps a verified flag if it
// is already set).
func (s *Store) UpsertBinding(ctx context.Context, userID, qqUID, groupID string) (*Binding, error) {
	now := time.Now().UTC()
	existing, err := s.GetBindingByUserQQ(ctx, userID, qqUID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	if existing != nil {
		if groupID != "" && groupID != existing.GroupID {
			if _, err := s.db.ExecContext(ctx,
				`UPDATE bindings SET group_id = ?, updated_at = ? WHERE id = ?`,
				groupID, now.Unix(), existing.ID); err != nil {
				return nil, err
			}
			existing.GroupID = groupID
		}
		return existing, nil
	}
	b := &Binding{
		ID:        uuid.NewString(),
		UserID:    userID,
		QQUID:     qqUID,
		GroupID:   groupID,
		Verified:  false,
		CreatedAt: now,
		UpdatedAt: now,
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO bindings (`+bindingCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		b.ID, b.UserID, b.QQUID, b.GroupID, boolInt(b.Verified), nil, now.Unix(), now.Unix())
	if err != nil {
		return nil, err
	}
	return b, nil
}

// GetBindingByUserQQ loads a single binding for (user, qq).
func (s *Store) GetBindingByUserQQ(ctx context.Context, userID, qqUID string) (*Binding, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+bindingCols+` FROM bindings WHERE user_id = ? AND qq_uid = ?`, userID, qqUID)
	return scanBinding(row)
}

// SetBindingVerified flips the verified flag (and records the verification time).
func (s *Store) SetBindingVerified(ctx context.Context, userID, qqUID string, verified bool, verifiedAt time.Time) error {
	var at any
	if verified {
		at = verifiedAt.Unix()
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE bindings SET verified = ?, verified_at = ?, updated_at = ? WHERE user_id = ? AND qq_uid = ?`,
		boolInt(verified), at, time.Now().Unix(), userID, qqUID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ListBindingsByUser returns all bindings owned by a user.
func (s *Store) ListBindingsByUser(ctx context.Context, userID string) ([]Binding, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+bindingCols+` FROM bindings WHERE user_id = ? ORDER BY created_at ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Binding
	for rows.Next() {
		b, err := scanBinding(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *b)
	}
	return out, rows.Err()
}

// DeleteBinding removes a binding by (user, qq).
func (s *Store) DeleteBinding(ctx context.Context, userID, qqUID string) error {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM bindings WHERE user_id = ? AND qq_uid = ?`, userID, qqUID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ListVerifiedBindings returns every verified binding (used by the scheduler).
func (s *Store) ListVerifiedBindings(ctx context.Context) ([]Binding, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+bindingCols+` FROM bindings WHERE verified = 1 ORDER BY user_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Binding
	for rows.Next() {
		b, err := scanBinding(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *b)
	}
	return out, rows.Err()
}

// ListVerifiedBindingsByUser returns the verified bindings owned by one user
// (used by the manual replan endpoint).
func (s *Store) ListVerifiedBindingsByUser(ctx context.Context, userID string) ([]Binding, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+bindingCols+` FROM bindings WHERE user_id = ? AND verified = 1 ORDER BY created_at ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Binding
	for rows.Next() {
		b, err := scanBinding(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *b)
	}
	return out, rows.Err()
}

// GetVerifiedBindingForQQ returns a verified binding for a QQ identity, if any.
func (s *Store) GetVerifiedBindingForQQ(ctx context.Context, qqUID string) (*Binding, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+bindingCols+` FROM bindings WHERE qq_uid = ? AND verified = 1 LIMIT 1`, qqUID)
	b, err := scanBinding(row)
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	return b, err
}

func scanBinding(row rowScanner) (*Binding, error) {
	var (
		b          Binding
		verified   int
		verifiedAt sql.NullInt64
		createdAt  sql.NullInt64
		updatedAt  sql.NullInt64
	)
	if err := row.Scan(&b.ID, &b.UserID, &b.QQUID, &b.GroupID, &verified, &verifiedAt, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	b.Verified = verified != 0
	b.VerifiedAt = timePtr(verifiedAt)
	b.CreatedAt = timeVal(createdAt)
	b.UpdatedAt = timeVal(updatedAt)
	return &b, nil
}

// --- bind codes ---

// CreateBindCode stores a fresh verification code, replacing any previous
// unused code for the same (user, qq) pair.
func (s *Store) CreateBindCode(ctx context.Context, userID, qqUID, groupID, code string, expiresAt time.Time) error {
	now := time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM bind_codes WHERE user_id = ? AND qq_uid = ? AND used = 0`, userID, qqUID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO bind_codes (code, user_id, qq_uid, group_id, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`,
		code, userID, qqUID, groupID, expiresAt.Unix(), now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

// ConsumeBindCode validates and marks a code as used. The caller is expected to
// have already matched sender == qqUID.
func (s *Store) ConsumeBindCode(ctx context.Context, qqUID, groupID, code string) (*BindCode, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var (
		bc        BindCode
		expiresAt sql.NullInt64
		createdAt sql.NullInt64
		used      int
	)
	err = tx.QueryRowContext(ctx,
		`SELECT code, user_id, qq_uid, group_id, expires_at, used, created_at FROM bind_codes WHERE code = ?`, code).
		Scan(&bc.Code, &bc.UserID, &bc.QQUID, &bc.GroupID, &expiresAt, &used, &createdAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	bc.ExpiresAt = timeVal(expiresAt)
	bc.CreatedAt = timeVal(createdAt)
	bc.Used = used != 0
	if bc.Used {
		return nil, ErrCodeReused
	}
	if time.Now().After(bc.ExpiresAt) {
		return nil, ErrCodeExpired
	}
	if qqUID != "" && bc.QQUID != "" && bc.QQUID != qqUID {
		return nil, ErrCodeInvalid
	}
	if groupID != "" && bc.GroupID != "" && bc.GroupID != groupID {
		return nil, ErrCodeInvalid
	}
	if _, err := tx.ExecContext(ctx, `UPDATE bind_codes SET used = 1 WHERE code = ?`, code); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &bc, nil
}

// CleanupExpiredBindCodes removes used or expired verification codes.
func (s *Store) CleanupExpiredBindCodes(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM bind_codes WHERE used = 1 OR expires_at < ?`, time.Now().Unix())
	if err != nil {
		return 0, fmt.Errorf("cleanup bind codes: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}
