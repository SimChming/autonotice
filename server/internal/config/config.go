// Package config loads application configuration from a YAML file with
// environment-variable overrides applied afterwards.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Config is the root configuration document.
type Config struct {
	Server   ServerConfig   `yaml:"server"`
	OneBot   OneBotConfig   `yaml:"onebot"`
	Database DatabaseConfig `yaml:"database"`
	Auth     AuthConfig     `yaml:"auth"`
	Bind     BindConfig     `yaml:"bind"`
	DeepSeek DeepSeekConfig `yaml:"deepseek"`
	Fetch    FetchConfig    `yaml:"fetch"`
	Jina     JinaConfig     `yaml:"jina"`
	Privacy  PrivacyConfig  `yaml:"privacy"`
	Notify   NotifyConfig   `yaml:"notify"`
	Schedule ScheduleConfig `yaml:"schedule"`
	Bot      BotConfig      `yaml:"bot"`
	Admin    AdminConfig    `yaml:"admin"`
	Docs     DocsConfig     `yaml:"docs"`
}

type ServerConfig struct {
	Addr     string `yaml:"addr"`
	BasePath string `yaml:"base_path"`
}

type OneBotConfig struct {
	// Mode is one of "reverse_ws" or "http_post".
	Mode         string   `yaml:"mode"`
	Token        string   `yaml:"token"`
	WSPath       string   `yaml:"ws_path"`
	HTTPPostPath string   `yaml:"http_post_path"`
	APIBase      string   `yaml:"api_base"`
	Groups       []string `yaml:"groups"`
}

type DatabaseConfig struct {
	Path string `yaml:"path"`
}

type AuthConfig struct {
	JWTSecret   string `yaml:"jwt_secret"`
	JWTTTLHours int    `yaml:"jwt_ttl_hours"`
}

type BindConfig struct {
	CodeTTLMinutes int `yaml:"code_ttl_minutes"`
	CodeLength     int `yaml:"code_length"`
}

type DeepSeekConfig struct {
	APIKey         string  `yaml:"api_key"`
	BaseURL        string  `yaml:"base_url"`
	Model          string  `yaml:"model"`
	ReasoningModel string  `yaml:"reasoning_model"`
	TimeoutSeconds int     `yaml:"timeout_seconds"`
	MaxRetries     int     `yaml:"max_retries"`
	MaxTokens      int     `yaml:"max_tokens"`
	Temperature    float64 `yaml:"temperature"`
	// EnableThinking 仅在显式配置时才下发，nil 表示交给服务端默认值。
	// 结构化抽取与群聊对话关掉思维链可显著降低延迟与 token 消耗。
	EnableThinking *bool `yaml:"enable_thinking"`
}

type FetchConfig struct {
	Enabled             bool  `yaml:"enabled"`
	MaxBytes            int64 `yaml:"max_bytes"`
	WebMaxBytes         int64 `yaml:"web_max_bytes"`
	ConnectTimeoutSec   int   `yaml:"connect_timeout_seconds"`
	TotalTimeoutSec     int   `yaml:"total_timeout_seconds"`
	Concurrency         int   `yaml:"concurrency"`
	CacheTTLHours       int   `yaml:"cache_ttl_hours"`
	PerGroupHourlyLimit int   `yaml:"per_group_hourly_limit"`
}

type JinaConfig struct {
	Enabled    bool   `yaml:"enabled"`
	APIKey     string `yaml:"api_key"`
	Engine     string `yaml:"engine"`
	BaseURL    string `yaml:"base_url"`
	TimeoutSec int    `yaml:"timeout_seconds"`
}

type PrivacyConfig struct {
	JinaPrivateChats bool `yaml:"jina_private_chats"`
}

type NotifyConfig struct {
	WSEnabled     bool `yaml:"ws_enabled"`
	QQPrivatePush bool `yaml:"qq_private_push"`
	QQRatePerHour int  `yaml:"qq_rate_per_hour"`
}

