// Package bot implements the in-chat command controller: it answers when the
// robot is @-mentioned in a group (or on any private message), speaks in the
// 「鲸鱼娘顽皮女仆」persona, and — for the single authorized QQ only — executes
// shell commands on the host through a stateful session.
package bot

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/qqsched/server/internal/contentfetch/docparse"
	"github.com/qqsched/server/internal/docs"
	"github.com/qqsched/server/internal/memory"
	"github.com/qqsched/server/internal/onebot"
	"github.com/qqsched/server/internal/settings"
	"github.com/qqsched/server/internal/shellctl"
	"github.com/qqsched/server/internal/store"
	"github.com/qqsched/server/internal/summarize"
)

// Config tunes the controller.
type Config struct {
	Enabled         bool
	ControlQQ       string
	SelfQQ          string
	Prefixes        []string
	MaxIterations   int
	OutputLimit     int
	HistoryTurns    int
	PersonaOverride string
	MemoryTopN      int
}

func (c Config) normalized() Config {
	if len(c.Prefixes) == 0 {
		c.Prefixes = []string{"/sh", "shell"}
	}
	if c.MaxIterations <= 0 {
		c.MaxIterations = 6
	}
	if c.OutputLimit <= 0 {
		c.OutputLimit = 3500
	}
	if c.HistoryTurns <= 0 {
		c.HistoryTurns = 12
	}
	if c.MemoryTopN < 0 {
		c.MemoryTopN = 0
	}
	if c.MemoryTopN == 0 {
		c.MemoryTopN = 5
	}
	c.ControlQQ = strings.TrimSpace(c.ControlQQ)
	c.SelfQQ = strings.TrimSpace(c.SelfQQ)
	return c
}

// Service consumes chat messages and replies on behalf of the robot.
type Service struct {
	cfg      Config
	api      onebot.APICaller
	sh       *shellctl.Manager
	llm      *summarize.Client
	mem      *memory.Service
	settings *settings.Store
	docs     *docs.Service
	log      *slog.Logger
	hist     *history
	rate     *limiter
	seq      atomic.Uint64
}

// New builds the bot controller. runtime and docSvc may be nil in tests.
func New(cfg Config, api onebot.APICaller, sh *shellctl.Manager, llm *summarize.Client, mem *memory.Service, runtime *settings.Store, docSvc *docs.Service, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	cfg = cfg.normalized()
	return &Service{
		cfg:      cfg,
		api:      api,
		sh:       sh,
		llm:      llm,
		mem:      mem,
		settings: runtime,
		docs:     docSvc,
		log:      log,
		hist:     newHistory(2*time.Hour, cfg.HistoryTurns),
		rate:     newLimiter(),
	}
}

var shellIntentWords = []string{
	"shell", "终端", "命令", "执行", "运行", "root", "cmd", "sudo", "bash", "sh脚本",
	"重启服务", "安装", "部署", "服务器", "脚本", "权限",
}

// HandleMessage decides whether to answer and how. Persona chat is open to
// everyone who @-mentions the robot (or private-messages it); only ControlQQ may
// ever reach the host shell.
func (s *Service) HandleMessage(ctx context.Context, ev onebot.Event) error {
	if s == nil || !s.cfg.Enabled || s.api == nil {
		return nil
	}
	if ev.Kind != onebot.KindMessage {
		return nil
	}
	// Never react to our own messages (prevents loops).
	if ev.UserID == "" || (ev.SelfID != "" && ev.UserID == ev.SelfID) {
		return nil
	}
	text := cleanText(ev.Text)
	images := s.imageURLs(ctx, ev)
	if ev.IsGroup() {
		if ev.GroupID == "" || !mentioned(ev, s.selfIDs(ev)) {
			return nil
		}
	} else if text == "" && len(images) == 0 {
		return nil
	}

	authorized := s.isOwner(ev.UserID)
	command, hasPrefix := s.stripPrefix(text)

	// The host shell is reserved for owner QQs: a prefix command from anyone
	// else — and even a plain "give me root" request — only earns a playful
	// refusal, and never spends model tokens.
	if hasPrefix {
		if authorized {
			return s.runCommand(ctx, ev, command)
		}
		return s.send(ctx, ev, s.refusal())
	}
	if !authorized && looksLikeShellIntent(text) {
		return s.send(ctx, ev, s.refusal())
	}
	// Private chats get a per-user model budget — except the master
	// (ControlQQ), who is never throttled. Over quota the bot answers with a
	// canned line and never calls DeepSeek, saving tokens.
	if !ev.IsGroup() && !authorized && !s.rate.allow("dm:"+ev.UserID) {
		return s.send(ctx, ev, s.quotaReply())
	}
	return s.chat(ctx, ev, text, images, authorized)
}

