// Package memory keeps long-lived conversational fragments per chat peer and
// recalls the ones relevant to a new message, so the bot can stay in character
// without replaying the whole history (which is what keeps token use small).
package memory

import (
	"context"
	"log/slog"
	"sort"
	"strings"
	"unicode"

	"github.com/qqsched/server/internal/store"
)

// Service stores and recalls memory fragments.
type Service struct {
	st  *store.Store
	log *slog.Logger
}

// New builds the memory service.
func New(st *store.Store, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{st: st, log: log}
}

// Remember persists one fragment, tagged by peer and keywords.
func (s *Service) Remember(ctx context.Context, sessionKey, senderQQ, content string, tags []string) {
	if s == nil || s.st == nil {
		return
	}
	tag := strings.Join(dedupe(tags, 8), ",")
	if err := s.st.InsertMemory(ctx, sessionKey, senderQQ, tag, content); err != nil {
		s.log.Warn("store memory", "session", sessionKey, "err", err)
	}
}

// RememberPreference stores a system-level preference (only the owner is
// allowed to create these, the caller enforces that).
func (s *Service) RememberPreference(ctx context.Context, senderQQ, content string, tags []string, global bool) {
	if s == nil || s.st == nil {
		return
	}
	scope := store.MemoryScopePeer
	if global {
		scope = store.MemoryScopeGlobal
	}
	tag := strings.Join(dedupe(tags, 8), ",")
	if err := s.st.InsertPreference(ctx, senderQQ, tag, content, scope); err != nil {
		s.log.Warn("store preference", "qq", senderQQ, "err", err)
	}
}

// Preferences returns the long-lived preference lines injected into every
// prompt: global ones plus this speaker's own.
func (s *Service) Preferences(ctx context.Context, senderQQ string, limit int) []store.Memory {
	if s == nil || s.st == nil {
		return nil
	}
	out, err := s.st.ListPreferences(ctx, senderQQ, limit)
	if err != nil {
		s.log.Warn("list preferences", "qq", senderQQ, "err", err)
		return nil
	}
	return out
}

// Recall returns the fragments most relevant to the current message, best first.
func (s *Service) Recall(ctx context.Context, sessionKey, senderQQ, query string, limit int) []store.Memory {
	if s == nil || s.st == nil || limit <= 0 || sessionKey == "" {
		return nil
	}
	terms := Keywords(query)
	cands, err := s.st.SearchMemories(ctx, sessionKey, terms, limit)
	if err != nil {
		s.log.Warn("recall memories", "session", sessionKey, "err", err)
		return nil
	}
	if len(cands) == 0 {
		return nil
	}

	type scored struct {
		m     store.Memory
		score int
	}
	ranked := make([]scored, 0, len(cands))
	for _, m := range cands {
		hay := strings.ToLower(m.Content + " " + m.Tags)
		score := 0
		for _, t := range terms {
			if strings.Contains(hay, t) {
				score += 2
			}
		}
		// Fragments that came from the same speaker matter more in a group.
		if senderQQ != "" && m.SenderQQ == senderQQ {
			score += 3
		}
		ranked = append(ranked, scored{m: m, score: score})
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].m.CreatedAt.After(ranked[j].m.CreatedAt)
	})
	if len(ranked) > limit {
		ranked = ranked[:limit]
	}
	out := make([]store.Memory, 0, len(ranked))
	for _, r := range ranked {
		out = append(out, r.m)
	}
	return out
}

// --- keyword extraction ---

var stopWords = map[string]bool{
	"的": true, "了": true, "是": true, "吗": true, "呢": true, "吧": true, "啊": true,
	"我": true, "你": true, "他": true, "她": true, "它": true, "们": true, "这": true, "那": true,
	"什么": true, "怎么": true, "为什么": true, "这个": true, "那个": true, "一下": true,
	"今天": true, "现在": true, "可以": true, "没有": true, "然后": true, "就是": true,
	"the": true, "and": true, "you": true, "for": true, "that": true, "this": true, "with": true,
	"是是": true,
}

// Keywords extracts search terms from free text. CJK runs are kept whole when
// short and split into bigrams when long; ASCII words are kept as-is.
func Keywords(text string) []string {
	text = strings.ToLower(text)
	var out []string
	var ascii, cjk strings.Builder

	flushASCII := func() {
		w := ascii.String()
		ascii.Reset()
		if len([]rune(w)) >= 2 && !stopWords[w] {
			out = append(out, w)
		}
	}
	flushCJK := func() {
		runes := []rune(cjk.String())
		cjk.Reset()
		if len(runes) == 0 {
			return
		}
		if len(runes) <= 4 {
			token := string(runes)
			if !stopWords[token] {
				out = append(out, token)
			}
			return
		}
		for i := 0; i+1 < len(runes); i++ {
			bg := string(runes[i : i+2])
			if !stopWords[bg] {
				out = append(out, bg)
			}
		}
	}

	for _, r := range text {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			flushCJK()
			ascii.WriteRune(r)
		case unicode.Is(unicode.Han, r):
			flushASCII()
			cjk.WriteRune(r)
		default:
			flushASCII()
			flushCJK()
		}
	}
	flushASCII()
	flushCJK()
	return dedupe(out, 8)
}

func dedupe(items []string, max int) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(items))
	for _, it := range items {
		it = strings.TrimSpace(it)
		if it == "" || seen[it] {
			continue
		}
		seen[it] = true
		out = append(out, it)
		if max > 0 && len(out) >= max {
			break
		}
	}
	return out
}
