// Package admin implements the isolated back-office account system: bootstrap,
// login and scoped JWT issuance.
package admin

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/qqsched/server/internal/auth"
	"github.com/qqsched/server/internal/store"
)

// ErrInvalidCredentials is returned for unknown users or wrong passwords.
var ErrInvalidCredentials = errors.New("admin: invalid credentials")

// Service manages administrator accounts.
type Service struct {
	st  *store.Store
	jwt *auth.Manager
	log *slog.Logger
}

// New builds the admin service.
func New(st *store.Store, jwt *auth.Manager, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{st: st, jwt: jwt, log: log}
}

// EnsureInitial creates the default `admin` account when the table is empty.
// Without ADMIN_PASSWORD it only warns, so a fresh deploy never ends up with a
// blank-password administrator.
func (s *Service) EnsureInitial(ctx context.Context, password string) error {
	n, err := s.st.CountAdmins(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	if password == "" {
		s.log.Warn("no admin account exists and ADMIN_PASSWORD is empty; back-office login is disabled")
		return nil
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	if _, err := s.st.CreateAdmin(ctx, "admin", hash); err != nil {
		return err
	}
	s.log.Info("initial admin account created", "username", "admin")
	return nil
}

// Login verifies credentials and returns an admin-scoped JWT.
func (s *Service) Login(ctx context.Context, username, password string) (string, time.Time, *store.Admin, error) {
	acc, err := s.st.GetAdminByUsername(ctx, username)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", time.Time{}, nil, ErrInvalidCredentials
		}
		return "", time.Time{}, nil, err
	}
	if !auth.VerifyPassword(acc.PasswordHash, password) {
		return "", time.Time{}, nil, ErrInvalidCredentials
	}
	token, expires, err := s.jwt.SignScoped(acc.ID, acc.Username, auth.ScopeAdmin)
	if err != nil {
		return "", time.Time{}, nil, err
	}
	now := time.Now().UTC()
	if err := s.st.TouchAdminLogin(ctx, acc.ID, now); err == nil {
		acc.LastLoginAt = &now
	}
	return token, expires, acc, nil
}

// Get loads an administrator by id (used by /admin/me).
func (s *Service) Get(ctx context.Context, id string) (*store.Admin, error) {
	return s.st.GetAdminByID(ctx, id)
}

// Audit records one administrative write; failures never break the request.
func (s *Service) Audit(ctx context.Context, adminID, action, detail string) {
	if err := s.st.AddAudit(ctx, adminID, action, detail); err != nil {
		s.log.Warn("admin audit write failed", "action", action, "err", err)
	}
}