// imageURLs 提取消息里的图片地址。NapCat 一般在 image 段直接给 url；
// 若只有 file，则调用 get_image 兜底换取可访问链接。
func (s *Service) imageURLs(ctx context.Context, ev onebot.Event) []string {
	out := make([]string, 0, 2)
	for _, seg := range ev.Segments {
		if seg.Type != "image" {
			continue
		}
		if u := seg.Str("url"); u != "" {
			out = append(out, s.imageDataURL(ctx, u))
			continue
		}
		file := seg.Str("file")
		if file == "" || s.api == nil {
			continue
		}
		callCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		raw, err := s.api.CallAction(callCtx, "get_image", map[string]any{"file": file})
		cancel()
		if err != nil {
			continue
		}
		var resp struct {
			URL string `json:"url"`
		}
		if json.Unmarshal(raw, &resp) == nil && resp.URL != "" {
			out = append(out, s.imageDataURL(ctx, resp.URL))
		}
	}
	return out
}

// maxImageBytes 限制单张图片体积，避免把超大图塞进模型请求。
const maxImageBytes = 6 << 20

// imageDataURL 把图片下载成 data URI：QQ 图床直链有时对服务端 IP 不友好，
// 转成 base64 后视觉模型必然能读到；下载失败则退回原链接。
func (s *Service) imageDataURL(ctx context.Context, raw string) string {
	if raw == "" {
		return ""
	}
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, raw, nil)
	if err != nil {
		return raw
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		s.log.Warn("image download failed, fall back to url", "err", err)
		return raw
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return raw
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxImageBytes))
	if err != nil || len(body) == 0 {
		return raw
	}
	mime := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(mime, "image/") {
		mime = "image/jpeg"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(body)
}

// selfIDs lists the robot's own QQ numbers used for @-detection. OneBot v11
// always reports self_id; SelfQQ is an extra fallback for adapters that omit it.
func (s *Service) selfIDs(ev onebot.Event) []string {
	ids := make([]string, 0, 2)
	if ev.SelfID != "" {
		ids = append(ids, ev.SelfID)
	}
	if s.cfg.SelfQQ != "" && s.cfg.SelfQQ != ev.SelfID {
		ids = append(ids, s.cfg.SelfQQ)
	}
	return ids
}

var cqCodeRe = regexp.MustCompile(`\[CQ:[^\]]*\]`)

// cleanText strips CQ codes so "@机器人 /sh ls" becomes "/sh ls" — without this
// the leading [CQ:at,qq=…] would break prefix and intent detection.
func cleanText(s string) string {
	if s == "" {
		return ""
	}
	return strings.TrimSpace(cqCodeRe.ReplaceAllString(s, " "))
}

// mentioned reports whether the robot was @-ed. It checks the parsed mention
// list first and then falls back to scanning the raw CQ payload, because some
// adapters report `message` as a CQ-code string instead of a segment array.
func mentioned(ev onebot.Event, selfIDs []string) bool {
	for _, id := range selfIDs {
		if id == "" {
			continue
		}
		for _, m := range ev.Mentions {
			if m == id {
				return true
			}
		}
		needle := "[CQ:at,qq=" + id + "]"
		if strings.Contains(ev.RawMessage, needle) || strings.Contains(ev.Text, needle) {
			return true
		}
	}
	return false
}

// sessionKey scopes shell state: one shell per group, one per private chat.
func (s *Service) sessionKey(ev onebot.Event) string {
	if ev.IsGroup() && ev.GroupID != "" {
		return "group:" + ev.GroupID
	}
	return "private:" + ev.UserID
}

