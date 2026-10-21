// Command app assembles and runs the QQ group schedule assistant server.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "time/tzdata" // embed the tz database so Asia/Shanghai always resolves

	"github.com/qqsched/server/internal/admin"
	"github.com/qqsched/server/internal/agent"
	"github.com/qqsched/server/internal/analyze"
	"github.com/qqsched/server/internal/auth"
	"github.com/qqsched/server/internal/bot"
	"github.com/qqsched/server/internal/config"
	"github.com/qqsched/server/internal/contentfetch"
	"github.com/qqsched/server/internal/docs"
	"github.com/qqsched/server/internal/groupmeta"
	"github.com/qqsched/server/internal/httpapi"
	"github.com/qqsched/server/internal/ingest"
	"github.com/qqsched/server/internal/memory"
	"github.com/qqsched/server/internal/notify"
	"github.com/qqsched/server/internal/onebot"
	"github.com/qqsched/server/internal/onebot/v11"
	"github.com/qqsched/server/internal/scheduler"
	"github.com/qqsched/server/internal/settings"
	"github.com/qqsched/server/internal/shellctl"
	"github.com/qqsched/server/internal/store"
	"github.com/qqsched/server/internal/summarize"
	"github.com/qqsched/server/internal/web"
)

const version = "0.1.0"

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	configPath := flag.String("config", envOr("CONFIG_PATH", "configs/config.yaml"), "path to the YAML config file")
	logLevel := flag.String("log-level", envOr("LOG_LEVEL", "info"), "log level: debug|info|warn|error")
	flag.Parse()

	logger := newLogger(*logLevel)
	slog.SetDefault(logger)

	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	logger.Info("starting qqsched server", "version", version, "mode", cfg.OneBot.Mode, "db", cfg.Database.Path)

	loc, err := time.LoadLocation(cfg.Schedule.Timezone)
	if err != nil {
		logger.Warn("unknown timezone, using UTC", "tz", cfg.Schedule.Timezone)
		loc = time.UTC
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// --- storage ---
	st, err := store.Open(cfg.Database.Path)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}

	// --- runtime settings (overridable from the back office, no restart) ---
	runtimeSettings, err := settings.Load(ctx, st, settings.Settings{
		DeepSeek: settings.DeepSeek{
			APIKey:         cfg.DeepSeek.APIKey,
			BaseURL:        cfg.DeepSeek.BaseURL,
			Model:          cfg.DeepSeek.Model,
			EnableThinking: cfg.DeepSeek.EnableThinking,
		},
		Capabilities: settings.DefaultCapabilities(),
		AutoSegment:  settings.DefaultAutoSegment(),
		Docs:         settings.Docs{QuotaPerDay: cfg.Docs.QuotaPerDay},
	}, logger)
	if err != nil {
		return err
	}

	// --- DeepSeek (shared by summarize + analyze) ---
	initial := runtimeSettings.Snapshot()
	client := summarize.NewClient(summarize.ClientConfig{
		APIKey:         initial.DeepSeek.APIKey,
		BaseURL:        initial.DeepSeek.BaseURL,
		Model:          initial.DeepSeek.Model,
		ReasoningModel: initial.DeepSeek.Model,
		Timeout:        time.Duration(cfg.DeepSeek.TimeoutSeconds) * time.Second,
		MaxRetries:     cfg.DeepSeek.MaxRetries,
		MaxTokens:      cfg.DeepSeek.MaxTokens,
		Temperature:    cfg.DeepSeek.Temperature,
		EnableThinking: initial.DeepSeek.EnableThinking,
	}, logger)
	runtimeSettings.Subscribe(func(s *settings.Settings) {
		client.Update(summarize.ClientConfig{
			APIKey:         s.DeepSeek.APIKey,
			BaseURL:        s.DeepSeek.BaseURL,
			Model:          s.DeepSeek.Model,
			ReasoningModel: s.DeepSeek.Model,
			Timeout:        time.Duration(cfg.DeepSeek.TimeoutSeconds) * time.Second,
			MaxRetries:     cfg.DeepSeek.MaxRetries,
			MaxTokens:      cfg.DeepSeek.MaxTokens,
			Temperature:    cfg.DeepSeek.Temperature,
			EnableThinking: s.DeepSeek.EnableThinking,
		})
		logger.Info("runtime model settings applied", "model", s.DeepSeek.Model)
	})
	if !client.Configured() {
		logger.Warn("DEEPSEEK_API_KEY is not set; summarization will be recorded as failed")
	}
	summ := summarize.New(st, client, logger, loc)
	comparer := analyze.NewComparer(client, logger)

	// --- OneBot provider ---
	provider, err := buildProvider(cfg, logger)
	if err != nil {
		return err
	}
	var oneBotHandler http.Handler
	if h, ok := provider.(onebot.InboundHandler); ok {
		oneBotHandler = h.Handler()
	}

	// --- content fetch pipeline ---
	queue := contentfetch.NewQueue(contentfetch.Config{
		Enabled:             cfg.Fetch.Enabled,
		MaxBytes:            cfg.Fetch.MaxBytes,
		WebMaxBytes:         cfg.Fetch.WebMaxBytes,
		ConnectTimeout:      time.Duration(cfg.Fetch.ConnectTimeoutSec) * time.Second,
		TotalTimeout:        time.Duration(cfg.Fetch.TotalTimeoutSec) * time.Second,
		Concurrency:         cfg.Fetch.Concurrency,
		CacheTTL:            time.Duration(cfg.Fetch.CacheTTLHours) * time.Hour,
		PerGroupHourlyLimit: cfg.Fetch.PerGroupHourlyLimit,
		JinaEnabled:         cfg.Jina.Enabled,
		JinaAPIKey:          cfg.Jina.APIKey,
		JinaEngine:          cfg.Jina.Engine,
		JinaBaseURL:         cfg.Jina.BaseURL,
		JinaTimeout:         time.Duration(cfg.Jina.TimeoutSec) * time.Second,
		JinaPrivateChats:    cfg.Privacy.JinaPrivateChats,
		BodyLimit:           32 * 1024,
	}, st, provider.API(), comparer, logger)

	// --- ingest ---
	ing := ingest.New(st, queue, logger, cfg.OneBot.Groups)

	// --- in-chat bot: persona replies + authorized shell control ---
	shell := shellctl.New(30*time.Minute, logger)
	shell.Start(ctx)
	groupNamer := groupmeta.New(provider.API(), st, logger)
	ing.SetGroupNamer(groupNamer)
	memSvc := memory.New(st, logger)
	var docSvc *docs.Service
	if cfg.Docs.Enabled {
		docSvc = docs.New(st, cfg.Docs.Root, cfg.Docs.PDFFontPath, func() int {
			return runtimeSettings.Snapshot().Docs.QuotaPerDay
		}, logger)
	}
	// --- realtime push hub (needed by the agent action surface below) ---
	var hub *notify.Hub
	if cfg.Notify.WSEnabled {
		hub = notify.NewHub(logger)
	}

	// --- Autonotice action surface: shared by the HTTP API and the QQ bot ---
	agentSvc := agent.New(st, hub, runtimeSettings, cfg.Bot.ControlQQ, logger)

	botSvc := bot.New(bot.Config{
		Enabled:         cfg.Bot.Enabled,
		ControlQQ:       cfg.Bot.ControlQQ,
		SelfQQ:          cfg.Bot.SelfQQ,
		Prefixes:        cfg.Bot.Prefixes,
		MaxIterations:   cfg.Bot.MaxIterations,
		OutputLimit:     cfg.Bot.OutputLimit,
		HistoryTurns:    cfg.Bot.HistoryTurns,
		PersonaOverride: cfg.Bot.PersonaOverride,
		MemoryTopN:      cfg.Bot.MemoryTopN,
	}, provider.API(), shell, client, memSvc, runtimeSettings, docSvc, st, agentSvc, logger)
	ing.SetResponder(botSvc)
	if cfg.Bot.Enabled {
		logger.Info("in-chat bot enabled", "control_qq", cfg.Bot.ControlQQ)
	}

	// --- auth + binding ---
	authMgr := auth.NewManager(cfg.Auth.JWTSecret, cfg.Auth.TTL())
	binder := auth.NewBindService(st, time.Duration(cfg.Bind.CodeTTLMinutes)*time.Minute, cfg.Bind.CodeLength, logger)
	ing.SetBindVerifier(binder)

	// --- back office ---
	adminSvc := admin.New(st, authMgr, logger)
	if err := adminSvc.EnsureInitial(ctx, cfg.Admin.InitialPassword); err != nil {
		return err
	}

	// --- notifications ---
	qqPusher := notify.NewQQPusher(provider.API(), cfg.Notify.QQPrivatePush, cfg.Notify.QQRatePerHour, logger)

	queue.SetAlertSink(func(al store.Alert) {
		if hub != nil {
			notifyCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if b, err := st.GetVerifiedBindingForQQ(notifyCtx, al.UserQQ); err == nil && b != nil {
				hub.PushAlert(b.UserID, al)
			}
			cancel()
		}
		if qqPusher.Enabled() {
			pushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := qqPusher.PushAlert(pushCtx, al); err != nil {
				logger.Warn("qq alert push failed", "qq", al.UserQQ, "err", err)
			}
			cancel()
		}
	})

	// --- scheduler ---
	sch, err := scheduler.New(summ, st, cfg.Schedule, logger)
	if err != nil {
		return err
	}

	// --- HTTP API ---
	router := httpapi.NewRouter(httpapi.Deps{
		Store:         st,
		Auth:          authMgr,
		Binder:        binder,
		Summarizer:    summ,
		Scheduler:     sch,
		Hub:           hub,
		QQPusher:      qqPusher,
		Settings:      runtimeSettings,
		Admin:         adminSvc,
		Docs:          docSvc,
		Agent:         agentSvc,
		LLM:           client,
		OneBot:        provider.API(),
		ControlQQ:     cfg.Bot.ControlQQ,
		BasePath:      cfg.Server.BasePath,
		OneBotPath:    onebotPath(cfg),
		OneBotHandler: oneBotHandler,
		WebHandler:    web.Handler(),
		Logger:        logger,
		StartedAt:     time.Now(),
		Version:       version,
	})

	server := &http.Server{
		Addr:              cfg.Server.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// --- start background components ---
	if err := provider.Start(ctx); err != nil {
		return err
	}
	queue.Start(ctx)
	sch.Start()
	go ing.Run(ctx, provider.Events())

	serveErr := make(chan error, 1)
	go func() {
		logger.Info("http server listening", "addr", cfg.Server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutdown signal received")
	case err := <-serveErr:
		logger.Error("http server error", "err", err)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Warn("http shutdown", "err", err)
	}
	sch.Stop()
	queue.Stop()
	shell.CloseAll()
	if err := provider.Stop(shutdownCtx); err != nil {
		logger.Warn("provider stop", "err", err)
	}
	logger.Info("server stopped")
	return nil
}

func buildProvider(cfg *config.Config, log *slog.Logger) (onebot.Provider, error) {
	switch cfg.OneBot.Mode {
	case "http_post":
		return v11.NewPostServer(v11.PostConfig{
			Token:        cfg.OneBot.Token,
			Path:         cfg.OneBot.HTTPPostPath,
			APIBase:      cfg.OneBot.APIBase,
			CallTimeout:  15 * time.Second,
			EventsBuffer: 512,
		}, log), nil
	default:
		return v11.NewServer(v11.Config{
			Token:        cfg.OneBot.Token,
			Path:         cfg.OneBot.WSPath,
			CallTimeout:  15 * time.Second,
			EventsBuffer: 512,
		}, log), nil
	}
}

func onebotPath(cfg *config.Config) string {
	if cfg.OneBot.Mode == "http_post" {
		return cfg.OneBot.HTTPPostPath
	}
	return cfg.OneBot.WSPath
}

func newLogger(level string) *slog.Logger {
	var lvl slog.Level
	switch level {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
