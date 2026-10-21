package httpapi

import (
	"net/http"
	"sort"
	"strings"

	"github.com/google/uuid"

	"github.com/qqsched/server/internal/auth"
	"github.com/qqsched/server/internal/store"
)

func (a *api) listAlerts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := auth.UserIDFromContext(ctx)
	qqs, err := a.userQQs(ctx, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not load bindings")
		return
	}
	seen := map[string]bool{}
	var out []store.Alert
	for _, qq := range qqs {
		alerts, err := a.Store.ListAlertsByUser(ctx, qq, false)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "store_error", "could not load alerts")
			return
		}
		for _, al := range alerts {
			if seen[al.ID] {
				continue
			}
			seen[al.ID] = true
			out = append(out, al)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	if out == nil {
		out = []store.Alert{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"alerts": out})
}

func (a *api) readAlert(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := auth.UserIDFromContext(ctx)
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "invalid_id", "alert id is required")
		return
	}
	qqs, err := a.userQQs(ctx, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not load bindings")
		return
	}
	for _, qq := range qqs {
		if err := a.Store.MarkAlertRead(ctx, qq, id); err == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	writeError(w, http.StatusNotFound, "not_found", "alert not found")
}

func (a *api) pushWS(w http.ResponseWriter, r *http.Request) {
	if a.Hub == nil {
		writeError(w, http.StatusServiceUnavailable, "disabled", "realtime push disabled")
		return
	}
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	a.Hub.ServeWS(w, r, userID)
}

// --- feedback ---

type feedbackBody struct {
	Subject string `json:"subject"`
	Body    string `json:"body"`
	Contact string `json:"contact"`
}

func (a *api) createFeedback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := auth.UserIDFromContext(ctx)

	var body feedbackBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}
	body.Body = strings.TrimSpace(body.Body)
	if body.Body == "" {
		writeError(w, http.StatusBadRequest, "empty", "feedback body is required")
		return
	}
	if len(body.Body) > 5000 {
		body.Body = body.Body[:5000]
	}

	// 找主绑定 QQ 作为 user_qq（可选字段，用于 admin 面板展示）
	var userQQ string
	if userID != "" {
		bindings, err := a.Store.ListVerifiedBindings(ctx)
		if err == nil {
			for _, b := range bindings {
				if b.UserID != userID {
					continue
				}
				userQQ = b.QQUID
				break
			}
			if userQQ == "" && len(bindings) > 0 {
				userQQ = bindings[0].QQUID
			}
		}
	}

	f := store.Feedback{
		ID:      uuid.NewString(),
		UserQQ:  userQQ,
		UserID:  userID,
		Subject: strings.TrimSpace(body.Subject),
		Body:    body.Body,
		Contact: strings.TrimSpace(body.Contact),
	}
	saved, err := a.Store.InsertFeedback(ctx, f)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not save feedback")
		return
	}
	writeJSON(w, http.StatusCreated, saved)
}
