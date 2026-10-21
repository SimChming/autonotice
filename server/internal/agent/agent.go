// Package agent exposes the Autonotice action surface to arbitrary LLMs and to
// the QQ bot. Every action is executed against a single Autonotice account and
// the caller is responsible for having authenticated that account.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/qqsched/server/internal/notify"
	"github.com/qqsched/server/internal/schedule"
	"github.com/qqsched/server/internal/settings"
	"github.com/qqsched/server/internal/store"
)

// Errors surfaced as HTTP 403/400 by the API layer.
var (
	ErrForbidden = errors.New("forbidden")
	ErrNotBound  = errors.New("qq is not bound to an Autonotice account")
	ErrTarget    = errors.New("target account not found")
	ErrInvalid   = errors.New("invalid action or parameters")
)

// Action names.
const (
	ActionWhoAmI        = "account.whoami"
	ActionNotify        = "notify.send"
	ActionAlarm         = "client.alarm"
	ActionScheduleList  = "schedule.list"
	ActionScheduleAdd   = "schedule.create"
	ActionScheduleDel   = "schedule.delete"
	ActionSchedulePatch = "schedule.update"
)

// Requester identifies who is invoking an action.
type Requester struct {
	UserID  string
	QQ      string
	IsOwner bool
}

// Result is a transport-friendly outcome.
type Result struct {
	OK      bool           `json:"ok"`
	Action  string         `json:"action"`
	Message string         `json:"message"`
	Data    map[string]any `json:"data,omitempty"`
}

// Service executes agent actions.
type Service struct {
	store     *store.Store
	hub       *notify.Hub
	settings  *settings.Store
	controlQQ string
	log       *slog.Logger
}

// New builds the action service. hub/settings may be nil.
func New(st *store.Store, hub *notify.Hub, runtime *settings.Store, controlQQ string, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{store: st, hub: hub, settings: runtime, controlQQ: strings.TrimSpace(controlQQ), log: log}
}

// Catalog returns the machine-readable action list (for LLM tool discovery).
func Catalog() []map[string]any {
	return []map[string]any{
		{
			"name":        ActionWhoAmI,
			"description": "返回当前账号 id、绑定的 QQ、是否主人，以及已绑定数量",
			"params":      map[string]any{},
		},
		{
			"name":        ActionNotify,
			"description": "向该账号的 Autonotice 客户端发送一条应用内提醒/系统通知",
			"params": map[string]any{
				"title":   "必填，通知标题",
				"body":    "正文",
				"level":   "info | important | urgent，默认 important",
				"at":      "可选，RFC3339 时间；留空表示立即",
				"vibrate": "可选，true 时同时震动",
				"route":   "可选，点击后跳转的 hash 路由，如 /pages/schedule/index",
				"target_qq":      "可选，仅主人可指定其他已绑定 QQ",
				"target_user_id": "可选，仅主人可指定其他账号 id",
			},
		},
		{
			"name":        ActionAlarm,
			"description": "立即让对方客户端震动/响铃（闹钟），用于叫醒、强提醒",
			"params": map[string]any{
				"title": "标题，默认「⏰ 闹钟」",
				"body":  "正文",
				"mode":  "vibrate | ring | both，默认 both",
				"target_qq":      "可选，仅主人可用",
				"target_user_id": "可选，仅主人可用",
			},
		},
		{
			"name":        ActionScheduleList,
			"description": "列出该账号未完成的日程",
			"params": map[string]any{
				"limit": "返回条数，默认 10，最大 50",
				"target_qq":      "可选，仅主人可用",
				"target_user_id": "可选，仅主人可用",
			},
		},
		{
			"name":        ActionScheduleAdd,
			"description": "为该账号新建一条日程（客户端会自动排本地提醒）",
			"params": map[string]any{
				"title":     "必填",
				"type":      "task | exam | event | payment | other，默认 task",
				"priority":  "low | normal | high | urgent，默认 normal",
				"due_at":    "RFC3339 截止时间",
				"remind_at": "RFC3339 提醒时间",
				"notes":     "备注",
				"all_day":   "是否全天",
				"target_qq":      "可选，仅主人可用",
				"target_user_id": "可选，仅主人可用",
			},
		},
		{
			"name":        ActionSchedulePatch,
			"description": "修改该账号的一条日程（只改传入的字段）",
			"params": map[string]any{
				"id":        "必填，日程 id",
				"title":     "新标题",
				"status":    "pending | done | dismissed",
				"priority":  "low | normal | high | urgent",
				"due_at":    "RFC3339 或 null",
				"remind_at": "RFC3339 或 null",
				"notes":     "备注",
				"target_qq":      "可选，仅主人可用",
				"target_user_id": "可选，仅主人可用",
			},
		},
		{
			"name":        ActionScheduleDel,
			"description": "删除该账号的一条日程",
			"params": map[string]any{
				"id":        "必填，日程 id",
				"target_qq":      "可选，仅主人可用",
				"target_user_id": "可选，仅主人可用",
			},
		},
	}
}