func (s *Service) stripPrefix(text string) (string, bool) {
	lower := strings.ToLower(strings.TrimSpace(text))
	for _, p := range s.cfg.Prefixes {
		if p == "" {
			continue
		}
		if strings.HasPrefix(lower, strings.ToLower(p)) {
			return strings.TrimSpace(text[len(p):]), true
		}
	}
	return "", false
}

func looksLikeShellIntent(text string) bool {
	lower := strings.ToLower(text)
	if lower == "" {
		return false
	}
	for _, w := range shellIntentWords {
		if strings.Contains(lower, strings.ToLower(w)) {
			return true
		}
	}
	return false
}

func mentions(list []string, selfID string) bool {
	if selfID == "" {
		return false
	}
	for _, m := range list {
		if m == selfID {
			return true
		}
	}
	return false
}

// --- shell ---

func (s *Service) runCommand(ctx context.Context, ev onebot.Event, command string) error {
	cmd := strings.TrimSpace(command)
	key := s.sessionKey(ev)

	switch strings.ToLower(cmd) {
	case "":
		return s.send(ctx, ev, "🐋 主人想跑什么命令呀？把命令写在 "+s.cfg.Prefixes[0]+" 后面就好啦～")
	case "reset", "exit", "restart", "重来", "重置":
		s.sh.Reset(key)
		return s.send(ctx, ev, "🐋 会话已经重置啦，环境干干净净～(๑•̀ㅂ•́)و")
	}

	cmdCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	out, code, err := s.sh.Run(cmdCtx, key, cmd)
	if errors.Is(err, shellctl.ErrTimeout) {
		return s.send(ctx, ev, "🐋 呜…这条命令跑太久啦，鲸鱼娘先把它掐掉了（超时 60s）")
	}
	if err != nil {
		s.log.Warn("shell command failed", "key", key, "cmd", cmd, "err", err)
		return s.send(ctx, ev, "🐋 糟了，鲸鱼娘的手滑了一下，命令没跑起来喵…（"+truncateRunes(err.Error(), 120)+"）")
	}

	body := strings.TrimRight(out, "\n")
	if strings.TrimSpace(body) == "" {
		body = "（没有输出喵~）"
	}
	body = truncateRunes(body, s.cfg.OutputLimit)
	header := fmt.Sprintf("🐋 主人~ 命令跑完啦（exit %d）", code)
	return s.send(ctx, ev, header+"\n"+body)
}

// --- persona chat ---

type aiMemory struct {
	Content string   `json:"content"`
	Tags    []string `json:"tags"`
}

// aiAPI is a model-emitted OneBot action call (any NapCat v11 action).
type aiAPI struct {
	Action string         `json:"action"`
	Params map[string]any `json:"params"`
}

// aiDoc is a model-emitted document request/collection step.
type aiDoc struct {
	Action    string         `json:"action"`
	Type      string         `json:"type"`
	Title     string         `json:"title"`
	Sections  []docs.Section `json:"sections"`
	Rows      [][]string     `json:"rows"`
	Questions []string       `json:"questions"`
}

type aiReply struct {
	Reply     string    `json:"reply"`
	Command   *string   `json:"command"`
	API       *aiAPI    `json:"api"`
	Memory    *aiMemory `json:"memory"`
	Followups []string  `json:"followups"`
	Doc       *aiDoc    `json:"doc"`
}

