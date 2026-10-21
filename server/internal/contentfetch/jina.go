package contentfetch

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Jina is the second-tier fallback reader (https://r.jina.ai). It performs
// headless rendering remotely and can parse PDFs. Disabled by default for
// private chats for privacy.
type Jina struct {
	enabled bool
	baseURL string
	apiKey  string
	engine  string
	client  *http.Client
}

// NewJina builds a Jina reader client.
func NewJina(enabled bool, baseURL, apiKey, engine string, timeout time.Duration) *Jina {
	if baseURL == "" {
		baseURL = "https://r.jina.ai/"
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return &Jina{
		enabled: enabled,
		baseURL: baseURL,
		apiKey:  apiKey,
		engine:  engine,
		client:  &http.Client{Timeout: timeout},
	}
}

// Enabled reports whether the reader may be used.
func (j *Jina) Enabled() bool { return j != nil && j.enabled }

// Fetch retrieves the rendered text of target through Jina Reader.
func (j *Jina) Fetch(ctx context.Context, target string) (string, error) {
	if j == nil || !j.enabled {
		return "", fmt.Errorf("contentfetch: jina disabled")
	}
	u := strings.TrimRight(j.baseURL, "/") + "/" + target
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "text/plain")
	req.Header.Set("User-Agent", userAgent)
	if j.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+j.apiKey)
	}
	if j.engine != "" {
		req.Header.Set("X-Engine", j.engine)
	}
	resp, err := j.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("contentfetch: jina status %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return normalizeText(string(body)), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
