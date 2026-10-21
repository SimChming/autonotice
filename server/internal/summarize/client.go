package summarize

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// ClientConfig configures the OpenAI-compatible DeepSeek client.
type ClientConfig struct {
	APIKey    string
	BaseURL   string
	Model     string
	// ReasoningModel streams the thinking chain for manual replans; empty falls
	// back to Model.
	ReasoningModel string
	Timeout        time.Duration
	MaxRetries     int
	MaxTokens      int
	Temperature    float64
	// EnableThinking 显式控制思维链；nil 表示不下发该字段，沿用服务端默认。
	EnableThinking *bool
}

// Client is a minimal OpenAI-compatible chat completion client that always asks
// for JSON output and validates the result. Its configuration is stored in an
// atomic pointer so the admin UI can rotate keys/models without a restart.
type Client struct {
	cfg  atomic.Pointer[ClientConfig]
	http *http.Client
	// httpStream has no overall timeout: a fixed Timeout would abort long
	// reasoning streams mid-flight. Only the first byte is bounded.
	httpStream *http.Client
	log        *slog.Logger
}

// NewClient builds a DeepSeek client. Both summarize and analyze share it.
func NewClient(cfg ClientConfig, log *slog.Logger) *Client {
	if log == nil {
		log = slog.Default()
	}
	cfg = normalizeConfig(cfg)
	c := &Client{
		http: &http.Client{Timeout: cfg.Timeout},
		httpStream: &http.Client{Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 15 * time.Second}).DialContext,
			ResponseHeaderTimeout: 60 * time.Second,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
		}},
		log: log,
	}
	c.cfg.Store(&cfg)
	return c
}

func normalizeConfig(cfg ClientConfig) ClientConfig {
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://api.deepseek.com"
	}
	if cfg.Model == "" {
		cfg.Model = "deepseek-chat"
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 90 * time.Second
	}
	if cfg.MaxTokens <= 0 {
		cfg.MaxTokens = 4096
	}
	return cfg
}

// Update swaps the runtime configuration (API key, model, base URL, thinking
// mode). In-flight requests keep their old snapshot.
func (c *Client) Update(cfg ClientConfig) {
	cfg = normalizeConfig(cfg)
	c.cfg.Store(&cfg)
}

func (c *Client) config() *ClientConfig {
	if v := c.cfg.Load(); v != nil {
		return v
	}
	return &ClientConfig{}
}

// Model returns the configured model id.
func (c *Client) Model() string { return c.config().Model }

// ReasoningModel returns the model used to stream the thinking chain, falling
// back to the regular model when none is configured.
func (c *Client) ReasoningModel() string {
	cfg := c.config()
	if cfg.ReasoningModel != "" {
		return cfg.ReasoningModel
	}
	return cfg.Model
}

// Configured reports whether an API key is present.
func (c *Client) Configured() bool { return c.config().APIKey != "" }

type chatMessage struct {
	Role    string `json:"role"`
	// Content 既可以是纯文本 string，也可以是 OpenAI 多模态数组
	// [{type:"text",...},{type:"image_url",...}]，因此用 any 承载。
	Content any `json:"content"`
}

// chatContent 是多模态消息里的单个片段。
type chatContent struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	ImageURL *imageURL `json:"image_url,omitempty"`
}

type imageURL struct {
	URL string `json:"url"`
}

// userContent 组装 user 消息内容：有图片时返回多模态数组，否则返回纯文本。
func userContent(text string, images []string) any {
	if len(images) == 0 {
		return text
	}
	parts := make([]chatContent, 0, len(images)+1)
	parts = append(parts, chatContent{Type: "text", Text: text})
	for _, img := range images {
		img = strings.TrimSpace(img)
		if img == "" {
			continue
		}
		parts = append(parts, chatContent{Type: "image_url", ImageURL: &imageURL{URL: img}})
	}
	return parts
}

