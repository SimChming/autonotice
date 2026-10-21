package summarize

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
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

// RunOptions tunes a single summarization run.
type RunOptions struct {
	Now         time.Time
	Lookback    time.Duration
	MaxMessages int
	// IgnoreLastSummary makes a manual replan re-read the whole lookback window
	// instead of only the messages since the last successful summary.
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
	since := now.Add(-opts.lookback())
	if state.LastSummaryAt != nil && !opts.IgnoreLastSummary {
		since = *state.LastSummaryAt
	}

	msgs, err := s.store.QueryMessagesForUser(ctx, b.GroupID, b.QQUID, since, opts.maxMessages())
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

	prep := &runPrep{Run: run, Messages: msgs, Now: now, Revision: state.Revision}
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

	incoming, err := parseAIItems(raw, b.GroupID, s.loc)
	if err != nil {
		_ = s.store.FinishSummaryRun(ctx, prep.Run.ID, store.RunFailed, len(prep.Messages), 0, prep.Revision, err.Error())
		return err
	}

	_, err = s.persist(ctx, b, prep, incoming, len(prep.Messages))
	return err
}

// persist bumps the revision, merges the AI items into the stored schedule,
// closes the summary run and returns how many items changed. Shared by the
// scheduled and manual replan paths.
func (s *Service) persist(ctx context.Context, b store.Binding, prep *runPrep, incoming []schedule.Item, msgCount int) (int, error) {
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
	_ = s.store.SetUserDigest(ctx, b.UserID, schedule.Digest(merged))
	if err := s.store.FinishSummaryRun(ctx, prep.Run.ID, store.RunOK, msgCount, len(changed), rev, ""); err != nil {
		s.log.Warn("finish summary run", "err", err)
	}
	s.log.Info("summarized", "user", b.UserID, "qq", b.QQUID, "messages", msgCount, "new_items", len(changed), "revision", rev)
	prep.Revision = rev
	return len(changed), nil
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

type aiResult struct {
	Items []aiItem `json:"items"`
}

// parseAIItems validates the model output and converts it to schedule items.
func parseAIItems(raw json.RawMessage, defaultGroup string, loc *time.Location) ([]schedule.Item, error) {
	var res aiResult
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&res); err != nil {
		// Fall back to lenient decoding before giving up on unknown fields.
		if err2 := json.Unmarshal(raw, &res); err2 != nil {
			return nil, fmt.Errorf("summarize: decode items: %w", err2)
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
	return out, nil
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
