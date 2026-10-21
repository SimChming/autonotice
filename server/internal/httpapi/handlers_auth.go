package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/qqsched/server/internal/auth"
	"github.com/qqsched/server/internal/store"
)

type registerRequest struct {
	Name     string `json:"name"`
	Password string `json:"password"`
}

type userResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type authResponse struct {
	Token string       `json:"token"`
	User  userResponse `json:"user"`
}

func (a *api) register(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if len(req.Name) < 2 || len(req.Name) > 64 {
		writeError(w, http.StatusBadRequest, "invalid_name", "name must be 2-64 characters")
		return
	}
	if len(req.Password) < 6 {
		writeError(w, http.StatusBadRequest, "invalid_password", "password must be at least 6 characters")
		return
	}
	ctx := r.Context()
	if existing, err := a.Store.GetUserByName(ctx, req.Name); err == nil && existing != nil {
		writeError(w, http.StatusConflict, "name_taken", "name already taken")
		return
	} else if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusInternalServerError, "store_error", "could not look up user")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "hash_error", "could not hash password")
		return
	}
	user, err := a.Store.CreateUser(ctx, req.Name, hash)
	if err != nil {
		writeError(w, http.StatusConflict, "create_failed", "could not create user (name may be taken)")
		return
	}
	token, _, err := a.Auth.Sign(user.ID, user.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "sign_error", "could not issue token")
		return
	}
	writeJSON(w, http.StatusOK, authResponse{Token: token, User: userResponse{ID: user.ID, Name: user.Name}})
}

func (a *api) login(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	ctx := r.Context()
	user, err := a.Store.GetUserByName(ctx, req.Name)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "invalid name or password")
		return
	}
	if !auth.VerifyPassword(user.PasswordHash, req.Password) {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "invalid name or password")
		return
	}
	token, _, err := a.Auth.Sign(user.ID, user.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "sign_error", "could not issue token")
		return
	}
	writeJSON(w, http.StatusOK, authResponse{Token: token, User: userResponse{ID: user.ID, Name: user.Name}})
}

// --- bindings ---

type bindInitiateRequest struct {
	QQUID   string `json:"qq_uid"`
	GroupID string `json:"group_id"`
}

type bindInitiateResponse struct {
	Code      string `json:"code"`
	ExpiresAt string `json:"expires_at"`
}

type bindConfirmResponse struct {
	Binding bindingBody `json:"binding"`
}

type bindingBody struct {
	UserID   string `json:"user_id"`
	QQUID    string `json:"qq_uid"`
	GroupID  string `json:"group_id"`
	Verified bool   `json:"verified"`
}

func (a *api) bindInitiate(w http.ResponseWriter, r *http.Request) {
	var req bindInitiateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}
	req.QQUID = strings.TrimSpace(req.QQUID)
	if req.QQUID == "" {
		writeError(w, http.StatusBadRequest, "invalid_qq", "qq_uid is required")
		return
	}
	userID := auth.UserIDFromContext(r.Context())
	code, expiresAt, err := a.Binder.Initiate(r.Context(), userID, req.QQUID, strings.TrimSpace(req.GroupID))
	if err != nil {
		a.log.Error("bind initiate", "err", err)
		writeError(w, http.StatusInternalServerError, "bind_error", "could not create bind code")
		return
	}
	writeJSON(w, http.StatusOK, bindInitiateResponse{
		Code:      code,
		ExpiresAt: expiresAt.Format(time.RFC3339),
	})
}

func (a *api) bindConfirm(w http.ResponseWriter, r *http.Request) {
	var req bindInitiateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}
	req.QQUID = strings.TrimSpace(req.QQUID)
	if req.QQUID == "" {
		writeError(w, http.StatusBadRequest, "invalid_qq", "qq_uid is required")
		return
	}
	userID := auth.UserIDFromContext(r.Context())
	binding, err := a.Binder.Confirm(r.Context(), userID, req.QQUID, strings.TrimSpace(req.GroupID))
	if err != nil {
		a.log.Error("bind confirm", "err", err)
		writeError(w, http.StatusInternalServerError, "bind_error", "could not confirm binding")
		return
	}
	writeJSON(w, http.StatusOK, bindConfirmResponse{Binding: toBindingBody(*binding)})
}

func (a *api) listBindings(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	bindings, err := a.Store.ListBindingsByUser(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not list bindings")
		return
	}
	out := make([]bindingBody, 0, len(bindings))
	for _, b := range bindings {
		out = append(out, toBindingBody(b))
	}
	writeJSON(w, http.StatusOK, map[string]any{"bindings": out})
}

func (a *api) deleteBinding(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	qq := strings.TrimSpace(r.PathValue("qq_uid"))
	if qq == "" {
		writeError(w, http.StatusBadRequest, "invalid_qq", "qq_uid is required")
		return
	}
	if err := a.Store.DeleteBinding(r.Context(), userID, qq); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "binding not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "store_error", "could not delete binding")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func toBindingBody(b store.Binding) bindingBody {
	return bindingBody{UserID: b.UserID, QQUID: b.QQUID, GroupID: b.GroupID, Verified: b.Verified}
}

// userQQs returns all QQ identities bound to a user, verified ones first.
func (a *api) userQQs(ctx context.Context, userID string) ([]string, error) {
	bindings, err := a.Store.ListBindingsByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	var verified, others []string
	seen := map[string]bool{}
	for _, b := range bindings {
		if b.QQUID == "" || seen[b.QQUID] {
			continue
		}
		seen[b.QQUID] = true
		if b.Verified {
			verified = append(verified, b.QQUID)
		} else {
			others = append(others, b.QQUID)
		}
	}
	return append(verified, others...), nil
}

// primaryQQ returns the preferred QQ identity for the schedule document.
func (a *api) primaryQQ(ctx context.Context, userID string) string {
	qqs, err := a.userQQs(ctx, userID)
	if err != nil || len(qqs) == 0 {
		return ""
	}
	return qqs[0]
}
