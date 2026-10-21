package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/qqsched/server/internal/admin"
	"github.com/qqsched/server/internal/auth"
	"github.com/qqsched/server/internal/settings"
	"github.com/qqsched/server/internal/store"
)

// adminSecure wraps a handler with admin-scoped JWT authentication.
func (a *api) adminSecure(h http.Handler) http.Handler {
	return a.Auth.MiddlewareScope(auth.ScopeAdmin, h)
}

// --- owner access ---

// myPrivileges tells the client whether the signed-in account belongs to the
// server owner (a verified QQ binding to the control QQ or an extra owner QQ).
func (a *api) myPrivileges(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"is_owner":   a.currentUserIsOwner(r.Context()),
		"control_qq": a.ControlQQ,
	})
}

// adminOwnerSSO issues an admin-scoped token for the master without asking for
// the back-office password again: ownership is proven by a verified QQ binding.
func (a *api) adminOwnerSSO(w http.ResponseWriter, r *http.Request) {
	if a.Admin == nil {
		writeError(w, http.StatusServiceUnavailable, "admin_disabled", "后台未初始化")
		return
	}
	if !a.currentUserIsOwner(r.Context()) {
		writeError(w, http.StatusForbidden, "not_owner", "仅主人可进入后台")
		return
	}
	token, expires, acc, err := a.Admin.OwnerToken(r.Context())
	if err != nil {
		a.log.Error("admin owner sso", "err", err)
		writeError(w, http.StatusInternalServerError, "login_error", "登录失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":      token,
		"expires_at": expires.Format(time.RFC3339),
		"admin":      toAdminBody(acc),
	})
}

// currentUserIsOwner checks the JWT subject's verified bindings against the
// control QQ and the extra owner list.
func (a *api) currentUserIsOwner(ctx context.Context) bool {
	userID := auth.UserIDFromContext(ctx)
	if userID == "" || a.Store == nil {
		return false
	}
	bindings, err := a.Store.ListBindingsByUser(ctx, userID)
	if err != nil {
		return false
	}
	for _, b := range bindings {
		if b.Verified && a.isOwnerQQ(ctx, b.QQUID) {
			return true
		}
	}
	return false
}

func (a *api) isOwnerQQ(ctx context.Context, qq string) bool {
	qq = strings.TrimSpace(qq)
	if qq == "" {
		return false
	}
	if qq == a.ControlQQ {
		return true
	}
	// The back-office role table is the authoritative owner list now; the legacy
	// settings list stays as a fallback so nobody loses access after the upgrade.
	if a.Store != nil {
		if r, err := a.Store.GetBotRole(ctx, qq); err == nil && r.Enabled && r.Role == store.RoleOwner {
			return true
		}
	}
	if a.Settings != nil {
		for _, o := range a.Settings.Snapshot().OwnerQQs {
			if o == qq {
				return true
			}
		}
	}
	return false
}

// --- login / identity ---

type adminLoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type adminBody struct {
	ID          string     `json:"id"`
	Username    string     `json:"username"`
	LastLoginAt *time.Time `json:"last_login_at"`
}

func toAdminBody(acc *store.Admin) adminBody {
	if acc == nil {
		return adminBody{}
	}
	return adminBody{ID: acc.ID, Username: acc.Username, LastLoginAt: acc.LastLoginAt}
}

func (a *api) adminLogin(w http.ResponseWriter, r *http.Request) {
	if a.Admin == nil {
		writeError(w, http.StatusServiceUnavailable, "admin_disabled", "后台未初始化")
		return
	}
	var req adminLoginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}
	token, expires, acc, err := a.Admin.Login(r.Context(), strings.TrimSpace(req.Username), req.Password)
	if err != nil {
		if errors.Is(err, admin.ErrInvalidCredentials) {
			writeError(w, http.StatusUnauthorized, "invalid_credentials", "用户名或密码错误")
			return
		}
		a.log.Error("admin login", "err", err)
		writeError(w, http.StatusInternalServerError, "login_error", "登录失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":      token,
		"expires_at": expires.Format(time.RFC3339),
		"admin":      toAdminBody(acc),
	})
}