// chat runs the persona conversation. allowShell is false for everyone except
// ControlQQ: the model may still be asked to run something, in which case we
// ignore the command and answer with a playful refusal instead.
func (s *Service) chat(ctx context.Context, ev onebot.Event, text string, images []string, allowShell bool) error {
	key := s.sessionKey(ev)
	if s.llm == nil || !s.llm.Configured() {
		return s.send(ctx, ev, "🐋 呜…主人的鲸鱼脑有点晕，等下再试喵~")
	}

	// Recall relevant fragments from the database first: injecting a few lines
	// of long-term memory keeps the prompt (and the token bill) small.
	memBlock := ""
	if s.mem != nil && s.cfg.MemoryTopN > 0 {
		if frags := s.mem.Recall(ctx, key, ev.UserID, text, s.cfg.MemoryTopN); len(frags) > 0 {
			memBlock = renderMemories(frags)
		}
	}
	draftBlock := s.draftBlock(ctx, key)
	sourceText := s.extractSourceText(ctx, ev)
	capBlock := s.capabilityBlock()

	histText := text
	if histText == "" && len(images) > 0 {
		histText = "[发送了一张图片]"
	}
	turns := s.hist.appendUser(key, ev.UserID, histText)
	final := ""
	var last aiReply
	for i := 0; i < s.cfg.MaxIterations; i++ {
		callCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		prompt := s.buildPrompt(memBlock, turns, ev, allowShell, draftBlock, sourceText, capBlock)
		if len(images) > 0 && i == 0 {
			prompt += "\n【用户刚刚发送了图片，请直接查看图片内容（文字/画面）并据此回答，不要声称自己看不到图片。】"
		}
		// 只有最后一轮（最新消息）才附图片，避免历史轮次重复计费。
		msgImages := images
		if i > 0 {
			msgImages = nil
		}
		raw, err := s.llm.ChatJSONImages(callCtx, systemPrompt(s.cfg.PersonaOverride), prompt, msgImages)
		cancel()
		if err != nil {
			s.log.Warn("bot chat model call failed", "key", key, "err", err)
			break
		}
		var parsed aiReply
		if err := json.Unmarshal(raw, &parsed); err != nil {
			s.log.Warn("bot chat decode failed", "key", key, "err", err)
			break
		}
		last = parsed
		if reply := strings.TrimSpace(parsed.Reply); reply != "" {
			final = reply
		}
		// OneBot action tool-call first: the model can drive any NapCat API
		// (send images, query group info, ...), see the result, and continue.
		if parsed.API != nil && strings.TrimSpace(parsed.API.Action) != "" {
			turns = s.hist.append(key, "tool", s.runOnebotAPI(ctx, parsed.API))
			continue
		}
		cmd := ""
		if parsed.Command != nil {
			cmd = strings.TrimSpace(*parsed.Command)
		}
		if cmd == "" {
			break
		}
		if !allowShell {
			// Strangers never reach the host shell, whatever the model says.
			final = s.refusal()
			break
		}
		cmdCtx, cancel2 := context.WithTimeout(ctx, 60*time.Second)
		out, code, runErr := s.sh.Run(cmdCtx, key, cmd)
		cancel2()
		turns = s.hist.append(key, "tool", toolTurn(cmd, out, code, runErr))
	}

	if last.Doc != nil {
		final = s.handleDoc(ctx, ev, key, last.Doc, final)
	}

	if final == "" {
		final = "🐋 呜…主人的鲸鱼脑有点晕，等下再试喵~"
	}
	s.hist.append(key, "assistant", final)

	// Persist whatever the model judged worth remembering long-term.
	if s.mem != nil && last.Memory != nil {
		content := strings.TrimSpace(last.Memory.Content)
		if content != "" {
			s.mem.Remember(ctx, key, ev.UserID, content, last.Memory.Tags)
		}
	}
	final = sanitizeCQ(final, s.capabilities())
	main, extra := s.followupPlan(ev, final, last.Followups)
	if err := s.send(ctx, ev, main); err != nil {
		return err
	}
	// Detach from the websocket handler: the extra segments sleep between sends,
	// and the event loop must stay free to accept the next message.
	if len(extra) > 0 {
		go s.sendFollowups(context.WithoutCancel(ctx), ev, extra)
	}
	return nil
}

// handleDoc executes a model-emitted document step: collect missing slots
// (multi-turn) or generate and upload the finished file.
func (s *Service) handleDoc(ctx context.Context, ev onebot.Event, key string, d *aiDoc, reply string) string {
	if s.docs == nil {
		return reply
	}
	action := strings.ToLower(strings.TrimSpace(d.Action))
	switch action {
	case "ask":
		typ := strings.ToLower(strings.TrimSpace(d.Type))
		if typ == "" {
			typ = "xlsx"
		}
		if err := s.docs.SaveDraft(ctx, key, typ, d); err != nil {
			s.log.Warn("save doc draft failed", "key", key, "err", err)
		}
		if qs := cleanQuestions(d.Questions); len(qs) > 0 {
			return strings.Join(qs, "\n")
		}
		return reply
	case "create", "":
		// empty action with content still counts as a create request.
		if len(d.Sections) == 0 && len(nonEmptyRows(d.Rows)) == 0 {
			return reply
		}
		return s.createDoc(ctx, ev, key, d, reply)
	default:
		return reply
	}
}

