package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/qqsched/server/internal/auth"
	"github.com/qqsched/server/internal/summarize"
)

const (
	defaultReplanLookback = 168 * time.Hour
	maxReplanLookback     = 720 * time.Hour
)

// replanStream runs an immediate AI replan for the current user and relays the
// model's thinking chain back as server-sent events.
func (a *api) replanStream(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "缺少登录凭证")
		return
	}
	if !a.acquireReplan(userID) {
		writeError(w, http.StatusConflict, "replan_busy", "已有排程正在进行中")
		return
	}
	defer a.releaseReplan(userID)

	ctx := r.Context()
	bindings, err := a.Store.ListVerifiedBindingsByUser(ctx, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "读取 QQ 绑定失败")
		return
	}
	if len(bindings) == 0 {
		writeError(w, http.StatusBadRequest, "no_binding", "还没有已验证的 QQ 绑定")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "internal", "服务端不支持流式响应")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	em := &sseEmitter{w: w, f: flusher, ctx: ctx}
	lookback := replanLookback(r)

	targets := make([]map[string]string, 0, len(bindings))
	for _, b := range bindings {
		targets = append(targets, map[string]string{"qq_uid": b.QQUID, "group_id": b.GroupID})
	}
	em.event(map[string]any{
		"type":     "start",
		"bindings": targets,
		"model":    a.Summarizer.Client().ReasoningModel(),
		"lookback": lookback.String(),
	})

	started := time.Now()
	var revision int64
	for _, b := range bindings {
		if ctx.Err() != nil {
			return
		}
		// 默认只处理「上次总结指针之后的」新消息；显式 ?full=1 才整窗重扫。
		opts := summarize.RunOptions{
			Lookback:          lookback,
			MaxMessages:       400,
			IgnoreLastSummary: r.URL.Query().Get("full") == "1",
		}
		res, err := a.Summarizer.RunReplan(ctx, b, opts, em)
		if err != nil {
			if errors.Is(err, summarize.ErrEmitterClosed) || ctx.Err() != nil {
				return
			}
			a.log.Error("replan failed", "user", userID, "qq", b.QQUID, "err", err)
			em.event(map[string]any{"type": "error", "message": err.Error()})
			continue
		}
		revision = res.Revision
		if a.Hub != nil {
			a.Hub.PushScheduleUpdate(userID, res.Revision)
		}
		em.event(map[string]any{
			"type":      "run",
			"qq_uid":    b.QQUID,
			"revision":  res.Revision,
			"new_items": res.NewItems,
			"messages":  res.Messages,
			"skipped":   res.Skipped,
		})
	}
	em.event(map[string]any{
		"type":       "done",
		"revision":   revision,
		"elapsed_ms": time.Since(started).Milliseconds(),
	})
}

// latestReplan returns the most recent thinking chain kept for the user so the
// client can expand it again later.
func (a *api) latestReplan(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "缺少登录凭证")
		return
	}
	rec, err := a.Store.GetLatestReplanRecord(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "读取思考链失败")
		return
	}
	if rec == nil {
		writeJSON(w, http.StatusOK, map[string]any{"reasoning": "", "at": nil})
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

// --- replan concurrency guard (one stream per user) ---

func (a *api) acquireReplan(userID string) bool {
	a.replanMu.Lock()
	defer a.replanMu.Unlock()
	if a.replanActive == nil {
		a.replanActive = map[string]bool{}
	}
	if a.replanActive[userID] {
		return false
	}
	a.replanActive[userID] = true
	return true
}

func (a *api) releaseReplan(userID string) {
	a.replanMu.Lock()
	defer a.replanMu.Unlock()
	delete(a.replanActive, userID)
}

func replanLookback(r *http.Request) time.Duration {
	raw := strings.TrimSpace(r.URL.Query().Get("lookback"))
	if raw == "" {
		return defaultReplanLookback
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return defaultReplanLookback
	}
	if d > maxReplanLookback {
		return maxReplanLookback
	}
	return d
}

// --- SSE emitter ---

type sseEmitter struct {
	w   io.Writer
	f   http.Flusher
	ctx context.Context
}

func (e *sseEmitter) Phase(phase, message string) error {
	return e.event(map[string]any{"type": "phase", "phase": phase, "message": message})
}

func (e *sseEmitter) Delta(kind, text string) error {
	return e.event(map[string]any{"type": kind, "delta": text})
}

func (e *sseEmitter) event(payload map[string]any) error {
	if e.ctx.Err() != nil {
		return summarize.ErrEmitterClosed
	}
	buf, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	frame := append(append([]byte("data: "), buf...), '\n', '\n')
	if _, err := e.w.Write(frame); err != nil {
		return summarize.ErrEmitterClosed
	}
	e.f.Flush()
	return nil
}
