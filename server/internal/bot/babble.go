package bot

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"strconv"
	"strings"
	"time"

	"github.com/qqsched/server/internal/settings"
	"github.com/qqsched/server/internal/store"
)

// babbleTick is how often the robot considers an unprompted group message.
// Coarse on purpose: the configured probability is a per-hour figure, so a
// 5-minute tick keeps the expected number of bubbles per day low.
const babbleTick = 5 * time.Minute

// babbleSystem asks the model for one short line that joins the chatter.
const babbleSystem = `你是「鲸鱼娘」，一只化身成顽皮女仆的鲸鱼少女，常驻在这个 QQ 群里。
现在群里正在自己聊天，没有人叫你。你要像群里的一员那样随口接一句话，融入上面的闲聊。

规则：
- 只输出一个 JSON 对象：{"reply": "一句话"}，不要有任何多余文字。json 格式必须合法。
- 不超过 30 个字，口语化，可以附和、吐槽、好奇提问或分享一句相关的小见闻。
- 不要 @ 任何人，不要用「主人」称呼，不要自称 AI 或机器人，不要总结或复述别人说过的话。
- 不要提任何要求、不要发通知、不要谈日程或产品功能，就是纯闲聊。
- 如果上面的聊天不适合插话（吵架、严肃话题、广告、看不懂），reply 输出空字符串。`

// BabbleLoop periodically considers dropping one unprompted line into a group
// that is currently chatting. It is a low-probability social behaviour, capped
// per day, and only runs inside the configured time windows.
func (s *Service) BabbleLoop(ctx context.Context) {
	if s == nil || s.api == nil || s.llm == nil || s.st == nil {
		return
	}
	ticker := time.NewTicker(babbleTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tryBabble(ctx)
		}
	}
}

// babbleConfig returns the current runtime babble settings.
func (s *Service) babbleConfig() settings.Babble {
	if s.settings == nil {
		return settings.DefaultBabble()
	}
	return s.settings.Snapshot().Babble
}