func (s *Service) createDoc(ctx context.Context, ev onebot.Event, key string, d *aiDoc, reply string) string {
	if s.docs == nil {
		return reply
	}
	if count, err := s.docs.TodayCount(ctx, ev.UserID); err == nil && count >= s.docs.Quota() {
		_ = s.docs.ClearDraft(ctx, key)
		return fmt.Sprintf("🐋 今天的文件额度（%d 个）已经用完啦，明天再来找人家做文档嘛～", s.docs.Quota())
	}
	req := docs.Request{
		Type:     d.Type,
		Title:    d.Title,
		Sections: d.Sections,
		Rows:     d.Rows,
		UserQQ:   ev.UserID,
		ChatKey:  key,
	}
	file, err := s.docs.Generate(ctx, req)
	if err != nil && strings.EqualFold(strings.TrimSpace(d.Type), "pdf") {
		// PDF needs an embedded CJK font; degrade to docx instead of failing.
		s.log.Warn("pdf generation failed, falling back to docx", "err", err)
		req.Type = "docx"
		file, err = s.docs.Generate(ctx, req)
		if err == nil {
			reply = strings.TrimSpace(reply) + "（PDF 字体不可用，已经帮你换成 Word 文档啦）"
		}
	}
	if err != nil {
		s.log.Warn("doc generation failed", "key", key, "type", d.Type, "err", err)
		return "🐋 呜…文件没做出来（" + truncateRunes(err.Error(), 80) + "），再试一次好不好嘛"
	}
	if err := s.docs.Send(ctx, s.api, file, ev.GroupID, ev.UserID); err != nil {
		s.log.Warn("doc upload failed", "file", file.ID, "err", err)
		return "🐋 文件做好了，可是上传的时候卡住了…主人等会儿再让我发一次喵（" + truncateRunes(err.Error(), 80) + "）"
	}
	_ = s.docs.ClearDraft(ctx, key)
	if strings.TrimSpace(reply) == "" {
		return "🐋 文件已经发出去啦～「" + file.Filename + "」查收喵 (๑•̀ㅂ•́)و"
	}
	return reply
}

// draftBlock renders the pending document slot state for the prompt.
func (s *Service) draftBlock(ctx context.Context, key string) string {
	if s.docs == nil {
		return ""
	}
	typ, slot, err := s.docs.Draft(ctx, key)
	if err != nil || strings.TrimSpace(slot) == "" {
		return ""
	}
	return "【正在整理的文档草稿】类型=" + typ + "，已收集内容=" + truncateRunes(slot, 1200) + "\n" +
		"信息齐了就输出 doc.action=create；还缺就继续 doc.action=ask 并在 questions 里提问。\n"
}

// extractSourceText downloads documents attached to the triggering message and
// extracts their text, so the model can rebuild them.
func (s *Service) extractSourceText(ctx context.Context, ev onebot.Event) string {
	if s.api == nil || !ev.IsGroup() || ev.GroupID == "" {
		return ""
	}
	var parts []string
	for _, seg := range ev.Segments {
		if seg.Type != "file" {
			continue
		}
		fileID := seg.Str("file_id")
		name := seg.Str("file")
		if fileID == "" {
			continue
		}
		fileURL, err := s.api.GetGroupFileURL(ctx, ev.GroupID, fileID, seg.Int("busid"))
		if err != nil || fileURL == "" {
			s.log.Warn("group file url lookup failed", "file_id", fileID, "err", err)
			continue
		}
		text, err := fetchAndParseDoc(ctx, fileURL, name)
		if err != nil {
			s.log.Warn("group file parse failed", "name", name, "err", err)
			continue
		}
		parts = append(parts, "【用户上传的文档："+name+"】\n"+truncateRunes(text, 6000))
	}
	return strings.Join(parts, "\n\n")
}

var docFetchClient = &http.Client{Timeout: 30 * time.Second}

