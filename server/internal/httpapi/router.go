// Package httpapi wires the REST surface: routing, middleware, handlers and
// response helpers.
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/qqsched/server/internal/admin"
	"github.com/qqsched/server/internal/agent"
	"github.com/qqsched/server/internal/auth"
	"github.com/qqsched/server/internal/docs"
	"github.com/qqsched/server/internal/notify"
	"github.com/qqsched/server/internal/onebot"
	"github.com/qqsched/server/internal/scheduler"
	"github.com/qqsched/server/internal/settings"
	"github.com/qqsched/server/internal/store"
	"github.com/qqsched/server/internal/summarize"
)

// Deps bundles everything the router needs.
type Deps struct {
	Store      *store.Store
	Auth       *auth.Manager
	Binder     *auth.BindService
	Summarizer *summarize.Service
	Scheduler  *scheduler.Scheduler
	Hub        *notify.Hub
	QQPusher   *notify.QQPusher

	// Back-office surface.
	Settings  *settings.Store
	Admin     *admin.Service
	Docs      *docs.Service
	LLM       *summarize.Client
	OneBot    onebot.APICaller
	ControlQQ string

	// Agent action surface (LLM / QQ bot → client reminders).
	Agent *agent.Service

	BasePath      string
	OneBotPath    string
	OneBotHandler http.Handler

	// WebHandler optionally serves the embedded client UI at "/" (catch-all).
	WebHandler http.Handler

	Logger    *slog.Logger
	StartedAt time.Time
	Version   string
}

type api struct {
	Deps
	log *slog.Logger

	// replanMu guards replanActive: at most one manual replan per user so a
	// double click cannot burn model tokens twice.
	replanMu     sync.Mutex
	replanActive map[string]bool
}

// NewRouter returns the fully wired HTTP handler.
func NewRouter(d Deps) http.Handler {
	if d.BasePath == "" {
		d.BasePath = "/api/v1"
	}
	log := d.Logger
	if log == nil {
		log = slog.Default()
	}
	if d.StartedAt.IsZero() {
		d.StartedAt = time.Now()
	}
	if d.Version == "" {
		d.Version = "dev"
	}
	a := &api{Deps: d, log: log}
	base := strings.TrimRight(d.BasePath, "/")

	// OneBot ingress (its own token check, no JWT).
	if d.OneBotHandler != nil && d.OneBotPath != "" {
		// Route both the exact path and its subtree to the provider handler.
		path := d.OneBotPath
		if !strings.HasSuffix(path, "/") {
			path += "/"
		}
		a.log.Info("mounting onebot endpoint", "path", path)
	}

	mux := http.NewServeMux()

	// Observability (unauthenticated).
	mux.HandleFunc("GET /healthz", a.healthz)
	mux.HandleFunc("GET /metrics", a.metrics)

	// Auth (unauthenticated).
	mux.HandleFunc("POST "+base+"/auth/register", a.register)
	mux.HandleFunc("POST "+base+"/auth/login", a.login)

	// Bindings (authenticated).
	mux.Handle("POST "+base+"/bindings/qq/initiate", a.secure(http.HandlerFunc(a.bindInitiate)))
	mux.Handle("POST "+base+"/bindings/qq/confirm", a.secure(http.HandlerFunc(a.bindConfirm)))
	mux.Handle("GET "+base+"/bindings", a.secure(http.HandlerFunc(a.listBindings)))
	mux.Handle("DELETE "+base+"/bindings/{qq_uid}", a.secure(http.HandlerFunc(a.deleteBinding)))

	// Schedules (authenticated).
	mux.Handle("GET "+base+"/schedules/me", a.secure(http.HandlerFunc(a.getSchedule)))
	mux.Handle("GET "+base+"/schedules/me/delta", a.secure(http.HandlerFunc(a.getScheduleDelta)))
	mux.Handle("GET "+base+"/schedules/me/revision", a.secure(http.HandlerFunc(a.getRevision)))
	mux.Handle("POST "+base+"/schedules/me/items", a.secure(http.HandlerFunc(a.createItem)))
	mux.Handle("PATCH "+base+"/schedules/me/items/{id}", a.secure(http.HandlerFunc(a.patchItem)))
	mux.Handle("DELETE "+base+"/schedules/me/items/{id}", a.secure(http.HandlerFunc(a.deleteItem)))
	mux.Handle("POST "+base+"/schedules/me/sync", a.secure(http.HandlerFunc(a.syncItems)))

	// Manual replan: streams the thinking chain while the AI rebuilds the
	// schedule (server-sent events consumed by the client via fetch).
	mux.Handle("POST "+base+"/schedules/me/replan", a.secure(http.HandlerFunc(a.replanStream)))
	mux.Handle("GET "+base+"/schedules/me/replan/latest", a.secure(http.HandlerFunc(a.latestReplan)))

	// Alerts (authenticated).
	mux.Handle("GET "+base+"/alerts/me", a.secure(http.HandlerFunc(a.listAlerts)))
	mux.Handle("POST "+base+"/alerts/me/{id}/read", a.secure(http.HandlerFunc(a.readAlert)))

	// Who am I: tells the client whether this account is the server owner,
	// so the back-office entry is only shown to the master.
	mux.Handle("GET "+base+"/me/privileges", a.secure(http.HandlerFunc(a.myPrivileges)))

	// Agent action surface: any LLM / the QQ bot can drive this account's
	// clients (in-app reminders, alarms) and schedules.
	mux.Handle("GET "+base+"/agent/catalog", a.secure(http.HandlerFunc(a.agentCatalog)))
	mux.Handle("POST "+base+"/agent/actions", a.secure(http.HandlerFunc(a.agentExecute)))
	mux.Handle("GET "+base+"/me/actions", a.secure(http.HandlerFunc(a.listMyAgentActions)))
	mux.Handle("POST "+base+"/me/actions/{id}/ack", a.secure(http.HandlerFunc(a.ackMyAgentAction)))

	// Feedback / Contact Us (authenticated, simple freeform submission).
	mux.Handle("POST "+base+"/feedback", a.secure(http.HandlerFunc(a.createFeedback)))

	// Realtime push (authenticated via query token).
	mux.Handle("GET "+base+"/ws", a.secure(http.HandlerFunc(a.pushWS)))

	// Back office: admin-scoped tokens only.
	mux.HandleFunc("POST "+base+"/admin/login", a.adminLogin)
	// Owner SSO: a normal user token whose verified QQ binding is the control
	// QQ gets an admin-scoped token without re-entering the admin password.
	mux.Handle("POST "+base+"/admin/owner-sso", a.secure(http.HandlerFunc(a.adminOwnerSSO)))
	mux.Handle("GET "+base+"/admin/me", a.adminSecure(http.HandlerFunc(a.adminMe)))
	mux.Handle("GET "+base+"/admin/settings", a.adminSecure(http.HandlerFunc(a.adminGetSettings)))
	mux.Handle("PUT "+base+"/admin/settings", a.adminSecure(http.HandlerFunc(a.adminPutSettings)))
	mux.Handle("POST "+base+"/admin/settings/test-llm", a.adminSecure(http.HandlerFunc(a.adminTestLLM)))
	mux.Handle("GET "+base+"/admin/owners", a.adminSecure(http.HandlerFunc(a.adminListOwners)))
	mux.Handle("POST "+base+"/admin/owners", a.adminSecure(http.HandlerFunc(a.adminAddOwner)))
	mux.Handle("DELETE "+base+"/admin/owners/{qq}", a.adminSecure(http.HandlerFunc(a.adminDeleteOwner)))
	mux.Handle("GET "+base+"/admin/status", a.adminSecure(http.HandlerFunc(a.adminStatus)))
	mux.Handle("GET "+base+"/admin/doc-files", a.adminSecure(http.HandlerFunc(a.adminDocFiles)))
	mux.Handle("POST "+base+"/admin/doc-files/{id}/resend", a.adminSecure(http.HandlerFunc(a.adminResendDoc)))
	mux.Handle("GET "+base+"/admin/audit", a.adminSecure(http.HandlerFunc(a.adminAudit)))

	// OneBot ingress (its own bearer/query token check).
	if d.OneBotHandler != nil && d.OneBotPath != "" {
		mux.Handle(d.OneBotPath, d.OneBotHandler)
	}

	// Embedded H5 client at "/" — the least specific pattern, so it never
	// shadows the API, health and OneBot routes above.
	if d.WebHandler != nil {
		mux.Handle("/", d.WebHandler)
	}

	return a.recoverer(a.logger(a.cors(mux)))
}

