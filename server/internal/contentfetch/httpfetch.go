package contentfetch

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/PuerkitoBio/goquery"
	readability "github.com/go-shiori/go-readability"
)

// ErrTooLarge is returned when a response exceeds the configured size cap.
var ErrTooLarge = errors.New("contentfetch: response too large")

// userAgent identifies our fetcher politely.
const userAgent = "QQSchedBot/1.0 (+https://example.invalid/qqsched)"

// FetchResult is the outcome of a direct HTTP fetch.
type FetchResult struct {
	FinalURL    string
	StatusCode  int
	ContentType string
	Body        []byte
	Title       string
	Text        string
}

// Fetched reports whether any extractable text was obtained.
func (r *FetchResult) Fetched() bool {
	return r != nil && strings.TrimSpace(r.Text) != ""
}

// FetchHTTP performs one direct, SSRF-safe GET, optionally extracting readable
// text and a title for HTML responses.
func FetchHTTP(ctx context.Context, client *http.Client, rawURL string, maxBytes int64, wantText bool) (*FetchResult, error) {
	if _, err := ValidateURL(rawURL); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	limit := maxBytes
	if limit <= 0 {
		limit = 2 << 20
	}
	body, err := readLimited(resp.Body, limit)
	if err != nil {
		return nil, err
	}

	res := &FetchResult{
		StatusCode:  resp.StatusCode,
		ContentType: resp.Header.Get("Content-Type"),
		Body:        body,
	}
	if resp.Request != nil && resp.Request.URL != nil {
		res.FinalURL = resp.Request.URL.String()
	}

	if wantText && looksHTML(res.ContentType, body) {
		res.Title, res.Text = extractReadable(body, res.FinalURL)
	} else if wantText && strings.HasPrefix(res.ContentType, "text/") {
		res.Text = string(body)
	}
	return res, nil
}

// DownloadBytes fetches raw bytes (used for group files) and returns the MIME type.
func DownloadBytes(ctx context.Context, client *http.Client, rawURL string, maxBytes int64) ([]byte, string, error) {
	res, err := FetchHTTP(ctx, client, rawURL, maxBytes, false)
	if err != nil {
		return nil, "", err
	}
	if res.StatusCode >= 400 {
		return nil, res.ContentType, fmt.Errorf("contentfetch: status %d", res.StatusCode)
	}
	return res.Body, res.ContentType, nil
}

func readLimited(r io.Reader, limit int64) ([]byte, error) {
	buf := &bytes.Buffer{}
	n, err := io.Copy(buf, io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if n > limit {
		return nil, ErrTooLarge
	}
	return buf.Bytes(), nil
}

func looksHTML(contentType string, body []byte) bool {
	ct := strings.ToLower(contentType)
	if strings.Contains(ct, "html") || strings.Contains(ct, "xml") {
		return true
	}
	if ct == "" || strings.HasPrefix(ct, "text/plain") {
		head := body
		if len(head) > 512 {
			head = head[:512]
		}
		return bytes.Contains(bytes.ToLower(head), []byte("<html")) ||
			bytes.Contains(bytes.ToLower(head), []byte("<!doctype html"))
	}
	return false
}

// extractReadable pulls a title (goquery) and main text (go-readability).
func extractReadable(body []byte, finalURL string) (title, text string) {
	if doc, err := goquery.NewDocumentFromReader(bytes.NewReader(body)); err == nil {
		title = strings.TrimSpace(doc.Find("title").First().Text())
	}

	var pageURL *url.URL
	if finalURL != "" {
		if u, err := url.Parse(finalURL); err == nil {
			pageURL = u
		}
	}
	if article, err := readability.FromReader(bytes.NewReader(body), pageURL); err == nil {
		if strings.TrimSpace(article.TextContent) != "" {
			text = article.TextContent
		}
		if title == "" {
			title = strings.TrimSpace(article.Title)
		}
	}
	if text == "" {
		// Fall back to the whole body text so the JS-required / empty
		// heuristics still have something to look at.
		if doc, err := goquery.NewDocumentFromReader(bytes.NewReader(body)); err == nil {
			text = strings.TrimSpace(doc.Text())
		}
	}
	return title, normalizeText(text)
}

func normalizeText(s string) string {
	lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		l = strings.Join(strings.Fields(l), " ")
		if l != "" {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}
