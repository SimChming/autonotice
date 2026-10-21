package contentfetch

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/qqsched/server/internal/analyze"
	"github.com/qqsched/server/internal/contentfetch/docparse"
	"github.com/qqsched/server/internal/store"
)

// Config tunes the fetch pipeline.
type Config struct {
	Enabled             bool
	MaxBytes            int64
	WebMaxBytes         int64
	ConnectTimeout      time.Duration
	TotalTimeout        time.Duration
	Concurrency         int
	CacheTTL            time.Duration
	PerGroupHourlyLimit int
	JinaEnabled         bool
	JinaAPIKey          string
	JinaEngine          string
	JinaBaseURL         string
	JinaTimeout         time.Duration
	JinaPrivateChats    bool
	BodyLimit           int
}

// Queue is the asynchronous fetch / parse / analyze pipeline. Enqueue never
// blocks message ingestion.
type Queue struct {
	cfg      Config
	store    *store.Store
	fileURL  FileURLProvider
	comparer *analyze.Comparer
	log      *slog.Logger

	client *http.Client
	jina   *Jina
	ch     chan store.ContentAsset

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu      sync.RWMutex
	onAlert func(store.Alert)
	started bool
}

// NewQueue builds the pipeline. comparer may be nil (template-only mode).
func NewQueue(cfg Config, st *store.Store, fileURL FileURLProvider, comparer *analyze.Comparer, log *slog.Logger) *Queue {
	if log == nil {
		log = slog.Default()
	}
	if cfg.Concurrency <= 0 {
		cfg.Concurrency = 4
	}
	if cfg.Concurrency > 5 {
		cfg.Concurrency = 5
	}
	if cfg.BodyLimit <= 0 {
		cfg.BodyLimit = 32 * 1024
	}
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = 7 * 24 * time.Hour
	}
	if cfg.WebMaxBytes <= 0 {
		cfg.WebMaxBytes = 2 << 20
	}
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = 20 << 20
	}
	if cfg.TotalTimeout <= 0 {
		cfg.TotalTimeout = 20 * time.Second
	}
	return &Queue{
		cfg:      cfg,
		store:    st,
		fileURL:  fileURL,
		comparer: comparer,
		log:      log,
		client:   SafeClient(cfg.ConnectTimeout, cfg.TotalTimeout),
		jina:     NewJina(cfg.JinaEnabled, cfg.JinaBaseURL, cfg.JinaAPIKey, cfg.JinaEngine, cfg.JinaTimeout),
		ch:       make(chan store.ContentAsset, 256),
	}
}

// SetAlertSink registers the callback invoked for every newly created alert.
func (q *Queue) SetAlertSink(fn func(store.Alert)) {
	q.mu.Lock()
	q.onAlert = fn
	q.mu.Unlock()
}

// Start launches the worker pool.
func (q *Queue) Start(ctx context.Context) {
	if !q.cfg.Enabled {
		q.log.Info("content fetching disabled")
		return
	}
	q.mu.Lock()
	if q.started {
		q.mu.Unlock()
		return
	}
	q.started = true
	q.ctx, q.cancel = context.WithCancel(ctx)
	runCtx := q.ctx
	q.mu.Unlock()

	for i := 0; i < q.cfg.Concurrency; i++ {
		q.wg.Add(1)
		go func() {
			defer q.wg.Done()
			q.worker(runCtx)
		}()
	}
	q.log.Info("content fetch pipeline started", "concurrency", q.cfg.Concurrency, "jina", q.cfg.JinaEnabled)
}

// Stop gracefully stops the worker pool.
func (q *Queue) Stop() {
	q.mu.RLock()
	cancel := q.cancel
	q.mu.RUnlock()
	if cancel != nil {
		cancel()
	}
	q.wg.Wait()
}

// Enqueue schedules an asset for background processing. It never blocks.
func (q *Queue) Enqueue(a store.ContentAsset) {
	if !q.cfg.Enabled {
		return
	}
	select {
	case q.ch <- a:
	default:
		q.log.Warn("content fetch queue full, dropping asset", "asset", a.ID, "kind", a.Kind)
	}
}

func (q *Queue) worker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case a := <-q.ch:
			q.processOne(ctx, a)
		}
	}
}