type ScheduleConfig struct {
	DailyCron   string `yaml:"daily_cron"`
	LightCron   string `yaml:"light_cron"`
	CleanupCron string `yaml:"cleanup_cron"`
	Timezone    string `yaml:"timezone"`
}

// BotConfig tunes the in-chat 「鲸鱼娘顽皮女仆」 controller. Only ControlQQ may
// drive the host shell; every other QQ gets a playful refusal.
type BotConfig struct {
	Enabled         bool     `yaml:"enabled"`
	ControlQQ       string   `yaml:"control_qq"`
	SelfQQ          string   `yaml:"self_qq"`
	Prefixes        []string `yaml:"prefixes"`
	MaxIterations   int      `yaml:"max_iterations"`
	OutputLimit     int      `yaml:"output_limit"`
	HistoryTurns    int      `yaml:"history_turns"`
	PersonaOverride string   `yaml:"persona_override"`
	MemoryTopN      int      `yaml:"memory_top_n"`
}

// AdminConfig bootstraps the isolated back-office account.
type AdminConfig struct {
	// InitialPassword creates the default `admin` account when no admin exists.
	InitialPassword string `yaml:"initial_password"`
}

// DocsConfig tunes local xlsx/docx/pdf generation.
type DocsConfig struct {
	Enabled     bool   `yaml:"enabled"`
	Root        string `yaml:"root"`
	QuotaPerDay int    `yaml:"quota_per_day"`
	// PDFFontPath optionally points at a CJK TrueType font (.ttf).
	PDFFontPath string `yaml:"pdf_font_path"`
}

// Default returns a configuration populated with sensible defaults.
func Default() *Config {
	return &Config{
		Server:   ServerConfig{Addr: ":8080", BasePath: "/api/v1"},
		OneBot:   OneBotConfig{Mode: "reverse_ws", WSPath: "/onebot/v11/ws", HTTPPostPath: "/onebot/v11/http", APIBase: "http://127.0.0.1:3000"},
		Database: DatabaseConfig{Path: "data/app.db"},
		Auth:     AuthConfig{JWTTTLHours: 720},
		Bind:     BindConfig{CodeTTLMinutes: 15, CodeLength: 6},
		DeepSeek: DeepSeekConfig{
			BaseURL:        "https://dashscope.aliyuncs.com/compatible-mode/v1",
			Model:          "qwen3.8-flash",
			ReasoningModel: "qwen3.8-flash",
			TimeoutSeconds: 90,
			MaxRetries:     2,
			MaxTokens:      4096,
			Temperature:    0.3,
		},
		Fetch: FetchConfig{
			Enabled:             true,
			MaxBytes:            20 * 1024 * 1024,
			WebMaxBytes:         2 * 1024 * 1024,
			ConnectTimeoutSec:   5,
			TotalTimeoutSec:     20,
			Concurrency:         4,
			CacheTTLHours:       168,
			PerGroupHourlyLimit: 60,
		},
		Jina:   JinaConfig{Enabled: true, BaseURL: "https://r.jina.ai/", TimeoutSec: 60},
		Notify: NotifyConfig{WSEnabled: true, QQPrivatePush: false, QQRatePerHour: 5},
		Schedule: ScheduleConfig{
			DailyCron:   "0 7 * * *",
			LightCron:   "0 */2 * * *",
			CleanupCron: "30 23 * * *",
			Timezone:    "Asia/Shanghai",
		},
		Bot: BotConfig{
			Enabled:       true,
			ControlQQ:     "3874095145",
			SelfQQ:        "3754609823",
			Prefixes:      []string{"/sh", "shell"},
			MaxIterations: 6,
			OutputLimit:   3500,
			HistoryTurns:  12,
			MemoryTopN:    5,
		},
		Docs: DocsConfig{
			Enabled:     true,
			Root:        "data/docs",
			QuotaPerDay: 2,
		},
	}
}

