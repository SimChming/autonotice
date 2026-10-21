// Package auth issues and validates JWTs and manages the QQ binding codes.
package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type contextKey string

const userContextKey contextKey = "qqsched.auth.user"

// Claims is the JWT payload.
type Claims struct {
	UserID string `json:"uid"`
	Name   string `json:"name"`
	// Scope separates back-office tokens from regular user tokens.
	Scope string `json:"scope,omitempty"`
	jwt.RegisteredClaims
}

// Token scopes.
const (
	ScopeUser  = "user"
	ScopeAdmin = "admin"
)

// Manager signs and parses tokens with HS256.
type Manager struct {
	secret []byte
	ttl    time.Duration
}

// NewManager builds a JWT manager.
func NewManager(secret string, ttl time.Duration) *Manager {
	if ttl <= 0 {
		ttl = 720 * time.Hour
	}
	return &Manager{secret: []byte(secret), ttl: ttl}
}

// TTL returns the configured token lifetime.
func (m *Manager) TTL() time.Duration { return m.ttl }

// Sign issues a token for a user.
func (m *Manager) Sign(userID, name string) (string, time.Time, error) {
	return m.SignScoped(userID, name, ScopeUser)
}

// SignScoped issues a token carrying an explicit scope (user / admin).
func (m *Manager) SignScoped(userID, name, scope string) (string, time.Time, error) {
	expires := time.Now().Add(m.ttl)
	claims := Claims{
		UserID: userID,
		Name:   name,
		Scope:  scope,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(expires),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(m.secret)
	if err != nil {
		return "", time.Time{}, err
	}
	return signed, expires, nil
}

// Parse validates a token and returns its claims.
func (m *Manager) Parse(raw string) (*Claims, error) {
	claims := &Claims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("auth: unexpected signing method")
		}
		return m.secret, nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		return nil, err
	}
	if !token.Valid {
		return nil, errors.New("auth: invalid token")
	}
	return claims, nil
}

// Middleware rejects requests without a valid bearer token.
func (m *Manager) Middleware(next http.Handler) http.Handler {
	return m.middleware("", next)
}

// MiddlewareScope accepts only tokens signed for the given scope. Regular user
// routes use Middleware (legacy tokens without a scope still pass); the admin
// surface uses this so a user token can never reach it.
func (m *Manager) MiddlewareScope(scope string, next http.Handler) http.Handler {
	return m.middleware(scope, next)
}

func (m *Manager) middleware(scope string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := TokenFromRequest(r)
		if token == "" {
			http.Error(w, `{"error":"missing token"}`, http.StatusUnauthorized)
			return
		}
		claims, err := m.Parse(token)
		if err != nil {
			http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
			return
		}
		if scope != "" {
			if claims.Scope != scope {
				http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
				return
			}
		} else if claims.Scope == ScopeAdmin {
			// Back-office tokens must never satisfy regular user routes.
			http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
			return
		}
		ctx := context.WithValue(r.Context(), userContextKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// TokenFromRequest extracts a token from the Authorization header or the
// `token` / `access_token` query parameter (the latter is used by the WS client).
func TokenFromRequest(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if strings.HasPrefix(h, "Bearer ") {
			return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
		}
		return strings.TrimSpace(h)
	}
	if v := r.URL.Query().Get("token"); v != "" {
		return v
	}
	return r.URL.Query().Get("access_token")
}

// ClaimsFromContext returns the authenticated claims.
func ClaimsFromContext(ctx context.Context) (*Claims, bool) {
	c, ok := ctx.Value(userContextKey).(*Claims)
	return c, ok
}

// UserIDFromContext returns the authenticated user id, or "".
func UserIDFromContext(ctx context.Context) string {
	if c, ok := ClaimsFromContext(ctx); ok {
		return c.UserID
	}
	return ""
}