// Execute runs one action for a requester. Authorization: a normal account may
// only touch itself; only the server owner may pass target_qq/target_user_id.
func (s *Service) Execute(ctx context.Context, req Requester, action string, params map[string]any) (Result, error) {
	action = strings.ToLower(strings.TrimSpace(action))
	if params == nil {
		params = map[string]any{}
	}
	if action == "" {
		return Result{}, ErrInvalid
	}
	if s.store == nil {
		return Result{}, errors.New("store not configured")
	}

	targetID, targetQQ, err := s.resolveTarget(ctx, req, params)
	if err != nil {
		return Result{}, err
	}

	switch action {
	case ActionWhoAmI:
		return s.whoami(ctx, req), nil
	case ActionNotify:
		return s.notifySend(ctx, req, targetID, targetQQ, params)
	case ActionAlarm:
		return s.alarm(ctx, req, targetID, targetQQ, params)
	case ActionScheduleList:
		return s.scheduleList(ctx, targetID, params)
	case ActionScheduleAdd:
		return s.scheduleCreate(ctx, req, targetID, params)
	case ActionSchedulePatch:
		return s.schedulePatch(ctx, req, targetID, params)
	case ActionScheduleDel:
		return s.scheduleDelete(ctx, req, targetID, params)
	default:
		return Result{}, fmt.Errorf("%w: unknown action %q", ErrInvalid, action)
	}
}

func (s *Service) whoami(ctx context.Context, req Requester) Result {
	data := map[string]any{
		"user_id":     req.UserID,
		"qq":          req.QQ,
		"is_owner":    req.IsOwner,
		"control_qq":  s.controlQQ,
		"service":     "autonotice",
		"capabilities": []string{ActionNotify, ActionAlarm, ActionScheduleList, ActionScheduleAdd, ActionSchedulePatch, ActionScheduleDel},
	}
	if req.UserID != "" {
		if bindings, err := s.store.ListVerifiedBindingsByUser(ctx, req.UserID); err == nil {
			qqs := make([]string, 0, len(bindings))
			for _, b := range bindings {
				qqs = append(qqs, b.QQUID)
			}
			data["verified_qqs"] = qqs
			data["bound"] = len(qqs) > 0
		}
	} else {
		data["bound"] = false
	}
	return Result{OK: true, Action: ActionWhoAmI, Message: fmt.Sprintf("Autonotice 账号 %s，主人=%v", req.UserID, req.IsOwner), Data: data}
}

func (s *Service) notifySend(ctx context.Context, req Requester, userID, userQQ string, params map[string]any) (Result, error) {
	title := strings.TrimSpace(str(params, "title"))
	if title == "" {
		return Result{}, fmt.Errorf("%w: title is required", ErrInvalid)
	}
	if userID == "" {
		return Result{}, ErrNotBound
	}
	body := strings.TrimSpace(str(params, "body"))
	level := defaultStr(str(params, "level"), "important")
	route := strings.TrimSpace(str(params, "route"))
	vibrate, _ := params["vibrate"].(bool)

	payload, _ := json.Marshal(map[string]any{
		"level":   level,
		"vibrate": vibrate,
		"route":   route,
	})
	act := store.AgentAction{
		ID:        uuid.NewString(),
		UserID:    userID,
		UserQQ:    pick(userQQ, req.QQ),
		Action:    ActionNotify,
		Title:     title,
		Body:      body,
		Payload:   payload,
		Source:    sourceOf(req),
		DueAt:     parseTime(params["at"]),
		CreatedAt: time.Now().UTC(),
	}
	saved, err := s.store.InsertAgentAction(ctx, act)
	if err != nil {
		return Result{}, err
	}
	if s.hub != nil {
		s.hub.PushAgentAction(userID, *saved)
	}
	return Result{
		OK:      true,
		Action:  ActionNotify,
		Message: fmt.Sprintf("已向账号 %s 推送提醒「%s」", userID, title),
		Data:    map[string]any{"action_id": saved.ID, "due_at": saved.DueAt},
	}, nil
}