// secure wraps a handler with JWT authentication.
func (a *api) secure(h http.Handler) http.Handler {
	return a.Auth.Middleware(h)
}

// --- response helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// Headers are already flushed; nothing more we can do.
		return
	}
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": msg, "code": code})
}

func decodeJSON(r *http.Request, out any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return err
	}
	if len(body) == 0 {
		return errors.New("empty body")
	}
	if err := json.Unmarshal(body, out); err != nil {
		return err
	}
	return nil
}

// --- middleware ---

func (a *api) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				a.log.Error("http panic recovered", "path", r.URL.Path, "panic", rec)
				writeError(w, http.StatusInternalServerError, "internal", "internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (a *api) logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		a.log.Debug("http request", "method", r.Method, "path", r.URL.Path, "dur", time.Since(start).String())
	})
}

// cors allows the packaged desktop (Tauri, origin http://tauri.localhost) and
// mobile (Capacitor, origin https://localhost / capacitor://localhost) shells to
// call the API. The embedded web UI is same-origin and is unaffected.
//
// The API authenticates with a bearer token (never cookies), so a wildcard
// origin is safe here; preflight requests are short-circuited before routing so
// OPTIONS never hits the JWT middleware.
func (a *api) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		h.Set("Access-Control-Max-Age", "86400")
		// SSE + websocket clients must not be buffered by proxies.
		h.Add("Vary", "Origin")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- misc handlers ---

func (a *api) healthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"version": a.Version,
		"uptime":  time.Since(a.StartedAt).Round(time.Second).String(),
		"time":    time.Now().UTC().Format(time.RFC3339),
	})
}

func (a *api) metrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var lines []string
	lines = append(lines, "# qqsched server metrics")
	lines = append(lines, "uptime_seconds "+itoa64(int64(time.Since(a.StartedAt).Seconds())))
	if a.Hub != nil {
		lines = append(lines, "ws_clients "+itoa64(int64(a.Hub.ClientCount())))
	}
	if bindings, err := a.Store.ListVerifiedBindings(ctx); err == nil {
		lines = append(lines, "verified_bindings "+itoa64(int64(len(bindings))))
	}
	if pending, err := a.Store.ListPendingAssets(ctx, 1000); err == nil {
		lines = append(lines, "pending_assets "+itoa64(int64(len(pending))))
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	for _, l := range lines {
		_, _ = w.Write([]byte(l + "\n"))
	}
}

func itoa64(n int64) string {
	return jsonNumber(n)
}

func jsonNumber(n int64) string {
	buf, _ := json.Marshal(n)
	return string(buf)
}