// Load reads the YAML file at path (when non-empty) then applies environment
// overrides and validation. An empty path yields pure defaults + env.
func Load(path string) (*Config, error) {
	cfg := Default()
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read config %s: %w", path, err)
		}
		if err := yaml.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("parse config %s: %w", path, err)
		}
	}
	cfg.applyEnv()
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func (c *Config) applyEnv() {
	if v := os.Getenv("SERVER_ADDR"); v != "" {
		c.Server.Addr = v
	}
	if v := os.Getenv("SERVER_BASE_PATH"); v != "" {
		c.Server.BasePath = v
	}
	if v := os.Getenv("ONEBOT_MODE"); v != "" {
		c.OneBot.Mode = v
	}
	if v := os.Getenv("ONEBOT_TOKEN"); v != "" {
		c.OneBot.Token = v
	}
	if v := os.Getenv("ONEBOT_WS_PATH"); v != "" {
		c.OneBot.WSPath = v
	}
	if v := os.Getenv("ONEBOT_HTTP_POST_PATH"); v != "" {
		c.OneBot.HTTPPostPath = v
	}
	if v := os.Getenv("ONEBOT_API_BASE"); v != "" {
		c.OneBot.APIBase = v
	}
	if v := os.Getenv("BOT_GROUPS"); v != "" {
		c.OneBot.Groups = splitCSV(v)
	}
	if v := os.Getenv("DATABASE_PATH"); v != "" {
		c.Database.Path = v
	}
	if v := os.Getenv("JWT_SECRET"); v != "" {
		c.Auth.JWTSecret = v
	}
	if v := os.Getenv("JWT_TTL_HOURS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.Auth.JWTTTLHours = n
		}
	}
	if v := os.Getenv("DEEPSEEK_API_KEY"); v != "" {
		c.DeepSeek.APIKey = v
	}
	if v := os.Getenv("DEEPSEEK_BASE_URL"); v != "" {
		c.DeepSeek.BaseURL = v
	}
	if v := os.Getenv("DEEPSEEK_MODEL"); v != "" {
		c.DeepSeek.Model = v
	}
	if v := os.Getenv("DEEPSEEK_TIMEOUT_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.DeepSeek.TimeoutSeconds = n
		}
	}
	if v := os.Getenv("DEEPSEEK_MAX_TOKENS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.DeepSeek.MaxTokens = n
		}
	}
	if v := os.Getenv("FETCH_ENABLED"); v != "" {
		c.Fetch.Enabled = parseBool(v)
	}
	if v := os.Getenv("FETCH_MAX_BYTES"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			c.Fetch.MaxBytes = n
		}
	}
	if v := os.Getenv("FETCH_WEB_MAX_BYTES"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			c.Fetch.WebMaxBytes = n
		}
	}
	if v := os.Getenv("FETCH_CONCURRENCY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.Fetch.Concurrency = n
		}
	}
	if v := os.Getenv("JINA_ENABLED"); v != "" {
		c.Jina.Enabled = parseBool(v)
	}
	if v := os.Getenv("JINA_API_KEY"); v != "" {
		c.Jina.APIKey = v
	}
	if v := os.Getenv("JINA_ENGINE"); v != "" {
		c.Jina.Engine = v
	}
	if v := os.Getenv("JINA_BASE_URL"); v != "" {
		c.Jina.BaseURL = v
	}
	if v := os.Getenv("NOTIFY_QQ_PRIVATE_PUSH"); v != "" {
		c.Notify.QQPrivatePush = parseBool(v)
	}
	if v := os.Getenv("TZ"); v != "" {
		c.Schedule.Timezone = v
	}
	if v := os.Getenv("SCHEDULE_TIMEZONE"); v != "" {
		c.Schedule.Timezone = v
	}
	if v := os.Getenv("BOT_ENABLED"); v != "" {
		c.Bot.Enabled = parseBool(v)
	}
	if v := os.Getenv("BOT_CONTROL_QQ"); v != "" {
		c.Bot.ControlQQ = strings.TrimSpace(v)
	}
	if v := os.Getenv("ADMIN_PASSWORD"); v != "" {
		c.Admin.InitialPassword = v
	}
	if v := os.Getenv("DOCS_ENABLED"); v != "" {
		c.Docs.Enabled = parseBool(v)
	}
	if v := os.Getenv("DOCS_ROOT"); v != "" {
		c.Docs.Root = v
	}
	if v := os.Getenv("DOCS_QUOTA_PER_DAY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.Docs.QuotaPerDay = n
		}
	}
	if v := os.Getenv("DOCS_PDF_FONT"); v != "" {
		c.Docs.PDFFontPath = v
	}
}