func (s *Service) alarm(ctx context.Context, req Requester, userID, userQQ string, params map[string]any) (Result, error) {
	if userID == "" {
		return Result{}, ErrNotBound
	}
	title := defaultStr(strings.TrimSpace(str(params, "title")), "⏰ 闹钟")
	body := strings.TrimSpace(str(params, "body"))
	mode := defaultStr(strings.ToLower(strings.TrimSpace(str(params, "mode"))), "both")
	if mode != "vibrate" && mode != "ring" && mode != "both" {
		mode = "both"
	}
	payload, _ := json.Marshal(map[string]any{"mode": mode, "vibrate": mode != "ring", "ring": mode != "vibrate"})
	act := store.AgentAction{
		ID:        uuid.NewString(),
		UserID:    userID,
		UserQQ:    pick(userQQ, req.QQ),
		Action:    ActionAlarm,
		Title:     title,
		Body:      body,
		Payload:   payload,
		Source:    sourceOf(req),
		CreatedAt: time.Now().UTC(),
	}
	saved, err := s.store.InsertAgentAction(ctx, act)
	if err != nil {
		return Result{}, err
	}
	if s.hub != nil {
		s.hub.PushAgentAction(userID, *saved)
	}
	return Result{
		OK:      true,
		Action:  ActionAlarm,
		Message: fmt.Sprintf("已向账号 %s 下发%s闹钟", userID, map[string]string{"vibrate": "震动", "ring": "响铃", "both": "震动+响铃"}[mode]),
		Data:    map[string]any{"action_id": saved.ID, "mode": mode},
	}, nil
}

func (s *Service) scheduleList(ctx context.Context, userID string, params map[string]any) (Result, error) {
	if userID == "" {
		return Result{}, ErrNotBound
	}
	items, err := s.store.ListItems(ctx, userID)
	if err != nil {
		return Result{}, err
	}
	limit := intParam(params, "limit", 10)
	if limit <= 0 || limit > 50 {
		limit = 10
	}
	pending := make([]schedule.Item, 0, len(items))
	for _, it := range items {
		if it.Status == schedule.StatusDone || it.Status == schedule.StatusDismissed {
			continue
		}
		pending = append(pending, it)
	}
	sort.Slice(pending, func(i, j int) bool {
		a, b := pending[i].DueAt, pending[j].DueAt
		if a == nil {
			return false
		}
		if b == nil {
			return true
		}
		return a.Before(*b)
	})
	if len(pending) > limit {
		pending = pending[:limit]
	}
	lines := make([]string, 0, len(pending))
	for _, it := range pending {
		when := "无截止时间"
		if it.DueAt != nil {
			when = it.DueAt.In(time.Local).Format("2006-01-02 15:04")
		}
		lines = append(lines, fmt.Sprintf("- %s（%s，id=%s）", it.Title, when, it.ID))
	}
	msg := "当前没有未完成日程"
	if len(lines) > 0 {
		msg = fmt.Sprintf("共 %d 条未完成日程：\n%s", len(pending), strings.Join(lines, "\n"))
	}
	return Result{OK: true, Action: ActionScheduleList, Message: msg, Data: map[string]any{"items": pending, "count": len(pending)}}, nil
}

