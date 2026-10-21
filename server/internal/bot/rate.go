package bot

import (
	"sync"
	"time"
)

// Private-chat DeepSeek budget: each user gets at most privateChatLimit model
// calls per privateChatWindow. Over the limit the bot answers with a canned
// line and never touches the API, so a chatty friend can't burn tokens.
const (
	privateChatLimit  = 3
	privateChatWindow = 5 * time.Minute
)

// limiter is a tiny in-memory sliding-window rate limiter.
type limiter struct {
	mu sync.Mutex
	m  map[string][]time.Time
}

func newLimiter() *limiter {
	return &limiter{m: map[string][]time.Time{}}
}

// allow records a hit and reports whether the key is still within budget.
// Sliding window: hits older than privateChatWindow are dropped on read.
func (l *limiter) allow(key string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	fresh := l.m[key][:0]
	for _, t := range l.m[key] {
		if now.Sub(t) < privateChatWindow {
			fresh = append(fresh, t)
		}
	}
	if len(fresh) >= privateChatLimit {
		l.m[key] = fresh
		return false
	}
	l.m[key] = append(fresh, now)
	return true
}
