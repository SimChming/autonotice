package httpapi

import (
	"net/http"
	"sort"
	"strings"

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
