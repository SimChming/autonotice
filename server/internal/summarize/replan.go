package summarize

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/qqsched/server/internal/store"
)

// ErrEmitterClosed is returned by a ReplanEmitter when the client is gone; the
// run must abort immediately instead of burning more model tokens.
var ErrEmitterClosed = errors.New("summarize: emitter closed")

// ReplanEmitter receives the incremental progress of a manual replan so the
// HTTP layer can relay it to the client as server-sent events.
type ReplanEmitter interface {
	// Phase reports the current stage: reasoning | summarizing | persisting.
	Phase(phase, message string) error
	// Delta reports an incremental chunk: kind is reasoning | answer.
	Delta(kind, text string) error
}

// ReplanResult is the outcome of one binding's manual replan.
type ReplanResult struct {
	Revision  int64  `json:"revision"`
	NewItems  int    `json:"new_items"`
	Messages  int    `json:"messages"`
	Skipped   bool   `json:"skipped"`
	Reasoning string `json:"-"`
	Model     string `json:"-"`
}

// RunReplan runs an out-of-band replan for one binding. It first streams the
// model's thinking chain (reasoning_content) to the emitter for display, then
// falls back to the regular JSON summarization call that actually updates the
// schedule. The thinking chain is display-only: a failure there never blocks
// the schedule update.
func (s *Service) RunReplan(
	ctx context.Context,
	b store.Binding,
	opts RunOptions,
	em ReplanEmitter,
) (*ReplanResult, error) {
	prep, err := s.prepareRun(ctx, b, opts)
	if err != nil {
		return nil, err
	}

	if len(prep.Messages) == 0 {
		emitPhase(em, "done", "该时间窗内没有与你相关的消息")
		_ = s.store.FinishSummaryRun(ctx, prep.Run.ID, store.RunOK, 0, 0, prep.Revision, "")
		_ = s.store.SetLastSummaryAt(ctx, b.UserID, prep.Now)
		return &ReplanResult{Revision: prep.Revision, Skipped: true}, nil
	}

	if !s.client.Configured() {
		_ = s.store.FinishSummaryRun(ctx, prep.Run.ID, store.RunFailed, len(prep.Messages), 0, prep.Revision, "deepseek api key not configured")
		return nil, fmt.Errorf("deepseek api key not configured")
	}

	// --- 1) one streaming call: thinking chain for display + JSON answer ---
	model := s.client.ReasoningModel()
	emitPhase(em, "reasoning", "正在阅读群聊消息并推断日程…")
	reasoning, answer, streamErr := s.streamReasoning(ctx, prep, model, em)
	if streamErr != nil {
		if errors.Is(streamErr, ErrEmitterClosed) || ctx.Err() != nil {
			_ = s.store.FinishSummaryRun(ctx, prep.Run.ID, store.RunFailed, len(prep.Messages), 0, prep.Revision, "client disconnected")
			return nil, streamErr
		}
		s.log.Warn("replan reasoning stream failed", "user", b.UserID, "qq", b.QQUID, "err", streamErr)
		reasoning = ""
	}
	if reasoning != "" {
		if err := s.store.SetSummaryRunReasoning(ctx, prep.Run.ID, reasoning, model); err != nil {
			s.log.Warn("save replan reasoning", "user", b.UserID, "err", err)
		}
	}

	// --- 2) structured result: reuse the streamed JSON, fall back if unusable ---
	raw := json.RawMessage(extractJSONObject(answer))
	if len(raw) == 0 || !json.Valid(raw) {
		emitPhase(em, "summarizing", "正在生成结构化日程…")
		callCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
		var err error
		raw, err = s.client.ChatJSON(callCtx, prep.System, prep.Prompt)
		cancel()
		if err != nil {
			_ = s.store.FinishSummaryRun(ctx, prep.Run.ID, store.RunFailed, len(prep.Messages), 0, prep.Revision, err.Error())
			return nil, err
		}
	}
	incoming, err := parseAIItems(raw, b.GroupID, s.loc)
	if err != nil {
		_ = s.store.FinishSummaryRun(ctx, prep.Run.ID, store.RunFailed, len(prep.Messages), 0, prep.Revision, err.Error())
		return nil, err
	}

	emitPhase(em, "persisting", "正在写入日程…")
	changed, err := s.persist(ctx, b, prep, incoming, len(prep.Messages))
	if err != nil {
		return nil, err
	}
	return &ReplanResult{
		Revision:  prep.Revision,
		NewItems:  changed,
		Messages:  len(prep.Messages),
		Reasoning: reasoning,
		Model:     model,
	}, nil
}

// streamReasoning streams one completion and returns the thinking chain plus
// the answer content. JSON mode is on so the answer is the schedule payload
// itself: the caller reuses it instead of paying for a second full call.
func (s *Service) streamReasoning(
	ctx context.Context,
	prep *runPrep,
	model string,
	em ReplanEmitter,
) (reasoning, answer string, err error) {
	if model == "" {
		return "", "", nil
	}
	streamCtx, cancel := context.WithTimeout(ctx, 180*time.Second)
	defer cancel()
	return s.client.ChatStream(streamCtx, prep.System, prep.Prompt,
		StreamOptions{Model: model, MaxTokens: 4096, JSONMode: true},
		func(d StreamDelta) error {
			if em == nil {
				return nil
			}
			if d.Reasoning != "" {
				if err := em.Delta("reasoning", d.Reasoning); err != nil {
					return err
				}
			}
			return nil
		})
}

func emitPhase(em ReplanEmitter, phase, message string) {
	if em == nil {
		return
	}
	if err := em.Phase(phase, message); err != nil {
		// Phase failures only mean the client left; the caller checks ctx.
		return
	}
}
