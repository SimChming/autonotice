package v11

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/qqsched/server/internal/onebot"
)

// PostConfig configures the HTTP report fallback.
type PostConfig struct {
	Token        string
	Path         string
	APIBase      string
	CallTimeout  time.Duration
	EventsBuffer int
}

// PostServer is the alternate reporting mode: the bot POSTs events to us and we
// call actions by POSTing to the bot's HTTP API.
type PostServer struct {
	cfg        PostConfig
	log        *slog.Logger
	events     chan onebot.Event
	api        *API
	httpClient *http.Client
}

// NewPostServer builds the HTTP report provider.
func NewPostServer(cfg PostConfig, log *slog.Logger) *PostServer {
	if log == nil {
		log = slog.Default()
	}
	if cfg.Path == "" {
		cfg.Path = "/onebot/v11/http"
	}
	if cfg.CallTimeout <= 0 {
		cfg.CallTimeout = 15 * time.Second
	}
	if cfg.EventsBuffer <= 0 {
		cfg.EventsBuffer = 512
	}
	p := &PostServer{
		cfg:        cfg,
		log:        log,
		events:     make(chan onebot.Event, cfg.EventsBuffer),
		httpClient: &http.Client{Timeout: cfg.CallTimeout},
	}
	p.api = NewAPI(p, log)
	return p
}

// Name identifies the provider.
func (p *PostServer) Name() string { return "onebot-v11-http-post" }

// Start marks the provider ready.
func (p *PostServer) Start(context.Context) error { return nil }

// Stop is a no-op for the HTTP fallback.
func (p *PostServer) Stop(context.Context) error { return nil }

// Events exposes the normalized event stream.
func (p *PostServer) Events() <-chan onebot.Event { return p.events }

// API exposes the action caller.
func (p *PostServer) API() onebot.APICaller { return p.api }

// Path returns the configured report route.
func (p *PostServer) Path() string { return p.cfg.Path }

// Handler serves the event report endpoint.
func (p *PostServer) Handler() http.Handler { return http.HandlerFunc(p.handleReport) }

func (p *PostServer) handleReport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !authorized(r, p.cfg.Token) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if ct := r.Header.Get("Content-Type"); strings.Contains(ct, "form") {
		if err := r.ParseForm(); err == nil {
			if v := r.PostFormValue("event"); v != "" {
				body = []byte(v)
			}
		}
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var payload map[string]any
	if err := dec.Decode(&payload); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if ev, ok := onebot.NormalizeV11(payload); ok {
		select {
		case p.events <- ev:
		default:
			p.log.Warn("event buffer full, dropping event", "kind", ev.Kind)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// Call implements Caller via the OneBot HTTP API at APIBase.
func (p *PostServer) Call(ctx context.Context, action string, params map[string]any) (json.RawMessage, error) {
	if p.cfg.APIBase == "" {
		return nil, errors.New("onebot: http api base not configured")
	}
	buf, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	url := strings.TrimRight(p.cfg.APIBase, "/") + "/" + action
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if p.cfg.Token != "" {
		req.Header.Set("Authorization", "Bearer "+p.cfg.Token)
	}
	resp, err := p.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("onebot http %s: %w", action, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("onebot http %s: status %d: %s", action, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	return json.RawMessage(data), nil
}