func (a *api) adminMe(w http.ResponseWriter, r *http.Request) {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok || a.Admin == nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "未登录")
		return
	}
	acc, err := a.Admin.Get(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "管理员不存在")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"admin": toAdminBody(acc)})
}

// --- settings ---

func (a *api) adminGetSettings(w http.ResponseWriter, r *http.Request) {
	if a.Settings == nil {
		writeError(w, http.StatusServiceUnavailable, "settings_unavailable", "设置未初始化")
		return
	}
	writeJSON(w, http.StatusOK, a.adminSettingsView(a.Settings.Snapshot()))
}

func (a *api) adminPutSettings(w http.ResponseWriter, r *http.Request) {
	if a.Settings == nil {
		writeError(w, http.StatusServiceUnavailable, "settings_unavailable", "设置未初始化")
		return
	}
	var body map[string]any
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}
	// The UI only ever sees a masked key; drop it so "keep current" wins.
	if ds, ok := body["deepseek"].(map[string]any); ok {
		if key, ok := ds["api_key"].(string); ok && strings.Contains(key, "*") {
			delete(ds, "api_key")
		}
	}
	raw, err := json.Marshal(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid settings")
		return
	}
	snap, err := a.Settings.Update(r.Context(), raw)
	if err != nil {
		a.log.Error("admin update settings", "err", err)
		writeError(w, http.StatusInternalServerError, "update_failed", "保存失败")
		return
	}
	a.audit(r, "settings.update", strings.Join(sortedKeys(body), ","))
	writeJSON(w, http.StatusOK, a.adminSettingsView(snap))
}

func (a *api) adminTestLLM(w http.ResponseWriter, r *http.Request) {
	if a.LLM == nil {
		writeError(w, http.StatusServiceUnavailable, "llm_unavailable", "模型客户端未初始化")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	reply, err := a.LLM.Ping(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, "llm_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"model":  a.LLM.Model(),
		"reply":  reply,
		"tested": time.Now().UTC().Format(time.RFC3339),
	})
}

func (a *api) adminSettingsView(snap *settings.Settings) map[string]any {
	if snap == nil {
		snap = &settings.Settings{}
	}
	docsEnabled := a.Docs != nil
	var (
		pdfReady bool
	)
	if a.Docs != nil {
		pdfReady = a.Docs.PDFFontReady()
	}
	return map[string]any{
		"deepseek": map[string]any{
			"api_key":         maskSecret(snap.DeepSeek.APIKey),
			"api_key_set":     snap.DeepSeek.APIKey != "",
			"base_url":        snap.DeepSeek.BaseURL,
			"model":           snap.DeepSeek.Model,
			"enable_thinking": snap.DeepSeek.EnableThinking,
		},
		"capabilities":   snap.Capabilities,
		"auto_segment":   snap.AutoSegment,
		"docs":           snap.Docs,
		"babble":         snap.Babble,
		"control_qq":     a.ControlQQ,
		"owners":         snap.OwnerQQs,
		"pdf_font_ready": pdfReady,
		"docs_enabled":   docsEnabled,
	}
}

// --- QQ users / roles ---

func (a *api) adminListBotUsers(w http.ResponseWriter, r *http.Request) {
	if a.Store == nil {
		writeError(w, http.StatusServiceUnavailable, "store_unavailable", "数据库未初始化")
		return
	}
	rows, err := a.Store.ListBotRoles(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "读取用户列表失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"control_qq": a.ControlQQ,
		"users":      rows,
		"roles":      []string{store.RoleOwner, store.RoleAdmin, store.RoleMember, store.RoleGuest},
	})
}

