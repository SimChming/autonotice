package summarize

import (
	"fmt"
	"strings"
	"time"

	"github.com/qqsched/server/internal/schedule"
	"github.com/qqsched/server/internal/store"
)

// MessageLine is one aggregated message rendered into the prompt.
type MessageLine struct {
	Time     time.Time
	Sender   string
	QQ       string
	Text     string
	Mentions []string
}

// maxPromptExisting caps how many historical items are injected for dedupe.
// Anything beyond this only lengthens the reasoning chain without changing the
// outcome, so the prompt stays short on purpose.
const maxPromptExisting = 20

// PromptInput carries everything needed to build a summarization prompt.
type PromptInput struct {
	UserName string
	QQ       string
	Now      time.Time
	Existing []schedule.Item
	Messages []MessageLine
}

const summarizerSystemPrompt = `你是大学 QQ 群的日程助理。你的任务是从群聊消息中，抽出与「目标用户」本人相关的
可执行日程/待办/截止时间/缴费/考试/活动信息，输出结构化 JSON 日程。

语言要求：你的全部思考过程（思维链）与最终作答必须使用简体中文，不要使用英文或其它语言。

规则：
- 只保留与该用户明确相关的内容：该用户自己发的任务、别人 @ 他安排给他的任务、回复他的消息里分配的任务、
  明确的公共硬性截止（如全班统一的 DDL、考试时间、班费缴纳截止）。
- 闲聊、表情、与用户无关的他人事务一律忽略。
- 时间能确定就填 due_at（RFC3339，带 +08:00 时区）；只有日期无具体时刻，则把 all_day 置为 true 并填当天 00:00。
- 无法确定时间时 due_at 为 null，不要臆造。
- remind_at 通常留空 null，由客户端按默认策略计算提醒。
- 每条都要给出 source.excerpt（≤80 字引用依据）与 source.message_ids（依据的消息 id）与 source.confidence（0-1）。
- 宁缺毋滥：不确定就不要输出。可以输出空列表。

偏好抽取（preferences）：
- 只有当「目标用户」本人**明确强调**长期偏好或系统级设置时才抽取，例如「以后都叫我…」「记住我…」
  「我的习惯是…」「默认改成…」「以后回复先给结论」。
- 其他同学说的、一次性的临时要求、普通的日程安排，一律不算偏好。
- 最多 3 条，每条 content 是一句不超过 60 字的中文陈述，tags 给 1-3 个关键词。
- 没有就输出空数组。

必须只输出一个 JSON 对象（不要 markdown、不要解释），形如：
{"items":[{"title":"交班费","type":"fee","priority":"high","due_at":"2026-03-01T00:00:00+08:00","remind_at":null,"all_day":true,"notes":"每人 50 元，交生活委员","status":"pending","source":{"kind":"ai","group_id":"123456","message_ids":["1001"],"excerpt":"班费这周内交一下，每人50","confidence":0.9}}],"preferences":[{"content":"以后回复先给结论再补充","tags":["回复风格"]}]}

字段约束：type ∈ {task,event,reminder,fee,exam,homework,other}；priority ∈ {low,normal,high,urgent}；
输出必须包含 "items" 与 "preferences" 字段。`

// BuildSummarizePrompt returns (system, user). The stable prefix (system prompt
// with the schema sample) comes first for prompt-cache friendliness while the
// volatile message body is appended last.
func BuildSummarizePrompt(in PromptInput) (string, string) {
	var b strings.Builder
	b.WriteString("目标用户: ")
	b.WriteString(in.UserName)
	b.WriteString(" (QQ ")
	b.WriteString(in.QQ)
	b.WriteString(")\n")
	b.WriteString("当前时间: ")
	b.WriteString(in.Now.Format(time.RFC3339))
	b.WriteString("\n\n")

	b.WriteString("已知（该用户）历史日程（仅供去重与避免重复生成，不要照抄）：\n")
	// 只列未完成项，且严格限量：历史越长推理越慢，已完成项对去重没有意义。
	listed := 0
	for _, it := range in.Existing {
		if it.Status == "done" {
			continue
		}
		if listed >= maxPromptExisting {
			b.WriteString("...（更多省略）\n")
			break
		}
		listed++
		b.WriteString("- [")
		if it.DueAt != nil {
			b.WriteString(it.DueAt.Format(time.RFC3339))
		} else {
			b.WriteString("无时间")
		}
		b.WriteString("] ")
		b.WriteString(it.Title)
		b.WriteString("\n")
	}
	if listed == 0 {
		b.WriteString("（无）\n")
	}

	b.WriteString("\n待分析的群聊消息（按时间升序，格式：时间 | 发送者(QQ) | 内容）：\n")
	b.WriteString("<messages>\n")
	if len(in.Messages) == 0 {
		b.WriteString("（无）\n")
	} else {
		for _, m := range in.Messages {
			b.WriteString(m.Time.Format("01-02 15:04"))
			b.WriteString(" | ")
			b.WriteString(m.Sender)
			b.WriteString("(")
			b.WriteString(m.QQ)
			b.WriteString(") | ")
			b.WriteString(normalizeLine(m.Text))
			b.WriteString("\n")
		}
	}
	b.WriteString("</messages>\n")
	b.WriteString("\n请依据以上消息输出 JSON（思考过程与作答一律使用简体中文）。")
	return summarizerSystemPrompt, b.String()
}

// MessageLinesFromRecords renders stored messages into prompt lines.
func MessageLinesFromRecords(msgs []store.Message, limit int) []MessageLine {
	out := make([]MessageLine, 0, len(msgs))
	for i, m := range msgs {
		if limit > 0 && i >= limit {
			break
		}
		name := m.SenderName
		if name == "" {
			name = m.SenderQQ
		}
		out = append(out, MessageLine{
			Time:     m.MsgTime,
			Sender:   name,
			QQ:       m.SenderQQ,
			Text:     m.Text,
			Mentions: m.Mentions,
		})
	}
	return out
}

func normalizeLine(s string) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.TrimSpace(s)
	if len(s) > 300 {
		s = s[:300] + "..."
	}
	return s
}

// FormatItemList renders items for prompt reuse in other packages.
func FormatItemList(items []schedule.Item) string {
	var b strings.Builder
	for _, it := range items {
		fmt.Fprintf(&b, "- [%s] %s\n", it.Status, it.Title)
	}
	return b.String()
}