func (q *Queue) processOne(ctx context.Context, a store.ContentAsset) {
	defer func() {
		if r := recover(); r != nil {
			q.log.Error("content fetch panic recovered", "asset", a.ID, "panic", r)
		}
	}()

	timeout := q.cfg.TotalTimeout
	if a.Kind == store.AssetFile {
		timeout = 90 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if q.cfg.PerGroupHourlyLimit > 0 {
		if n, err := q.store.CountGroupFetchesSince(ctx, a.GroupID, time.Now().Add(-time.Hour)); err == nil && n >= q.cfg.PerGroupHourlyLimit {
			q.log.Warn("per-group fetch limit reached, deferring", "group", a.GroupID, "limit", q.cfg.PerGroupHourlyLimit)
			return
		}
	}

	out := q.fetch(ctx, a)
	q.apply(ctx, a, out)
}

type outcome struct {
	status        string
	finalURL      string
	httpStatus    int
	mime          string
	text          string
	blockedReason string
	scheme        bool
	timedOut      bool
	tooLarge      bool
	jinaTried     bool
	jinaFailed    bool
	contentHash   string
}

func (q *Queue) fetch(ctx context.Context, a store.ContentAsset) outcome {
	var out outcome

	switch a.Kind {
	case store.AssetFile:
		url, err := ResolveFileURL(ctx, q.fileURL, a)
		if err != nil {
			q.log.Warn("resolve group file url failed", "asset", a.ID, "err", err)
			out.status = store.FetchFailed
			out.timedOut = isTimeout(err)
			return out
		}
		data, mime, err := DownloadBytes(ctx, q.client, url, q.cfg.MaxBytes)
		if err != nil {
			if errors.Is(err, ErrTooLarge) {
				out.status = store.FetchTooLarge
				out.tooLarge = true
				return out
			}
			out.status = store.FetchFailed
			out.timedOut = isTimeout(err)
			return out
		}
		out.finalURL = url
		out.httpStatus = 200
		out.mime = mime
		out.contentHash = hashBytes(data)
		text, perr := docparse.ParseBytes(ctx, a.FileName, mime, data)
		if perr != nil {
			if errors.Is(perr, docparse.ErrUnsupported) {
				out.status = store.FetchUnfetchable
				return out
			}
			q.log.Warn("doc parse failed", "asset", a.ID, "file", a.FileName, "err", perr)
			out.status = store.FetchUnfetchable
			return out
		}
		out.text = text

	default: // link | miniapp | wechat_article
		raw := strings.TrimSpace(a.DeclaredURL)
		if raw == "" {
			out.scheme = true
			out.status = store.FetchUnfetchable
			out.blockedReason = ReasonScheme
			return out
		}
		if _, err := ValidateURL(raw); err != nil {
			out.scheme = true
			out.status = store.FetchUnfetchable
			out.blockedReason = ReasonScheme
			return out
		}
		res, err := FetchHTTP(ctx, q.client, raw, q.cfg.WebMaxBytes, true)
		if err != nil {
			if errors.Is(err, ErrTooLarge) {
				out.tooLarge = true
				out.status = store.FetchTooLarge
				return out
			}
			out.timedOut = isTimeout(err)
		} else {
			out.finalURL = res.FinalURL
			out.httpStatus = res.StatusCode
			out.mime = res.ContentType
			out.text = res.Text
			out.contentHash = hashBytes([]byte(out.text))
		}
		if strings.TrimSpace(out.text) == "" || out.httpStatus >= 400 {
			if q.jinaAllowed(a) {
				out.jinaTried = true
				text, jerr := q.jina.Fetch(ctx, raw)
				if jerr != nil {
					out.jinaFailed = true
					q.log.Debug("jina fallback failed", "asset", a.ID, "err", jerr)
				} else if strings.TrimSpace(text) != "" {
					out.text = text
					out.contentHash = hashBytes([]byte(text))
					if out.httpStatus == 0 || out.httpStatus >= 400 {
						out.httpStatus = 200
					}
					if out.finalURL == "" {
						out.finalURL = raw
					}
				}
			}
		}
	}

	if out.status == "" {
		blocked, reason := Classify(BlockInput{
			StatusCode: out.httpStatus,
			FinalURL:   out.finalURL,
			BodyText:   out.text,
			BodyChars:  len([]rune(strings.TrimSpace(out.text))),
			Scheme:     out.scheme,
			TimedOut:   out.timedOut,
			JinaTried:  out.jinaTried,
			JinaFailed: out.jinaFailed,
			TooLarge:   out.tooLarge,
		})
		if blocked {
			out.status = store.FetchBlocked
			out.blockedReason = reason
		} else {
			out.status = store.FetchOK
		}
	}
	return out
}

func (q *Queue) jinaAllowed(a store.ContentAsset) bool {
	if q.jina == nil || !q.jina.Enabled() {
		return false
	}
	// Private chats and scheme-only targets never go through Jina unless the
	// operator opted in.
	if a.GroupID == "" && !q.cfg.JinaPrivateChats {
		return false
	}
	return true
}

func (q *Queue) apply(ctx context.Context, a store.ContentAsset, out outcome) {
	body := truncateBytes(strings.TrimSpace(out.text), q.cfg.BodyLimit)
	a.FetchStatus = out.status
	a.FinalURL = out.finalURL
	a.HTTPStatus = out.httpStatus
	a.BodyText = body
	a.BodyChars = len([]rune(body))
	a.BlockedReason = out.blockedReason
	a.ContentHash = out.contentHash
	if out.mime != "" {
		a.MIME = out.mime
	}
	now := time.Now().UTC()
	a.FetchedAt = &now

	reused := false
	if a.ContentHash != "" {
		if cached, err := q.store.FindRecentAssetByHash(ctx, a.ContentHash, time.Now().Add(-q.cfg.CacheTTL)); err == nil &&
			cached.ID != a.ID && cached.BodyText != "" && cached.FetchStatus == a.FetchStatus {
			a.BodyText = cached.BodyText
			a.BodyChars = cached.BodyChars
			a.BlockedReason = cached.BlockedReason
			reused = true
		}
	}

	ctxLines := q.contextLines(ctx, a)
	title, summary, reason, manual := q.review(ctx, &a, ctxLines, reused)

	if err := q.store.UpdateAssetResult(ctx, a); err != nil {
		q.log.Error("persist asset result", "asset", a.ID, "err", err)
	}
	q.log.Info("asset processed", "asset", a.ID, "kind", a.Kind, "status", a.FetchStatus, "chars", a.BodyChars, "reused", reused)

	if manual {
		q.raiseAlerts(ctx, a, title, summary, reason, ctxLines)
	}
}

// review decides whether human attention is required and builds the copy.
func (q *Queue) review(ctx context.Context, a *store.ContentAsset, ctxLines []string, reused bool) (title, summary, reason string, manual bool) {
	switch a.FetchStatus {
	case store.FetchOK, store.FetchBlocked:
		if !reused && q.comparer != nil {
			if res, err := q.comparer.Compare(ctx, *a, ctxLines); err == nil {
				if res.Consistency == analyze.ConsistencyMismatch && a.FetchStatus == store.FetchOK {
					a.FetchStatus = store.FetchBlocked
					a.BlockedReason = ReasonMismatch
				}
				if res.ManualReview || a.FetchStatus == store.FetchBlocked {
					return "需人工查看：" + firstSentence(res.UserMessage), res.UserMessage, a.BlockedReason, true
				}
				return "", "", "", false
			} else {
				q.log.Warn("analyze compare failed, falling back to template", "asset", a.ID, "err", err)
			}
		}
		if a.FetchStatus == store.FetchBlocked {
			t, s := analyze.FallbackMessage(*a, ctxLines)
			return t, s, a.BlockedReason, true
		}
		return "", "", "", false
	default:
		t, s := analyze.FallbackMessage(*a, ctxLines)
		return t, s, a.BlockedReason, true
	}
}

func (q *Queue) raiseAlerts(ctx context.Context, a store.ContentAsset, title, summary, reason string, ctxLines []string) {
	bindings, err := q.store.ListVerifiedBindings(ctx)
	if err != nil {
		q.log.Error("list verified bindings", "err", err)
		return
	}
	excerpt := ""
	if len(ctxLines) > 0 {
		excerpt = truncateRunes(ctxLines[len(ctxLines)-1], 200)
	}

	// 清洗所有展示文本里的 CQ 代码，避免前端出现乱码
	title = cleanCQ(title)
	summary = cleanCQ(summary)
	excerpt = cleanCQ(excerpt)
	reason = cleanCQ(reason)

	// 填充来源元信息：区分私聊 / 群聊，并给出可展示的名称 + 头像
	msgType := a.MessageType
	if msgType == "" {
		if a.GroupID != "" {
			msgType = "group"
		} else {
			msgType = "private"
		}
	}
	var (
		srcName  string
		srcAvatar string
	)
	if msgType == "group" {
		srcName = q.store.GetGroupName(ctx, a.GroupID)
		if srcName == "" {
			srcName = "群 " + a.GroupID
		}
	} else {
		srcName = a.SenderQQ
	}
	if a.SenderQQ != "" {
		// QQ 公开头像接口（无需鉴权）
		srcAvatar = "https://q1.qlogo.cn/g?b=qq&nk=" + a.SenderQQ + "&s=100"
	}

	targets := map[string]struct{}{}
	for _, b := range bindings {
		if a.GroupID != "" && b.GroupID != "" && b.GroupID != a.GroupID {
			continue
		}
		targets[b.QQUID] = struct{}{}
	}
	if len(targets) == 0 && a.SenderQQ != "" {
		targets[a.SenderQQ] = struct{}{}
	}

	q.mu.RLock()
	sink := q.onAlert
	q.mu.RUnlock()

	for qq := range targets {
		al := store.Alert{
			UserQQ:         qq,
			GroupID:        a.GroupID,
			ContentAssetID: a.ID,
			Level:          "high",
			Title:          title,
			Summary:        summary,
			ContextExcerpt: excerpt,
			ReviewReason:   reason,
			MessageType:    msgType,
			SourceName:     srcName,
			SourceAvatar:   srcAvatar,
		}
		saved, inserted, err := q.store.InsertAlert(ctx, al)
		if err != nil {
			q.log.Error("insert alert", "asset", a.ID, "qq", qq, "err", err)
			continue
		}
		if inserted && sink != nil {
			sink(*saved)
		}
	}
}

// cleanCQ removes [CQ:...] segments and HTML-encoded entities from user-facing
// strings so alert cards don't show garbled codes like `&amp;`.
func cleanCQ(s string) string {
	if s == "" {
		return ""
	}
	// CQ 代码: [CQ:image,...], [CQ:at,...], ...
	cqRe := regexp.MustCompile(`\[CQ:[^\]]*\]`)
	s = cqRe.ReplaceAllString(s, "")
	// HTML 转义还原（CQ code 里经常 &amp; 把等号和 & 编码了）
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&#91;", "[")
	s = strings.ReplaceAll(s, "&#93;", "]")
	s = strings.ReplaceAll(s, "&quot;", "\"")
	// 清理多余空白
	s = strings.Join(strings.Fields(s), " ")
	return s
}

func (q *Queue) contextLines(ctx context.Context, a store.ContentAsset) []string {
	msgs, err := q.store.RecentMessages(ctx, a.GroupID, time.Time{}, 12)
	if err != nil {
		q.log.Debug("load context messages failed", "err", err)
		return nil
	}
	out := make([]string, 0, len(msgs))
	for _, m := range msgs {
		name := m.SenderName
		if name == "" {
			name = m.SenderQQ
		}
		out = append(out, fmt.Sprintf("%s | %s | %s", m.MsgTime.Format("01-02 15:04"), name, squash(m.Text)))
	}
	return out
}

func hashBytes(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	sum := sha1.Sum(b)
	return "sha1:" + hex.EncodeToString(sum[:])
}

func isTimeout(err error) bool {
	if err == nil {
		return false
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return true
	}
	s := strings.ToLower(err.Error())
	for _, marker := range []string{"timeout", "deadline exceeded", "no such host", "tls handshake", "connection refused"} {
		if strings.Contains(s, marker) {
			return true
		}
	}
	return false
}

func truncateBytes(s string, n int) string {
	if n <= 0 || len(s) <= n {
		return s
	}
	b := []byte(s)[:n]
	for len(b) > 0 && !utf8.Valid(b) {
		b = b[:len(b)-1]
	}
	return string(b)
}

func truncateRunes(s string, n int) string {
	if n <= 0 || len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "..."
}

func squash(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(s, "\n", " ")), " ")
}

func firstSentence(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "内容需人工查看"
	}
	line := s
	if i := strings.IndexByte(s, '\n'); i > 0 {
		line = s[:i]
	}
	return truncateRunes(line, 60)
}