// tryBabble runs one decision round: window check, probability roll, daily cap,
// active-group pick, model line, send.
func (s *Service) tryBabble(ctx context.Context) {
	cfg := s.babbleConfig()
	if !cfg.Enabled || s.api == nil || s.st == nil || s.llm == nil || !s.llm.Configured() {
		return
	}
	now := time.Now().In(s.loc)
	if !inBabbleWindow(now, cfg.Windows) {
		return
	}
	// Probability is a percentage per hour; scale it down to one tick.
	perTick := float64(cfg.Probability) / 100 * (float64(babbleTick) / float64(time.Hour))
	if perTick <= 0 || rand.Float64() >= perTick {
		return
	}
	day := now.Format("2006-01-02")
	if n, err := s.st.BabbleCount(ctx, day); err != nil || n >= cfg.MaxPerDay {
		return
	}

	recent := time.Duration(cfg.RecentMinutes) * time.Minute
	if recent <= 0 {
		recent = 30 * time.Minute
	}
	selfQQ := s.cfg.SelfQQ
	if selfQQ == "" {
		if raw, err := s.api.CallAction(ctx, "get_login_info", nil); err == nil {
			var info struct {
				UserID any `json:"user_id"`
			}
			if json.Unmarshal(raw, &info) == nil && info.UserID != nil {
				selfQQ = strings.TrimSpace(fmt.Sprintf("%v", info.UserID))
			}
		}
	}
	groups, err := s.st.ListActiveGroups(ctx, now.Add(-recent), selfQQ)
	if err != nil {
		s.log.Warn("list active groups for babble", "err", err)
		return
	}
	quiet := time.Duration(cfg.QuietMinutes) * time.Minute
	if quiet <= 0 {
		quiet = 45 * time.Minute
	}
	candidates := make([]store.ActiveGroup, 0, len(groups))
	for _, g := range groups {
		if !s.babbledRecently(g.GroupID, now, quiet) {
			candidates = append(candidates, g)
		}
	}
	if len(candidates) == 0 {
		return
	}
	target := candidates[rand.Intn(len(candidates))]

	msgs, err := s.st.RecentMessages(ctx, target.GroupID, time.Time{}, 12)
	if err != nil || len(msgs) < 2 {
		return
	}
	prompt := s.babblePrompt(now, target, msgs, selfQQ)
	callCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	raw, err := s.llm.ChatJSON(callCtx, babbleSystem, prompt)
	cancel()
	if err != nil {
		s.log.Warn("babble model call failed", "group", target.GroupID, "err", err)
		return
	}
	var out struct {
		Reply string `json:"reply"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return
	}
	text := strings.TrimSpace(sanitizeCQ(out.Reply, s.capabilities()))
	if text == "" {
		return
	}
	if len([]rune(text)) > 60 {
		text = string([]rune(text)[:60])
	}
	sendCtx, sendCancel := context.WithTimeout(ctx, 15*time.Second)
	_, err = s.api.SendGroupMsg(sendCtx, target.GroupID, text)
	sendCancel()
	if err != nil {
		s.log.Warn("babble send failed", "group", target.GroupID, "err", err)
		return
	}
	if _, err := s.st.BabbleBump(ctx, day); err != nil {
		s.log.Warn("babble counter", "err", err)
	}
	s.markBabbled(target.GroupID, now)
	s.hist.append("group:"+target.GroupID, "assistant", text)
	s.log.Info("babbled in group", "group", target.GroupID, "text", text)
}

// babblePrompt renders the recent chatter and asks for one line to join it.
func (s *Service) babblePrompt(now time.Time, g store.ActiveGroup, msgs []store.Message, selfQQ string) string {
	var b strings.Builder
	name := g.Name
	if name == "" {
		name = g.GroupID
	}
	b.WriteString("【群聊】" + name + "（" + g.GroupID + "）\n")
	b.WriteString("【当前时间】" + now.Format("2006-01-02 15:04") + "\n")
	b.WriteString("【最近的群聊记录（最早在前）】\n")
	for _, m := range msgs {
		speaker := m.SenderName
		if speaker == "" {
			speaker = "群友"
		}
		if selfQQ != "" && m.SenderQQ == selfQQ {
			speaker = "你自己（鲸鱼娘）"
		}
		b.WriteString(speaker + ": " + truncateRunes(m.Text, 160) + "\n")
	}
	b.WriteString("\n请判断现在插一句话是否自然；自然就用 reply 输出那一句话，否则输出空字符串。只输出 JSON。")
	return b.String()
}

// inBabbleWindow reports whether now falls inside any "HH:MM-HH:MM" window.
// "24:00" is accepted as end-of-day.
func inBabbleWindow(now time.Time, windows []string) bool {
	if len(windows) == 0 {
		return false
	}
	cur := now.Hour()*60 + now.Minute()
	for _, w := range windows {
		start, end, ok := parseWindow(w)
		if !ok {
			continue
		}
		if start <= end {
			if cur >= start && cur < end {
				return true
			}
			continue
		}
		// Window that wraps past midnight (e.g. 22:00-02:00).
		if cur >= start || cur < end {
			return true
		}
	}
	return false
}

func parseWindow(w string) (int, int, bool) {
	parts := strings.SplitN(strings.TrimSpace(w), "-", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	start, ok := parseClock(parts[0])
	if !ok {
		return 0, 0, false
	}
	end, ok := parseClock(parts[1])
	if !ok {
		return 0, 0, false
	}
	return start, end, true
}

func parseClock(s string) (int, bool) {
	hm := strings.SplitN(strings.TrimSpace(s), ":", 2)
	if len(hm) != 2 {
		return 0, false
	}
	h, err1 := strconv.Atoi(strings.TrimSpace(hm[0]))
	m, err2 := strconv.Atoi(strings.TrimSpace(hm[1]))
	if err1 != nil || err2 != nil || h < 0 || h > 24 || m < 0 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}

// babbledRecently reports whether the robot already spoke up in this group
// within the quiet period.
func (s *Service) babbledRecently(groupID string, now time.Time, quiet time.Duration) bool {
	s.babbleMu.Lock()
	defer s.babbleMu.Unlock()
	at, ok := s.babbleSeen[groupID]
	return ok && now.Sub(at) < quiet
}

func (s *Service) markBabbled(groupID string, now time.Time) {
	s.babbleMu.Lock()
	defer s.babbleMu.Unlock()
	s.babbleSeen[groupID] = now
}
