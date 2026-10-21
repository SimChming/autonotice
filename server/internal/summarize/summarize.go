package summarize

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/qqsched/server/internal/schedule"
	"github.com/qqsched/server/internal/store"
)

// Service orchestrates per-user DeepSeek summarization.
type Service struct {
	store  *store.Store
	client *Client
	log    *slog.Logger
	loc    *time.Location
	// isOwner decides whether a QQ may publish system-level preferences.
	// nil means "nobody" (safe default).
	isOwner func(qq string) bool
}

// New builds the summarization service.
func New(st *store.Store, client *Client, log *slog.Logger, loc *time.Location) *Service {
	if log == nil {
		log = slog.Default()
	}
	if loc == nil {
		loc, _ = time.LoadLocation("Asia/Shanghai")
	}
	return &Service{store: st, client: client, log: log, loc: loc}
}

// Client exposes the shared DeepSeek client so analyze can reuse it.
func (s *Service) Client() *Client { return s.client }

// SetOwnerChecker wires the 主人 check used to gate system-level preferences.
func (s *Service) SetOwnerChecker(fn func(qq string) bool) { s.isOwner = fn }

// RunOptions tunes a single summarization run.
type RunOptions struct {
	Now         time.Time
	Lookback    time.Duration
	MaxMessages int
	// IgnoreLastSummary forces a full rescan of the lookback window and ignores
	// the per-(user, group) summary cursor. Only an explicit "full" request uses
	// this; the normal path always continues from the cursor.
	IgnoreLastSummary bool
}

func (o RunOptions) maxMessages() int {
	if o.MaxMessages <= 0 {
		return 240
	}
	return o.MaxMessages
}

func (o RunOptions) lookback() time.Duration {
	if o.Lookback <= 0 {
		return 168 * time.Hour
	}
	return o.Lookback
}

// RunAll runs summarization for every verified binding.
func (s *Service) RunAll(ctx context.Context, opts RunOptions) {
	bindings, err := s.store.ListVerifiedBindings(ctx)
	if err != nil {
		s.log.Error("list verified bindings", "err", err)
		return
	}
	for _, b := range bindings {
		if err := s.RunForBinding(ctx, b, opts); err != nil {
			s.log.Error("summarize binding", "user", b.UserID, "qq", b.QQUID, "err", err)
		}
	}
}

// runPrep is everything a summarization run needs before calling the model.
// It is shared by the scheduled path (RunForBinding) and the streaming manual
// replan path (RunReplan).
type runPrep struct {
	Run      *store.SummaryRun
	Messages []store.Message
	Existing []schedule.Item
	System   string
	Prompt   string
	Now      time.Time
	Revision int64
	// Since is the cursor this run started from (zero when it was a cold start).
	Since time.Time
}

// prepareRun loads the messages, opens a summary_run row and builds the prompt.
func (s *Service) prepareRun(ctx context.Context, b store.Binding, opts RunOptions) (*runPrep, error) {
	now := opts.Now
	if now.IsZero() {
		now = time.Now().In(s.loc)
	}

	state, err := s.store.GetUserState(ctx, b.UserID)
	if err != nil {
		return nil, fmt.Errorf("get user state: %w", err)
	}

	// Each (user, group) pair carries its own pointer: a summary only reads what
	// arrived after the previous one, so clicking "AI 总结" never re-hashes week-
	// old chatter. A cold start falls back to the configured lookback window.
	since := now.Add(-opts.lookback())
	afterRow := int64(0)
	if !opts.IgnoreLastSummary {
		if cur, curErr := s.store.GetSummaryCursor(ctx, b.UserID, b.GroupID); curErr == nil {
			since = cur.LastMsgTime
			afterRow = cur.LastRowID
		} else if !errors.Is(curErr, store.ErrNotFound) {
			return nil, fmt.Errorf("get summary cursor: %w", curErr)
		}
	}

	msgs, err := s.store.QueryMessagesForUser(ctx, b.GroupID, b.QQUID, since, afterRow, opts.maxMessages())
	if err != nil {
		return nil, fmt.Errorf("query messages: %w", err)
	}

	run, err := s.store.InsertSummaryRun(ctx, store.SummaryRun{
		UserID:  b.UserID,
		QQUID:   b.QQUID,
		GroupID: b.GroupID,
		Status:  store.RunRunning,
	})
	if err != nil {
		return nil, fmt.Errorf("insert summary run: %w", err)
	}

	prep := &runPrep{Run: run, Messages: msgs, Now: now, Revision: state.Revision, Since: since}
	if len(msgs) == 0 {
		return prep, nil
	}

	existing, err := s.store.ListItems(ctx, b.UserID)
	if err != nil {
		return nil, fmt.Errorf("list items: %w", err)
	}

	user, err := s.store.GetUserByID(ctx, b.UserID)
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}

	system, userPrompt := BuildSummarizePrompt(PromptInput{
		UserName: userName(user),
		QQ:       b.QQUID,
		Now:      now,
		Existing: existing,
		Messages: MessageLinesFromRecords(msgs, opts.maxMessages()),
	})
	prep.Existing = existing
	prep.System = system
	prep.Prompt = userPrompt
	return prep, nil
}

