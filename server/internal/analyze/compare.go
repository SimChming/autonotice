// Package analyze compares a declared content title against the fetched body
// (DeepSeek) and produces the human-review notification copy. It reuses the
// DeepSeek client owned by the summarize package.
package analyze

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/qqsched/server/internal/store"
	"github.com/qqsched/server/internal/summarize"
)

// Consistency verdict values.
const (
	ConsistencyMatch    = "match"
	ConsistencyPartial  = "partial"
	ConsistencyMismatch = "mismatch"
	ConsistencyUnknown  = "unknown"
)

// SuggestItem is an optional schedule item proposed by the model.
type SuggestItem struct {
	Title    string `json:"title"`
	Type     string `json:"type"`
	Priority string `json:"priority"`
	DueAt    string `json:"due_at"`
	Notes    string `json:"notes"`
}

// Result is the structured model verdict.
type Result struct {
	Consistency       string        `json:"consistency"`
	ConsistencyReason string        `json:"consistency_reason"`
	ContentKindGuess  string        `json:"content_kind_guess"`
	ManualReview      bool          `json:"manual_review"`
	UserMessage       string        `json:"user_message"`
	SuggestedItems    []SuggestItem `json:"suggested_items"`
}

// Comparer wraps the shared summarization client.
type Comparer struct {
	client *summarize.Client
	log    *slog.Logger
}

// NewComparer builds the comparer over the shared DeepSeek client.
func NewComparer(client *summarize.Client, log *slog.Logger) *Comparer {
	if log == nil {
		log = slog.Default()
	}
	return &Comparer{client: client, log: log}
}

// Compare runs the title-vs-body check. On failure the caller must fall back to
// the template copy; the schedule is never polluted here.
func (c *Comparer) Compare(ctx context.Context, a store.ContentAsset, contextLines []string) (*Result, error) {
	if c.client == nil || !c.client.Configured() {
		return nil, errors.New("analyze: deepseek client not configured")
	}
	system, user := BuildComparePrompt(a, contextLines)
	callCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	raw, err := c.client.ChatJSON(callCtx, system, user)
	if err != nil {
		return nil, err
	}
	var res Result
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("analyze: decode result: %w", err)
	}
	res.Consistency = normalizeConsistency(res.Consistency)
	res.UserMessage = strings.TrimSpace(res.UserMessage)
	if res.UserMessage == "" {
		return nil, errors.New("analyze: empty user_message")
	}
	return &res, nil
}

func normalizeConsistency(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case ConsistencyMatch, "consistent", "ok":
		return ConsistencyMatch
	case ConsistencyPartial, "partially", "partial_match":
		return ConsistencyPartial
	case ConsistencyMismatch, "inconsistent", "conflict":
		return ConsistencyMismatch
	default:
		return ConsistencyUnknown
	}
}