func fetchAndParseDoc(ctx context.Context, url, name string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := docFetchClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("download status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 15<<20))
	if err != nil {
		return "", err
	}
	return docparse.ParseBytes(ctx, name, "", data)
}

func cleanQuestions(qs []string) []string {
	out := make([]string, 0, len(qs))
	for _, q := range qs {
		if q = strings.TrimSpace(q); q != "" {
			out = append(out, q)
		}
	}
	return out
}

func nonEmptyRows(rows [][]string) [][]string {
	out := make([][]string, 0, len(rows))
	for _, r := range rows {
		if strings.TrimSpace(strings.Join(r, "")) != "" {
			out = append(out, r)
		}
	}
	return out
}

// renderMemories formats recalled fragments as a compact prompt block.
func renderMemories(frags []store.Memory) string {
	var b strings.Builder
	for _, m := range frags {
		b.WriteString("- " + m.CreatedAt.Format("2006-01-02") + " ")
		if m.Tags != "" {
			b.WriteString("[" + m.Tags + "] ")
		}
		b.WriteString(truncateRunes(m.Content, 120) + "\n")
	}
	return b.String()
}

// runOnebotAPI executes a model-emitted OneBot action and formats the result
// as a tool turn. The model never talks to NapCat directly — only through us.
func (s *Service) runOnebotAPI(ctx context.Context, call *aiAPI) string {
	action := strings.TrimSpace(call.Action)
	if action == "" {
		return "错误: api.action 为空"
	}
	if s.api == nil {
		return "错误: OneBot 连接不可用"
	}
	if blocked, label := s.blockedAction(action, call.Params); blocked {
		return "该能力已被管理员关闭（" + label + "），请改用文字回复或告诉对方这个功能暂时不可用。"
	}
	apiCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	params := call.Params
	data, err := s.api.CallAction(apiCtx, action, params)
	if err != nil {
		return "接口 " + action + " 调用失败: " + truncateRunes(err.Error(), 300)
	}
	if len(data) == 0 || string(data) == "null" {
		return "接口 " + action + " 调用成功（无返回数据）"
	}
	return "接口 " + action + " 返回:\n" + truncateRunes(string(data), 2000)
}

// quotaReply is the canned answer when a private-chat user exhausts their
// DeepSeek budget — playful, zero model tokens.
func (s *Service) quotaReply() string {
	n := s.seq.Add(1)
	if n%2 == 0 {
		return "🐋 呜…小鲸的脑子被主人限了量，每 5 分钟只能认真想 3 件事，过会儿再来找人家玩喵~ (｡•̀ᴗ-)✧"
	}
	return "🐋 鲸鱼脑过热保护中…额度 5 分钟后恢复，先去喝口水嘛 >ᴗ<"
}

func toolTurn(cmd, out string, code int, err error) string {
	var b strings.Builder
	b.WriteString("命令: " + cmd + "\n")
	if errors.Is(err, shellctl.ErrTimeout) {
		b.WriteString("结果: 超时(60s)，会话已重置\n")
		return b.String()
	}
	b.WriteString(fmt.Sprintf("退出码: %d\n", code))
	body := strings.TrimSpace(out)
	if body == "" {
		body = "(无输出)"
	}
	b.WriteString("输出:\n" + truncateRunes(body, 2000))
	return b.String()
}

func (s *Service) buildPrompt(memBlock string, turns []turn, ev onebot.Event, allowShell bool, draftBlock, sourceText, capBlock string) string {
	var b strings.Builder
	// Tell the model exactly who it is talking to: in a group session the
	// history mixes master and classmates, so an explicit identity line is the
	// only reliable way to keep "主人" reserved for ControlQQ.
	if allowShell {
		b.WriteString("【当前对话对象】QQ=" + ev.UserID + "，身份=主人（你的服务器管理员，可以执行 shell）\n\n")
	} else {
		b.WriteString("【当前对话对象】QQ=" + ev.UserID + "，身份=普通同学（不是主人，没有 shell 权限）\n\n")
	}
	if memBlock != "" {
		b.WriteString("【相关记忆碎片（来自数据库，供参考，不必逐条复述）】\n")
		b.WriteString(memBlock)
		b.WriteString("\n")
	}
	if draftBlock != "" {
		b.WriteString(draftBlock)
	}
	if sourceText != "" {
		b.WriteString("【用户上传的参考文档内容（已提取文本）】\n")
		b.WriteString(sourceText)
		b.WriteString("\n")
	}
	if capBlock != "" {
		b.WriteString(capBlock)
	}
	b.WriteString("以下是最近的对话记录（按时间顺序，最早的在前）：\n")
	if len(turns) == 0 {
		b.WriteString("(无)\n")
	}
	for _, t := range turns {
		switch t.role {
		case "user":
			b.WriteString(s.userLabel(t.sender) + ": " + t.text + "\n")
		case "assistant":
			b.WriteString("鲸鱼娘: " + t.text + "\n")
		case "tool":
			b.WriteString("[命令结果]\n" + t.text + "\n")
		}
	}
	if !allowShell {
		b.WriteString("\n注意：当前对话者不是主人，你没有 shell 权限，command 必须为 null。")
		b.WriteString("如果对方要求执行命令或要权限，就用调皮的话拒绝他。\n")
	}
	b.WriteString("\n请根据以上记录回复对方最新的一条消息，只输出约定的那个 JSON 对象。")
	return b.String()
}

// userLabel renders a history speaker tag: only owner QQs are 主人, everyone
// else is a classmate identified by QQ number.
func (s *Service) userLabel(sender string) string {
	if s.isOwner(sender) {
		return "主人"
	}
	if sender == "" {
		return "同学"
	}
	return "同学(QQ" + sender + ")"
}

// isOwner reports whether a QQ carries 主人 privileges (built-in control QQ or
// an entry from the admin-maintained owner list).
func (s *Service) isOwner(qq string) bool {
	if qq == "" {
		return false
	}
	if s.cfg.ControlQQ != "" && qq == s.cfg.ControlQQ {
		return true
	}
	if s.settings != nil {
		for _, o := range s.settings.Snapshot().OwnerQQs {
			if o == qq {
				return true
			}
		}
	}
	return false
}

// --- replies ---

func (s *Service) refusal() string {
	n := s.seq.Add(1)
	if n%2 == 0 {
		return "嘻嘻～shell 是鲸鱼娘的专属小玩具，只有主人能碰哦，你去旁边玩沙沙吧～ (｡•̀ᴗ-)✧"
	}
	return "呜哇！想抢鲸鱼娘的命令按钮？不行不行～你没有权限啦，略略略～ >ᴗ<"
}

// send replies to the originating chat, splitting long payloads into several
// messages so nothing is silently dropped by the client.
func (s *Service) send(ctx context.Context, ev onebot.Event, text string) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	group := ev.IsGroup() && ev.GroupID != ""
	var lastErr error
	for _, chunk := range chunkRunes(text, 1500) {
		body := chunk
		if group {
			body = fmt.Sprintf("[CQ:at,qq=%s] %s", ev.UserID, chunk)
		}
		var err error
		sendCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		if group {
			_, err = s.api.SendGroupMsg(sendCtx, ev.GroupID, body)
		} else {
			_, err = s.api.SendPrivateMsg(sendCtx, ev.UserID, body)
		}
		cancel()
		if err != nil {
			s.log.Warn("bot send failed", "group", ev.GroupID, "user", ev.UserID, "err", err)
			lastErr = err
		}
	}
	return lastErr
}