// RunForBinding summarizes one verified binding. On any failure the stored
// schedule is left untouched and a failed summary_run is recorded.
func (s *Service) RunForBinding(ctx context.Context, b store.Binding, opts RunOptions) error {
	prep, err := s.prepareRun(ctx, b, opts)
	if err != nil {
		return err
	}

	if len(prep.Messages) == 0 {
		_ = s.store.FinishSummaryRun(ctx, prep.Run.ID, store.RunOK, 0, 0, prep.Revision, "")
		_ = s.store.SetLastSummaryAt(ctx, b.UserID, prep.Now)
		_ = s.store.SetSummaryCursor(ctx, b.UserID, b.GroupID, prep.Now, 0)
		return nil
	}

	if !s.client.Configured() {
		_ = s.store.FinishSummaryRun(ctx, prep.Run.ID, store.RunFailed, len(prep.Messages), 0, prep.Revision, "deepseek api key not configured")
		return fmt.Errorf("deepseek api key not configured")
	}

	callCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	raw, err := s.client.ChatJSON(callCtx, prep.System, prep.Prompt)
	if err != nil {
		_ = s.store.FinishSummaryRun(ctx, prep.Run.ID, store.RunFailed, len(prep.Messages), 0, prep.Revision, err.Error())
		return err
	}

	incoming, prefs, err := parseAIItems(raw, b.GroupID, s.loc)
	if err != nil {
		_ = s.store.FinishSummaryRun(ctx, prep.Run.ID, store.RunFailed, len(prep.Messages), 0, prep.Revision, err.Error())
		return err
	}

	_, err = s.persist(ctx, b, prep, incoming, prefs, len(prep.Messages))
	return err
}

// persist bumps the revision, merges the AI items into the stored schedule,
// closes the summary run and returns how many items changed. Shared by the
// scheduled and manual replan paths.
func (s *Service) persist(ctx context.Context, b store.Binding, prep *runPrep, incoming []schedule.Item, prefs []aiPreference, msgCount int) (int, error) {
	rev, err := s.store.BumpRevision(ctx, b.UserID)
	if err != nil {
		return 0, fmt.Errorf("bump revision: %w", err)
	}
	merged, changed := schedule.MergeAI(prep.Existing, incoming, rev, prep.Now)
	for _, it := range changed {
		it.Revision = rev
		if err := s.store.UpsertItem(ctx, b.UserID, it); err != nil {
			s.log.Error("upsert AI item", "user", b.UserID, "title", it.Title, "err", err)
		}
	}
	_ = s.store.SetLastSummaryAt(ctx, b.UserID, prep.Now)
	s.advanceCursor(ctx, b, prep)
	s.savePreferences(ctx, b, prefs)
	_ = s.store.SetUserDigest(ctx, b.UserID, schedule.Digest(merged))
	if err := s.store.FinishSummaryRun(ctx, prep.Run.ID, store.RunOK, msgCount, len(changed), rev, ""); err != nil {
		s.log.Warn("finish summary run", "err", err)
	}
	s.log.Info("summarized", "user", b.UserID, "qq", b.QQUID, "messages", msgCount, "new_items", len(changed), "revision", rev)
	prep.Revision = rev
	return len(changed), nil
}