func (a *api) adminUpsertBotUser(w http.ResponseWriter, r *http.Request) {
	if a.Store == nil {
		writeError(w, http.StatusServiceUnavailable, "store_unavailable", "数据库未初始化")
		return
	}
	var req struct {
		QQ   string `json:"qq"`
		Role string `json:"role"`
		Note string `json:"note"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}
	req.QQ = strings.TrimSpace(req.QQ)
	req.Role = strings.TrimSpace(req.Role)
	if !isDigits(req.QQ) {
		writeError(w, http.StatusBadRequest, "invalid_qq", "QQ 号必须是数字")
		return
	}
	if !store.ValidRole(req.Role) {
		writeError(w, http.StatusBadRequest, "invalid_role", "角色必须是 owner/admin/member/guest")
		return
	}
	if req.QQ == a.ControlQQ && req.Role != store.RoleOwner {
		writeError(w, http.StatusConflict, "builtin_owner", "内置主人不能被降级")
		return
	}
	if err := a.Store.UpsertBotRole(r.Context(), req.QQ, req.Role, strings.TrimSpace(req.Note)); err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "保存失败")
		return
	}
	a.audit(r, "bot_users.upsert", req.QQ+":"+req.Role)
	a.adminListBotUsers(w, r)
}

func (a *api) adminDeleteBotUser(w http.ResponseWriter, r *http.Request) {
	if a.Store == nil {
		writeError(w, http.StatusServiceUnavailable, "store_unavailable", "数据库未初始化")
		return
	}
	qq := strings.TrimSpace(r.PathValue("qq"))
	if qq == "" {
		writeError(w, http.StatusBadRequest, "invalid_qq", "缺少 QQ 号")
		return
	}
	if qq == a.ControlQQ {
		writeError(w, http.StatusConflict, "builtin_owner", "内置主人不能被删除")
		return
	}
	if err := a.Store.DeleteBotRole(r.Context(), qq); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "该 QQ 不在用户列表中")
			return
		}
		writeError(w, http.StatusInternalServerError, "store_error", "删除失败")
		return
	}
	a.audit(r, "bot_users.delete", qq)
	a.adminListBotUsers(w, r)
}

// --- owners ---

func (a *api) adminListOwners(w http.ResponseWriter, r *http.Request) {
	if a.Settings == nil {
		writeError(w, http.StatusServiceUnavailable, "settings_unavailable", "设置未初始化")
		return
	}
	rows, err := a.Settings.Owners(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "读取主人名单失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"control_qq": a.ControlQQ,
		"owners":     rows,
	})
}

func (a *api) adminAddOwner(w http.ResponseWriter, r *http.Request) {
	if a.Settings == nil {
		writeError(w, http.StatusServiceUnavailable, "settings_unavailable", "设置未初始化")
		return
	}
	var req struct {
		QQ   string `json:"qq"`
		Note string `json:"note"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}
	req.QQ = strings.TrimSpace(req.QQ)
	if !isDigits(req.QQ) {
		writeError(w, http.StatusBadRequest, "invalid_qq", "QQ 号必须是数字")
		return
	}
	if req.QQ == a.ControlQQ {
		writeError(w, http.StatusConflict, "builtin_owner", "内置主人的 QQ 无需重复添加")
		return
	}
	if err := a.Settings.AddOwner(r.Context(), req.QQ, strings.TrimSpace(req.Note)); err != nil {
		if errors.Is(err, store.ErrDuplicateKey) {
			writeError(w, http.StatusConflict, "duplicate", "该 QQ 已在主人名单中")
			return
		}
		writeError(w, http.StatusInternalServerError, "store_error", "添加失败")
		return
	}
	a.audit(r, "owners.add", req.QQ)
	a.adminListOwners(w, r)
}

func (a *api) adminDeleteOwner(w http.ResponseWriter, r *http.Request) {
	if a.Settings == nil {
		writeError(w, http.StatusServiceUnavailable, "settings_unavailable", "设置未初始化")
		return
	}
	qq := strings.TrimSpace(r.PathValue("qq"))
	if qq == "" {
		writeError(w, http.StatusBadRequest, "invalid_qq", "缺少 QQ 号")
		return
	}
	if err := a.Settings.DeleteOwner(r.Context(), qq); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "该 QQ 不在主人名单中")
			return
		}
		writeError(w, http.StatusInternalServerError, "store_error", "删除失败")
		return
	}
	a.audit(r, "owners.delete", qq)
	a.adminListOwners(w, r)
}

