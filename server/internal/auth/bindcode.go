package auth

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"time"

	"github.com/qqsched/server/internal/store"
)

// BindService implements the QQ binding code workflow, including the in-group
// "#bind <code>" verification loop.
type BindService struct {
	store   *store.Store
	ttl     time.Duration
	codeLen int
	log     *slog.Logger
}

// NewBindService builds the binding service.
func NewBindService(st *store.Store, ttl time.Duration, codeLen int, log *slog.Logger) *BindService {
	if log == nil {
		log = slog.Default()
	}
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	if codeLen < 4 {
		codeLen = 6
	}
	return &BindService{store: st, ttl: ttl, codeLen: codeLen, log: log}
}

// Initiate generates a verification code for a (user, qq, group) triple.
func (b *BindService) Initiate(ctx context.Context, userID, qqUID, groupID string) (string, time.Time, error) {
	if qqUID == "" {
		return "", time.Time{}, errors.New("auth: qq_uid is required")
	}
	code, err := randomDigits(b.codeLen)
	if err != nil {
		return "", time.Time{}, err
	}
	expiresAt := time.Now().Add(b.ttl).UTC()
	if err := b.store.CreateBindCode(ctx, userID, qqUID, groupID, code, expiresAt); err != nil {
		return "", time.Time{}, fmt.Errorf("auth: create bind code: %w", err)
	}
	// Make sure the (unverified) binding row exists so the client can poll it.
	if _, err := b.store.UpsertBinding(ctx, userID, qqUID, groupID); err != nil {
		return "", time.Time{}, fmt.Errorf("auth: upsert binding: %w", err)
	}
	return code, expiresAt, nil
}

// Confirm returns the current binding state for a (user, qq, group) triple. It
// is the polling counterpart of Initiate.
func (b *BindService) Confirm(ctx context.Context, userID, qqUID, groupID string) (*store.Binding, error) {
	binding, err := b.store.UpsertBinding(ctx, userID, qqUID, groupID)
	if err != nil {
		return nil, fmt.Errorf("auth: upsert binding: %w", err)
	}
	return binding, nil
}

// VerifyGroupBindCode implements ingest.BindVerifier: it matches the code sent
// in a group against the pending code for that sender's QQ identity.
func (b *BindService) VerifyGroupBindCode(ctx context.Context, senderQQ, groupID, code string) (bool, error) {
	bc, err := b.store.ConsumeBindCode(ctx, senderQQ, groupID, code)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrNotFound):
			b.log.Debug("bind code not found", "qq", senderQQ, "code", code)
			return false, nil
		case errors.Is(err, store.ErrCodeReused), errors.Is(err, store.ErrCodeExpired), errors.Is(err, store.ErrCodeInvalid):
			b.log.Debug("bind code rejected", "qq", senderQQ, "reason", err)
			return false, nil
		default:
			return false, err
		}
	}
	if _, err := b.store.UpsertBinding(ctx, bc.UserID, senderQQ, groupID); err != nil {
		return false, err
	}
	if err := b.store.SetBindingVerified(ctx, bc.UserID, senderQQ, true, time.Now().UTC()); err != nil {
		return false, err
	}
	return true, nil
}

func randomDigits(n int) (string, error) {
	max := big.NewInt(10)
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		v, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		out[i] = byte('0' + v.Int64())
	}
	return string(out), nil
}