func (s *Service) scheduleCreate(ctx context.Context, req Requester, userID string, params map[string]any) (Result, error) {
	if userID == "" {
		return Result{}, ErrNotBound
	}
	title := strings.TrimSpace(str(params, "title"))
	if title == "" {
		return Result{}, fmt.Errorf("%w: title is required", ErrInvalid)
	}
	typ := defaultStr(strings.TrimSpace(str(params, "type")), schedule.TypeTask)
	status := normStatus(str(params, "status"))
	priority := defaultStr(strings.TrimSpace(str(params, "priority")), schedule.PriorityNormal)
	allDay, _ := params["all_day"].(bool)

	rev, err := s.store.BumpRevision(ctx, userID)
	if err != nil {
		return Result{}, err
	}
	now := time.Now().UTC()
	item := schedule.Item{
		ID:           uuid.NewString(),
		Title:        title,
		Type:         typ,
		Status:       status,
		Priority:     priority,
		DueAt:        parseTime(params["due_at"]),
		RemindAt:     parseTime(params["remind_at"]),
		AllDay:       allDay,
		Notes:        strings.TrimSpace(str(params, "notes")),
		LockedByUser: true,
		Revision:     rev,
		Source:       schedule.Source{Kind: "agent:" + sourceOf(req)},
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := s.store.UpsertItem(ctx, userID, item); err != nil {
		return Result{}, err
	}
	if s.hub != nil {
		s.hub.PushScheduleUpdate(userID, rev)
	}
	return Result{
		OK:      true,
		Action:  ActionScheduleAdd,
		Message: fmt.Sprintf("已为账号 %s 创建日程「%s」", userID, title),
		Data:    map[string]any{"item": item, "revision": rev},
	}, nil
}

func (s *Service) schedulePatch(ctx context.Context, req Requester, userID string, params map[string]any) (Result, error) {
	if userID == "" {
		return Result{}, ErrNotBound
	}
	id := strings.TrimSpace(str(params, "id"))
	if id == "" {
		return Result{}, fmt.Errorf("%w: id is required", ErrInvalid)
	}
	item, err := s.store.GetItem(ctx, userID, id)
	if err != nil {
		return Result{}, err
	}
	if v := strings.TrimSpace(str(params, "title")); v != "" {
		item.Title = v
	}
	if v := strings.TrimSpace(str(params, "status")); v != "" {
		item.Status = normStatus(v)
	}
	if v := strings.TrimSpace(str(params, "priority")); v != "" {
		item.Priority = v
	}
	if v := strings.TrimSpace(str(params, "notes")); v != "" {
		item.Notes = v
	}
	if _, ok := params["due_at"]; ok {
		item.DueAt = parseTime(params["due_at"])
	}
	if _, ok := params["remind_at"]; ok {
		item.RemindAt = parseTime(params["remind_at"])
	}
	if v, ok := params["all_day"].(bool); ok {
		item.AllDay = v
	}
	rev, err := s.store.BumpRevision(ctx, userID)
	if err != nil {
		return Result{}, err
	}
	item.LockedByUser = true
	item.Revision = rev
	item.UpdatedAt = time.Now().UTC()
	if err := s.store.UpsertItem(ctx, userID, *item); err != nil {
		return Result{}, err
	}
	if s.hub != nil {
		s.hub.PushScheduleUpdate(userID, rev)
	}
	return Result{
		OK:      true,
		Action:  ActionSchedulePatch,
		Message: fmt.Sprintf("已更新日程「%s」", item.Title),
		Data:    map[string]any{"item": item, "revision": rev},
	}, nil
}

func (s *Service) scheduleDelete(ctx context.Context, req Requester, userID string, params map[string]any) (Result, error) {
	if userID == "" {
		return Result{}, ErrNotBound
	}
	id := strings.TrimSpace(str(params, "id"))
	if id == "" {
		return Result{}, fmt.Errorf("%w: id is required", ErrInvalid)
	}
	item, err := s.store.GetItem(ctx, userID, id)
	if err != nil {
		return Result{}, err
	}
	rev, err := s.store.BumpRevision(ctx, userID)
	if err != nil {
		return Result{}, err
	}
	if err := s.store.SoftDeleteItem(ctx, userID, id, rev); err != nil {
		return Result{}, err
	}
	if s.hub != nil {
		s.hub.PushScheduleUpdate(userID, rev)
	}
	return Result{
		OK:      true,
		Action:  ActionScheduleDel,
		Message: fmt.Sprintf("已删除日程「%s」", item.Title),
		Data:    map[string]any{"id": id, "revision": rev},
	}, nil
}

// resolveTarget determines which account an action applies to. Only the owner
// may address someone else.
func (s *Service) resolveTarget(ctx context.Context, req Requester, params map[string]any) (userID, qq string, err error) {
	wantUser := strings.TrimSpace(str(params, "target_user_id"))
	wantQQ := strings.TrimSpace(str(params, "target_qq"))
	if wantUser == "" && wantQQ == "" {
		return req.UserID, req.QQ, nil
	}
	if !req.IsOwner {
		return "", "", ErrForbidden
	}
	if wantQQ != "" {
		b, err := s.store.GetVerifiedBindingForQQ(ctx, wantQQ)
		if err != nil {
			return "", "", err
		}
		if b == nil {
			return "", "", ErrTarget
		}
		return b.UserID, wantQQ, nil
	}
	return wantUser, "", nil
}

func sourceOf(req Requester) string {
	if req.QQ != "" {
		return "qq"
	}
	return "api"
}

func str(m map[string]any, key string) string {
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	default:
		return fmt.Sprint(v)
	}
}

func defaultStr(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

// normStatus maps the various synonyms an LLM may send onto the server's
// canonical item status values.
func normStatus(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case schedule.StatusDone, "completed", "finished":
		return schedule.StatusDone
	case schedule.StatusDismissed, "ignored", "cancelled", "canceled":
		return schedule.StatusDismissed
	default:
		return schedule.StatusPending
	}
}

func intParam(m map[string]any, key string, fallback int) int {
	switch v := m[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return fallback
}

// parseTime accepts RFC3339 strings or epoch milliseconds/seconds.
func parseTime(v any) *time.Time {
	switch t := v.(type) {
	case nil:
		return nil
	case string:
		t = strings.TrimSpace(t)
		if t == "" {
			return nil
		}
		if parsed, err := time.Parse(time.RFC3339, t); err == nil {
			u := parsed.UTC()
			return &u
		}
		if n, err := strconv.ParseInt(t, 10, 64); err == nil {
			return epochPtr(n)
		}
	case float64:
		return epochPtr(int64(t))
	case json.Number:
		if n, err := t.Int64(); err == nil {
			return epochPtr(n)
		}
	}
	return nil
}

func epochPtr(n int64) *time.Time {
	if n <= 0 {
		return nil
	}
	if n < 1e12 {
		n *= 1000
	}
	t := time.UnixMilli(n).UTC()
	return &t
}

func pick(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