// --- status ---

func (a *api) adminStatus(w http.ResponseWriter, r *http.Request) {
	connected, selfID, nickname, obErr := a.onebotLoginInfo(r.Context())
	llmConfigured := false
	model := ""
	if a.LLM != nil {
		llmConfigured = a.LLM.Configured()
		model = a.LLM.Model()
	}
	snap := &settings.Settings{}
	if a.Settings != nil {
		snap = a.Settings.Snapshot()
	}
	now := time.Now()
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	docsToday := 0
	if n, err := a.Store.CountDocFilesSinceAll(r.Context(), start); err == nil {
		docsToday = n
	}
	pdfReady := false
	if a.Docs != nil {
		pdfReady = a.Docs.PDFFontReady()
	}
	out := map[string]any{
		"version":              a.Version,
		"uptime":               time.Since(a.StartedAt).Round(time.Second).String(),
		"onebot_connected":     connected,
		"onebot_self_id":       selfID,
		"onebot_nickname":      nickname,
		"llm_configured":       llmConfigured,
		"llm_model":            model,
		"llm_base_url":         snap.DeepSeek.BaseURL,
		"pdf_font_ready":       pdfReady,
		"docs_today":           docsToday,
		"docs_quota":           snap.Docs.QuotaPerDay,
		"owners":               len(snap.OwnerQQs) + boolToInt(a.ControlQQ != ""),
		"auto_segment_enabled": snap.AutoSegment.Enabled,
		"capabilities":         snap.Capabilities,
	}
	if obErr != "" {
		out["onebot_error"] = obErr
	}
	writeJSON(w, http.StatusOK, out)
}

// onebotLoginInfo probes NapCat through get_login_info; a missing client or an
// error is reported as "not connected" rather than failing the request.
func (a *api) onebotLoginInfo(ctx context.Context) (bool, string, string, string) {
	if a.OneBot == nil {
		return false, "", "", "onebot 未配置"
	}
	probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	raw, err := a.OneBot.CallAction(probeCtx, "get_login_info", nil)
	if err != nil {
		return false, "", "", err.Error()
	}
	var info struct {
		UserID   json.Number `json:"user_id"`
		Nickname string      `json:"nickname"`
	}
	if err := json.Unmarshal(raw, &info); err != nil {
		return true, "", "", ""
	}
	return true, info.UserID.String(), info.Nickname, ""
}

// --- document audit ---

func (a *api) adminDocFiles(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	files, err := a.Store.ListDocFiles(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "读取文档列表失败")
		return
	}
	if files == nil {
		files = []store.DocFile{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": files})
}

func (a *api) adminResendDoc(w http.ResponseWriter, r *http.Request) {
	if a.Docs == nil {
		writeError(w, http.StatusServiceUnavailable, "docs_disabled", "文档功能未启用")
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "invalid_id", "缺少文件 ID")
		return
	}
	file, err := a.Docs.Resend(r.Context(), a.OneBot, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "文件不存在")
			return
		}
		a.log.Error("admin resend doc", "id", id, "err", err)
		writeError(w, http.StatusBadGateway, "resend_failed", err.Error())
		return
	}
	a.audit(r, "docs.resend", id+" "+file.Filename)
	writeJSON(w, http.StatusOK, map[string]any{"file": file})
}

// --- audit ---

func (a *api) adminAudit(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	entries, err := a.Store.ListAudit(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "读取审计日志失败")
		return
	}
	if entries == nil {
		entries = []store.AuditEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"audit": entries})
}

func (a *api) audit(r *http.Request, action, detail string) {
	if a.Admin == nil {
		return
	}
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		return
	}
	a.Admin.Audit(r.Context(), claims.UserID, action, detail)
}

// --- helpers ---

func maskSecret(s string) string {
	if s == "" {
		return ""
	}
	if len([]rune(s)) <= 8 {
		return "****"
	}
	r := []rune(s)
	return string(r[:3]) + "****" + string(r[len(r)-4:])
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

func isDigits(s string) bool {
	if s == "" || len(s) > 20 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