// advanceCursor moves the per-(user, group) pointer to the last message this
// run actually consumed (or to "now" when there was nothing to read).
func (s *Service) advanceCursor(ctx context.Context, b store.Binding, prep *runPrep) {
	at, row := prep.Now, int64(0)
	if n := len(prep.Messages); n > 0 {
		last := prep.Messages[n-1]
		if !last.MsgTime.IsZero() {
			at = last.MsgTime
		}
		row = last.RowID
	}
	if err := s.store.SetSummaryCursor(ctx, b.UserID, b.GroupID, at, row); err != nil {
		s.log.Warn("advance summary cursor", "user", b.UserID, "group", b.GroupID, "err", err)
	}
}

// savePreferences publishes system-level preferences. Only the owner's words
// count, and at most three per run, so a stray sentence cannot rewrite the
// robot's behaviour for everyone.
func (s *Service) savePreferences(ctx context.Context, b store.Binding, prefs []aiPreference) {
	if len(prefs) == 0 || s.isOwner == nil || !s.isOwner(b.QQUID) {
		return
	}
	if len(prefs) > 3 {
		prefs = prefs[:3]
	}
	for _, p := range prefs {
		content := strings.TrimSpace(p.Content)
		if content == "" {
			continue
		}
		if len([]rune(content)) > 120 {
			content = string([]rune(content)[:120])
		}
		tags := strings.Join(p.Tags, ",")
		if err := s.store.InsertPreference(ctx, b.QQUID, tags, content, store.MemoryScopeGlobal); err != nil {
			s.log.Warn("save preference", "qq", b.QQUID, "err", err)
			continue
		}
		s.log.Info("preference saved", "qq", b.QQUID, "content", content)
	}
}

func userName(u *store.User) string {
	if u == nil || u.Name == "" {
		return "app-user"
	}
	return u.Name
}

type aiSource struct {
	Kind       string   `json:"kind"`
	GroupID    string   `json:"group_id"`
	MessageIDs []string `json:"message_ids"`
	Excerpt    string   `json:"excerpt"`
	Confidence float64  `json:"confidence"`
}

type aiItem struct {
	Title    string   `json:"title"`
	Type     string   `json:"type"`
	Priority string   `json:"priority"`
	Status   string   `json:"status"`
	DueAt    *string  `json:"due_at"`
	RemindAt *string  `json:"remind_at"`
	AllDay   bool     `json:"all_day"`
	Notes    string   `json:"notes"`
	Source   aiSource `json:"source"`
}

// aiPreference is one system-level preference the model spotted in the chat.
// Only published for the owner QQ; otherwise it is dropped.
type aiPreference struct {
	Content string   `json:"content"`
	Tags    []string `json:"tags"`
}

type aiResult struct {
	Items       []aiItem       `json:"items"`
	Preferences []aiPreference `json:"preferences"`
}