// capabilities returns the current media gates (all open when no runtime store
// is wired, which keeps tests and embeddings simple).
func (s *Service) capabilities() settings.Capabilities {
	if s.settings == nil {
		return settings.DefaultCapabilities()
	}
	return s.settings.Snapshot().Capabilities
}

// capabilityBlock tells the model which media categories are currently banned.
func (s *Service) capabilityBlock() string {
	c := s.capabilities()
	var off []string
	if !c.Image {
		off = append(off, "图片")
	}
	if !c.Sticker {
		off = append(off, "表情")
	}
	if !c.Voice {
		off = append(off, "语音")
	}
	if !c.Video {
		off = append(off, "视频")
	}
	if !c.File {
		off = append(off, "文件")
	}
	if !c.Recall {
		off = append(off, "撤回")
	}
	if !c.AtAll {
		off = append(off, "@全体成员")
	}
	if len(off) == 0 {
		return ""
	}
	return "【管理员已关闭的能力】" + strings.Join(off, "、") + "。不要尝试通过 api 调用或 CQ 码发送这些内容。\n"
}

// followupPlan decides whether the answer should be split into several chat
// messages. It returns the (possibly shortened) main reply plus the extra
// segments to send afterwards. When auto-segment is on but the model returned no
// followups, a long multi-sentence reply is split locally so the feature still
// takes effect.
func (s *Service) followupPlan(ev onebot.Event, reply string, parts []string) (string, []string) {
	if s.settings == nil {
		return reply, nil
	}
	seg := s.settings.Snapshot().AutoSegment
	if !seg.Enabled || !followupTarget(seg, ev.UserID, s.isOwner(ev.UserID)) {
		return reply, nil
	}
	clean := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			clean = append(clean, p)
		}
	}
	if len(clean) == 0 {
		all := autoSplit(reply, seg.MaxSegments+1)
		if len(all) < 2 {
			return reply, nil
		}
		reply, clean = all[0], all[1:]
	}
	if len(clean) > seg.MaxSegments {
		clean = clean[:seg.MaxSegments]
	}
	return reply, clean
}