type chatRequest struct {
	Model          string            `json:"model"`
	Messages       []chatMessage     `json:"messages"`
	ResponseFormat map[string]string `json:"response_format,omitempty"`
	MaxTokens      int               `json:"max_tokens"`
	Temperature    float64           `json:"temperature"`
	Stream         bool              `json:"stream"`
	// EnableThinking 为 nil 时省略该字段，兼容不支持的厂商。
	EnableThinking *bool `json:"enable_thinking,omitempty"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

// ChatJSON sends the prompt pair requesting a JSON object and returns the
// validated JSON payload. It retries up to MaxRetries times with backoff on
// transport errors, empty content and malformed JSON.
func (c *Client) ChatJSON(ctx context.Context, system, user string) (json.RawMessage, error) {
	return c.ChatJSONImages(ctx, system, user, nil)
}

// ChatJSONImages 与 ChatJSON 相同，但会把图片以多模态数组塞进 user 消息，
// 供 qwen-vl-plus 等视觉模型识图。images 为图片公网 URL 或 data:base64。
func (c *Client) ChatJSONImages(ctx context.Context, system, user string, images []string) (json.RawMessage, error) {
	cfg := c.config()
	if cfg.APIKey == "" {
		return nil, fmt.Errorf("deepseek: api key not configured")
	}
	attempts := cfg.MaxRetries + 1
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(1<<uint(attempt-1)) * time.Second
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
		}
		raw, err := c.doChat(ctx, system, user, images)
		if err == nil {
			return raw, nil
		}
		lastErr = err
		c.log.Warn("deepseek request failed, retrying", "attempt", attempt+1, "err", err)
	}
	return nil, fmt.Errorf("deepseek: exhausted %d attempts: %w", attempts, lastErr)
}

func (c *Client) doChat(ctx context.Context, system, user string, images []string) (json.RawMessage, error) {
	cfg := c.config()
	reqBody := chatRequest{
		Model: cfg.Model,
		Messages: []chatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: userContent(user, images)},
		},
		ResponseFormat: map[string]string{"type": "json_object"},
		MaxTokens:      cfg.MaxTokens,
		Temperature:    cfg.Temperature,
		EnableThinking: cfg.EnableThinking,
	}
	buf, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}
	url := strings.TrimRight(cfg.BaseURL, "/") + "/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("deepseek: status %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	var parsed chatResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("deepseek: decode response: %w", err)
	}
	if parsed.Error != nil {
		return nil, fmt.Errorf("deepseek: api error: %s", parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 {
		return nil, fmt.Errorf("deepseek: empty choices")
	}
	content := parsed.Choices[len(parsed.Choices)-1].Message.Content
	content = strings.TrimSpace(content)
	if content == "" {
		return nil, fmt.Errorf("deepseek: empty content (finish_reason=%s)", parsed.Choices[len(parsed.Choices)-1].FinishReason)
	}
	obj := extractJSONObject(content)
	if !json.Valid([]byte(obj)) {
		return nil, fmt.Errorf("deepseek: invalid json: %s", truncate(obj, 300))
	}
	var probe map[string]any
	if err := json.Unmarshal([]byte(obj), &probe); err != nil {
		return nil, fmt.Errorf("deepseek: not a json object: %w", err)
	}
	return json.RawMessage(obj), nil
}

// Ping sends a minimal non-JSON completion to verify the current credentials
// and model are usable. Used by the admin "test connection" button.
func (c *Client) Ping(ctx context.Context) (string, error) {
	cfg := c.config()
	if cfg.APIKey == "" {
		return "", fmt.Errorf("deepseek: api key not configured")
	}
	reqBody := chatRequest{
		Model: cfg.Model,
		Messages: []chatMessage{
			{Role: "system", Content: "You are a connectivity probe. Reply with exactly OK."},
			{Role: "user", Content: "ping"},
		},
		MaxTokens:   8,
		Temperature: 0,
	}
	buf, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}
	url := strings.TrimRight(cfg.BaseURL, "/") + "/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("status %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	var parsed chatResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}
	if len(parsed.Choices) == 0 {
		return "", fmt.Errorf("empty choices")
	}
	return strings.TrimSpace(parsed.Choices[len(parsed.Choices)-1].Message.Content), nil
}

// StreamOptions tunes a streaming completion.
type StreamOptions struct {
	// Model overrides the client's default model when non-empty.
	Model string
	// JSONMode asks the provider for a JSON object response.
	JSONMode bool
	// MaxTokens caps the completion; 0 falls back to the client default.
	MaxTokens int
	// Temperature overrides the client default when non-zero-valued.
	Temperature float64
}

// StreamDelta is one incremental chunk of a streaming completion.
type StreamDelta struct {
	Reasoning string
	Content   string
}

type streamChunk struct {
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// ChatStream posts a streaming completion and calls onDelta for every chunk,
// returning the accumulated reasoning and content text. Returning an error from
// onDelta aborts the stream immediately (used when the client disconnects).
func (c *Client) ChatStream(
	ctx context.Context,
	system, user string,
	opt StreamOptions,
	onDelta func(StreamDelta) error,
) (string, string, error) {
	cfg := c.config()
	if cfg.APIKey == "" {
		return "", "", fmt.Errorf("deepseek: api key not configured")
	}
	model := opt.Model
	if model == "" {
		model = cfg.Model
	}
	maxTokens := opt.MaxTokens
	if maxTokens <= 0 {
		maxTokens = cfg.MaxTokens
	}
	temperature := opt.Temperature
	if temperature == 0 {
		temperature = cfg.Temperature
	}
	reqBody := chatRequest{
		Model: model,
		Messages: []chatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		MaxTokens:   maxTokens,
		Temperature: temperature,
		Stream:      true,
	}
	if opt.JSONMode {
		reqBody.ResponseFormat = map[string]string{"type": "json_object"}
	}
	buf, err := json.Marshal(reqBody)
	if err != nil {
		return "", "", err
	}
	url := strings.TrimRight(cfg.BaseURL, "/") + "/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)

	resp, err := c.httpStream.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return "", "", fmt.Errorf("deepseek: status %d: %s", resp.StatusCode, truncate(string(body), 300))
	}

	var (
		reasoning strings.Builder
		content   strings.Builder
		finish    string
	)
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" {
			break
		}
		var chunk streamChunk
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			// Keep-alive comments or partial frames: skip instead of failing.
			continue
		}
		if chunk.Error != nil && chunk.Error.Message != "" {
			return reasoning.String(), content.String(), fmt.Errorf("deepseek: api error: %s", chunk.Error.Message)
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		d := chunk.Choices[len(chunk.Choices)-1]
		if d.FinishReason != "" {
			finish = d.FinishReason
		}
		delta := StreamDelta{Reasoning: d.Delta.ReasoningContent, Content: d.Delta.Content}
		if delta.Reasoning == "" && delta.Content == "" {
			continue
		}
		if delta.Reasoning != "" {
			reasoning.WriteString(delta.Reasoning)
		}
		if delta.Content != "" {
			content.WriteString(delta.Content)
		}
		if onDelta != nil {
			if err := onDelta(delta); err != nil {
				return reasoning.String(), content.String(), err
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return reasoning.String(), content.String(), fmt.Errorf("deepseek: read stream: %w", err)
	}
	if reasoning.Len() == 0 && content.Len() == 0 {
		return "", "", fmt.Errorf("deepseek: empty stream (finish_reason=%s)", finish)
	}
	return reasoning.String(), content.String(), nil
}

func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```")
		s = strings.TrimPrefix(s, "json")
		s = strings.TrimPrefix(s, "JSON")
		if idx := strings.LastIndex(s, "```"); idx >= 0 {
			s = s[:idx]
		}
		s = strings.TrimSpace(s)
	}
	if i := strings.Index(s, "{"); i >= 0 {
		if j := strings.LastIndex(s, "}"); j > i {
			return s[i : j+1]
		}
	}
	return s
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
