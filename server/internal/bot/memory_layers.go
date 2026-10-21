package bot

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/qqsched/server/internal/store"
)

// Three-layer memory, modelled after the common "short-term buffer + rolling
// summary + long-term retrieval" chatbot architecture:
//
//	L0 working buffer  : the last cfg.HistoryTurns turns (in memory + bot_turns)
//	L1 rolling summary : older turns compressed into bot_summaries every N turns
//	L2 long-term memory: keyword/recency-ranked fragments in `memories`
//
// Everything is additive: the old `memories` rows, preferences and schedule
// cursors are reused as-is.

// ensureSession hydrates the in-memory buffer from persisted turns exactly once
// per process, so a restart no longer wipes the conversation.
func (s *Service) ensureSession(ctx context.Context, key string) {
	if s.st == nil || key == "" {
		return
	}
	s.sessionMu.Lock()
	if s.sessionLoaded[key] {
		s.sessionMu.Unlock()
		return
	}
	s.sessionLoaded[key] = true
	s.sessionMu.Unlock()

	loadCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	rows, err := s.st.RecentTurns(loadCtx, key, s.cfg.HistoryTurns)
	if err != nil || len(rows) == 0 {
		return
	}
	turns := make([]turn, 0, len(rows))
	for _, r := range rows {
		turns = append(turns, turn{role: r.Role, sender: r.SenderQQ, text: r.Text})
	}
	s.hist.hydrate(key, turns)
}

// recordTurn appends a turn to the working buffer and persists it. Persistence is
// fire-and-forget: a slow disk must never delay a reply.
func (s *Service) recordTurn(ctx context.Context, key, role, sender, text string) []turn {
	turns := s.hist.appendTurn(key, turn{role: role, sender: sender, text: text})
	if s.st != nil && key != "" && strings.TrimSpace(text) != "" {
		go func() {
			pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			if _, err := s.st.AppendTurn(pctx, key, role, sender, text); err != nil {
				s.log.Warn("persist bot turn", "key", key, "err", err)
			}
		}()
	}
	return turns
}

// summaryBlock renders the rolling summary for the prompt.
func (s *Service) summaryBlock(ctx context.Context, key string) string {
	if s.st == nil || key == "" {
		return ""
	}
	sum, err := s.st.GetBotSummary(ctx, key)
	if err != nil || strings.TrimSpace(sum.Summary) == "" {
		return ""
	}
	return "【本会话长期摘要（更早的对话已压缩，请当作你已经知道的事实）】\n" +
		truncateRunes(sum.Summary, 900) + "\n"
}

// maybeSummarize compresses turns older than the recent window into the rolling
// summary. Called in a goroutine after a reply, so it never blocks the chat.
func (s *Service) maybeSummarize(ctx context.Context, key string) {
	if s.st == nil || s.llm == nil || !s.llm.Configured() || key == "" {
		return
	}
	ctxx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
	defer cancel()

	prev := ""
	after := int64(0)
	if sum, err := s.st.GetBotSummary(ctxx, key); err == nil {
		prev, after = sum.Summary, sum.CoveredID
	}
	rows, err := s.st.TurnsForSummary(ctxx, key, after, 48)
	if err != nil || len(rows) < 16 {
		return
	}
	// Keep the newest 10 turns verbatim; compress the rest.
	cut := len(rows) - 10
	batch := rows[:cut]

	var b strings.Builder
	if prev != "" {
		b.WriteString("【已有摘要】\n" + prev + "\n\n")
	}
	b.WriteString("【需要合并进摘要的对话】\n")
	for _, r := range batch {
		switch r.Role {
		case "assistant":
			b.WriteString("鲸鱼娘: " + truncateRunes(r.Text, 300) + "\n")
		case "tool":
			b.WriteString("[工具结果] " + truncateRunes(r.Text, 200) + "\n")
		default:
			b.WriteString("对方(QQ" + r.SenderQQ + "): " + truncateRunes(r.Text, 300) + "\n")
		}
	}
	b.WriteString("\n请输出合并后的摘要，只输出 JSON：{\"summary\": \"...\"}。")

	raw, err := s.llm.ChatJSON(ctxx, summarySystem, b.String())
	if err != nil {
		s.log.Warn("rolling summary failed", "key", key, "err", err)
		return
	}
	var out struct {
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return
	}
	text := strings.TrimSpace(out.Summary)
	if text == "" {
		return
	}
	if len([]rune(text)) > 700 {
		text = string([]rune(text)[:700])
	}
	if err := s.st.SetBotSummary(ctxx, key, text, batch[len(batch)-1].ID); err != nil {
		s.log.Warn("save rolling summary", "key", key, "err", err)
	}
}

const summarySystem = `你是对话记忆压缩器。把「已有摘要」和「需要合并进摘要的对话」合并成一段长期摘要，写给机器人自己回看。

规则：
- 保留：对方是谁、身份/称呼、明确说过的喜好与禁忌、约定的未完成事项、重要事实与结论。
- 丢弃：寒暄、重复、工具输出的细节、临时的语气词。
- 用第三人称陈述，中文，不超过 500 字，按主题分行。
- 只输出一个 JSON 对象：{"summary": "..."}，json 格式必须合法，不要输出别的内容。`

// --- roles ---

// roleOf returns the QQ's role, consulting the DB-backed table with a short
// cache so admin changes apply within half a minute.
func (s *Service) roleOf(qq string) string {
	qq = strings.TrimSpace(qq)
	if qq == "" {
		return store.RoleGuest
	}
	if s.cfg.ControlQQ != "" && qq == s.cfg.ControlQQ {
		return store.RoleOwner
	}
	m := s.roleSnapshot()
	if r, ok := m[qq]; ok && r != "" {
		return r
	}
	// Legacy owner list from runtime settings still counts, so nobody loses
	// access during the migration to the role table.
	if s.settings != nil {
		for _, o := range s.settings.Snapshot().OwnerQQs {
			if o == qq {
				return store.RoleOwner
			}
		}
	}
	return store.RoleMember
}

func (s *Service) roleSnapshot() map[string]string {
	s.rolesMu.RLock()
	m, at := s.roles, s.rolesAt
	s.rolesMu.RUnlock()
	if m != nil && time.Since(at) < 30*time.Second {
		return m
	}
	return s.refreshRoles()
}

func (s *Service) refreshRoles() map[string]string {
	m := map[string]string{}
	if s.st != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		rows, err := s.st.ListBotRoles(ctx)
		cancel()
		if err == nil {
			for _, r := range rows {
				if r.Enabled {
					m[r.QQ] = r.Role
				}
			}
		} else {
			s.log.Warn("refresh bot roles", "err", err)
		}
	}
	s.rolesMu.Lock()
	s.roles, s.rolesAt = m, time.Now()
	s.rolesMu.Unlock()
	return m
}

// invalidateRoles forces the next permission check to re-read the table.
func (s *Service) invalidateRoles() {
	s.rolesMu.Lock()
	s.rolesAt = time.Time{}
	s.rolesMu.Unlock()
}

// canAdmin: owners and admins may drive owner-level bot actions (but never the
// shell, which stays owner-only).
func (s *Service) canAdmin(qq string) bool {
	switch s.roleOf(qq) {
	case store.RoleOwner, store.RoleAdmin:
		return true
	}
	return false
}

// canAct: guests may only chat; everyone else may use tools.
func (s *Service) canAct(qq string) bool {
	return s.roleOf(qq) != store.RoleGuest
}