// parseAIItems validates the model output and converts it to schedule items.
// It also returns the system-level preferences the model extracted.
func parseAIItems(raw json.RawMessage, defaultGroup string, loc *time.Location) ([]schedule.Item, []aiPreference, error) {
	var res aiResult
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&res); err != nil {
		// Fall back to lenient decoding before giving up on unknown fields.
		if err2 := json.Unmarshal(raw, &res); err2 != nil {
			return nil, nil, fmt.Errorf("summarize: decode items: %w", err2)
		}
	}
	out := make([]schedule.Item, 0, len(res.Items))
	for _, ai := range res.Items {
		title := strings.TrimSpace(ai.Title)
		if title == "" {
			continue
		}
		if len([]rune(title)) > 120 {
			title = string([]rune(title)[:120])
		}
		it := schedule.Item{
			Title:    title,
			Type:     normalizeType(ai.Type),
			Status:   normalizeStatus(ai.Status),
			Priority: normalizePriority(ai.Priority),
			AllDay:   ai.AllDay,
			Notes:    strings.TrimSpace(ai.Notes),
			Source: schedule.Source{
				Kind:       firstNonEmpty(ai.Source.Kind, schedule.SourceAI),
				GroupID:    firstNonEmpty(ai.Source.GroupID, defaultGroup),
				MessageIDs: ai.Source.MessageIDs,
				Excerpt:    truncateRunes(ai.Source.Excerpt, 200),
				Confidence: ai.Source.Confidence,
			},
		}
		it.DueAt = parseTimePtr(ai.DueAt, loc)
		it.RemindAt = parseTimePtr(ai.RemindAt, loc)
		if it.DueAt != nil && ai.AllDay {
			t := time.Date(it.DueAt.Year(), it.DueAt.Month(), it.DueAt.Day(), 0, 0, 0, 0, loc)
			it.DueAt = &t
		}
		it.Source.AddGroup(it.Source.GroupID, "")
		// The item id is derived from the title + due only, so the same schedule
		// reported by different groups yields the same id and merges cleanly.
		it.ID = deriveItemID(it.Title, it.DueAt)
		out = append(out, it)
	}
	prefs := make([]aiPreference, 0, len(res.Preferences))
	for _, p := range res.Preferences {
		if c := strings.TrimSpace(p.Content); c != "" {
			prefs = append(prefs, aiPreference{Content: c, Tags: p.Tags})
		}
	}
	return out, prefs, nil
}

// deriveItemID makes AI item ids stable across runs so merges are idempotent.
// It intentionally ignores the source group: the same announcement repeated in
// several groups must resolve to one id, not one id per group.
func deriveItemID(title string, due *time.Time) string {
	key := schedule.NormalizeTitle(title)
	if due != nil {
		key += "|" + due.UTC().Format(time.RFC3339)
	}
	sum := sha1.Sum([]byte(key))
	return "ai-" + hex.EncodeToString(sum[:12])
}

func parseTimePtr(s *string, loc *time.Location) *time.Time {
	if s == nil {
		return nil
	}
	v := strings.TrimSpace(*s)
	if v == "" || strings.EqualFold(v, "null") {
		return nil
	}
	layouts := []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02"}
	for _, layout := range layouts {
		if t, err := time.ParseInLocation(layout, v, loc); err == nil {
			utc := t
			return &utc
		}
	}
	return nil
}

func normalizeType(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case schedule.TypeTask, "todo", "todoitem":
		return schedule.TypeTask
	case schedule.TypeEvent, "meeting", "activity":
		return schedule.TypeEvent
	case schedule.TypeReminder, "remind":
		return schedule.TypeReminder
	case schedule.TypeFee, "payment", "money":
		return schedule.TypeFee
	case schedule.TypeExam, "test":
		return schedule.TypeExam
	case schedule.TypeHomework, "assignment", "homework_submission":
		return schedule.TypeHomework
	default:
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
		return schedule.TypeTask
	}
}

func normalizePriority(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case schedule.PriorityLow, "p3":
		return schedule.PriorityLow
	case schedule.PriorityHigh, "p1", "important":
		return schedule.PriorityHigh
	case schedule.PriorityUrgent, "p0", "critical":
		return schedule.PriorityUrgent
	case schedule.PriorityNormal, "p2", "":
		return schedule.PriorityNormal
	default:
		return schedule.PriorityNormal
	}
}

func normalizeStatus(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case schedule.StatusDone, "completed", "finished":
		return schedule.StatusDone
	case schedule.StatusDismissed, "cancelled", "canceled":
		return schedule.StatusDismissed
	default:
		return schedule.StatusPending
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func truncateRunes(s string, n int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "..."
}
