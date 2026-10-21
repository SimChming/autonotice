package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/qqsched/server/internal/agent"
	"github.com/qqsched/server/internal/auth"
	"github.com/qqsched/server/internal/store"
)

// agentCatalog lists every action an external LLM can invoke.
func (a *api) agentCatalog(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"service":     "autonotice",
		"description": "Autonotice Agent API：让任意大模型替已登录用户创建提醒、闹钟和日程。",
		"endpoint":    "POST /api/v1/agent/actions",
		"actions":     agent.Catalog(),
	})
}

type agentExecuteRequest struct {
	Action string         `json:"action"`
	Params map[string]any `json:"params"`
}

// agentExecute runs one action for the signed-in account.
func (a *api) agentExecute(w http.ResponseWriter, r *http.Request) {
	if a.Agent == nil {
		writeError(w, http.StatusServiceUnavailable, "agent_disabled", "agent api disabled")
		return
	}
	var body agentExecuteRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}
	ctx := r.Context()
	userID := auth.UserIDFromContext(ctx)
	req := agent.Requester{UserID: userID, IsOwner: a.currentUserIsOwner(ctx)}
	if userID != "" {
		if bindings, err := a.Store.ListVerifiedBindingsByUser(ctx, userID); err == nil && len(bindings) > 0 {
			req.QQ = bindings[0].QQUID
		}
	}

	res, err := a.Agent.Execute(ctx, req, body.Action, body.Params)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// listMyAgentActions returns pending actions for the user's clients.
func (a *api) listMyAgentActions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := auth.UserIDFromContext(ctx)
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	since := parseSince(r.URL.Query().Get("since"))
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	actions, err := a.Store.ListPendingAgentActions(ctx, userID, since, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not load actions")
		return
	}
	if actions == nil {
		actions = []store.AgentAction{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"actions": actions})
}

// ackMyAgentAction marks an action as executed by the client.
func (a *api) ackMyAgentAction(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := auth.UserIDFromContext(ctx)
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "invalid_id", "action id is required")
		return
	}
	if err := a.Store.AckAgentAction(ctx, userID, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "action not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "store_error", "could not acknowledge action")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeAgentError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, agent.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "只能操作自己的 Autonotice 账号；主人可指定目标")
	case errors.Is(err, agent.ErrNotBound):
		writeError(w, http.StatusForbidden, "not_bound", "当前 QQ 尚未绑定 Autonotice 账号")
	case errors.Is(err, agent.ErrTarget):
		writeError(w, http.StatusNotFound, "target_not_found", "目标账号未绑定")
	case errors.Is(err, agent.ErrInvalid):
		writeError(w, http.StatusBadRequest, "invalid_action", err.Error())
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "未找到对应记录")
	default:
		writeError(w, http.StatusInternalServerError, "agent_error", err.Error())
	}
}

// parseSince accepts epoch seconds/ms, RFC3339, or an empty value.
func parseSince(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}
	}
	if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
		if n < 1e12 {
			n *= 1000
		}
		return time.UnixMilli(n).UTC()
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC()
	}
	return time.Time{}
}