func (c *Config) validate() error {
	if c.Server.Addr == "" {
		return fmt.Errorf("server.addr must not be empty")
	}
	if c.Database.Path == "" {
		return fmt.Errorf("database.path must not be empty")
	}
	if c.Auth.JWTTTLHours <= 0 {
		c.Auth.JWTTTLHours = 720
	}
	if c.Bind.CodeLength < 4 {
		c.Bind.CodeLength = 6
	}
	if c.Bind.CodeTTLMinutes <= 0 {
		c.Bind.CodeTTLMinutes = 15
	}
	if c.DeepSeek.BaseURL == "" {
		c.DeepSeek.BaseURL = "https://api.deepseek.com"
	}
	if c.DeepSeek.Model == "" {
		c.DeepSeek.Model = "deepseek-chat"
	}
	if c.DeepSeek.ReasoningModel == "" {
		c.DeepSeek.ReasoningModel = "deepseek-reasoner"
	}
	if c.DeepSeek.TimeoutSeconds <= 0 {
		c.DeepSeek.TimeoutSeconds = 90
	}
	if c.Fetch.Concurrency <= 0 {
		c.Fetch.Concurrency = 4
	}
	if c.Fetch.Concurrency > 5 {
		c.Fetch.Concurrency = 5
	}
	if c.Fetch.MaxBytes <= 0 {
		c.Fetch.MaxBytes = 20 * 1024 * 1024
	}
	if c.Fetch.WebMaxBytes <= 0 {
		c.Fetch.WebMaxBytes = 2 * 1024 * 1024
	}
	if c.Fetch.ConnectTimeoutSec <= 0 {
		c.Fetch.ConnectTimeoutSec = 5
	}
	if c.Fetch.TotalTimeoutSec <= 0 {
		c.Fetch.TotalTimeoutSec = 20
	}
	if c.Fetch.CacheTTLHours <= 0 {
		c.Fetch.CacheTTLHours = 168
	}
	if c.Jina.BaseURL == "" {
		c.Jina.BaseURL = "https://r.jina.ai/"
	}
	if c.Jina.TimeoutSec <= 0 {
		c.Jina.TimeoutSec = 60
	}
	if c.Schedule.Timezone == "" {
		c.Schedule.Timezone = "Asia/Shanghai"
	}
	if c.OneBot.Mode == "" {
		c.OneBot.Mode = "reverse_ws"
	}
	if c.OneBot.WSPath == "" {
		c.OneBot.WSPath = "/onebot/v11/ws"
	}
	if len(c.Bot.Prefixes) == 0 {
		c.Bot.Prefixes = []string{"/sh", "shell"}
	}
	if c.Bot.MaxIterations <= 0 {
		c.Bot.MaxIterations = 6
	}
	if c.Bot.OutputLimit <= 0 {
		c.Bot.OutputLimit = 3500
	}
	if c.Bot.HistoryTurns <= 0 {
		c.Bot.HistoryTurns = 12
	}
	if c.Bot.MemoryTopN <= 0 {
		c.Bot.MemoryTopN = 5
	}
	if c.Docs.Root == "" {
		c.Docs.Root = "data/docs"
	}
	if c.Docs.QuotaPerDay <= 0 {
		c.Docs.QuotaPerDay = 2
	}
	return nil
}

// TTL returns the JWT lifetime as a duration.
func (c *AuthConfig) TTL() time.Duration {
	return time.Duration(c.JWTTTLHours) * time.Hour
}

func parseBool(v string) bool {
	b, err := strconv.ParseBool(strings.TrimSpace(v))
	if err == nil {
		return b
	}
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "yes", "y", "on", "1":
		return true
	default:
		return false
	}
}

func splitCSV(v string) []string {
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