// followupTarget reports whether this chat partner may receive extra segments.
func followupTarget(seg settings.AutoSegment, userID string, owner bool) bool {
	for _, t := range seg.Targets {
		t = strings.TrimSpace(t)
		if t == "owner" && owner {
			return true
		}
		if t != "" && t == userID {
			return true
		}
	}
	return false
}

// autoSplit breaks a long reply into at most maxParts short messages at
// sentence/newline boundaries. Short or single-sentence replies stay untouched.
func autoSplit(reply string, maxParts int) []string {
	if maxParts < 2 || len([]rune(strings.TrimSpace(reply))) < 60 {
		return nil
	}
	var (
		out []string
		cur []rune
	)
	flush := func() {
		if s := strings.TrimSpace(string(cur)); s != "" {
			out = append(out, s)
		}
		cur = cur[:0]
	}
	for _, r := range reply {
		cur = append(cur, r)
		switch r {
		case '\n', '。', '！', '？', '!', '?', '～':
			flush()
		}
	}
	flush()
	if len(out) < 2 {
		return nil
	}
	// Merge very short fragments (e.g. "好呀。") into the previous segment.
	merged := make([]string, 0, len(out))
	for _, p := range out {
		if n := len(merged); n > 0 && len([]rune(p)) < 12 {
			merged[n-1] += p
			continue
		}
		merged = append(merged, p)
	}
	if len(merged) < 2 {
		return nil
	}
	if len(merged) > maxParts {
		merged = merged[:maxParts]
	}
	return merged
}

// sendFollowups delivers extra segments with a randomized delay. It is called in
// a detached goroutine, so a cancelled websocket context never cuts it short.
func (s *Service) sendFollowups(ctx context.Context, ev onebot.Event, parts []string) {
	if len(parts) == 0 || s.settings == nil || s.api == nil {
		return
	}
	seg := s.settings.Snapshot().AutoSegment
	if !seg.Enabled || !followupTarget(seg, ev.UserID, s.isOwner(ev.UserID)) {
		return
	}
	minDelay, maxDelay := seg.MinDelayMS, seg.MaxDelayMS
	if minDelay < 0 {
		minDelay = 0
	}
	if maxDelay < minDelay {
		maxDelay = minDelay
	}
	caps := s.capabilities()
	sent := 0
	for i, part := range parts {
		if sent >= seg.MaxSegments {
			return
		}
		if i+2 < seg.StartIndex {
			continue
		}
		part = strings.TrimSpace(sanitizeCQ(part, caps))
		if part == "" {
			continue
		}
		delay := time.Duration(minDelay) * time.Millisecond
		if maxDelay > minDelay {
			delay += time.Duration(rand.Intn(maxDelay-minDelay+1)) * time.Millisecond
		}
		if delay > 0 {
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
		if err := s.send(ctx, ev, part); err != nil {
			return
		}
		sent++
	}
}

func truncateRunes(s string, n int) string {
	if n <= 0 {
		return s
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "\n…（输出过长，已截断）"
}

func chunkRunes(s string, size int) []string {
	if size <= 0 {
		return []string{s}
	}
	r := []rune(s)
	if len(r) <= size {
		return []string{s}
	}
	var out []string
	for i := 0; i < len(r); i += size {
		end := i + size
		if end > len(r) {
			end = len(r)
		}
		out = append(out, string(r[i:end]))
	}
	return out
}
