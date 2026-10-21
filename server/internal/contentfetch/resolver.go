package contentfetch

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/qqsched/server/internal/store"
)

// FileURLProvider resolves an (expired) group file id into a direct URL. The
// onebot API implements it.
type FileURLProvider interface {
	GetGroupFileURL(ctx context.Context, groupID, fileID string, busid int) (string, error)
}

// ErrResolveFailed is returned when a file URL cannot be resolved.
var ErrResolveFailed = errors.New("contentfetch: resolve failed")

// ResolveFileURL re-resolves a group file link on every fetch (direct URLs are
// short-lived and rate limited, so they are never cached) with one retry.
func ResolveFileURL(ctx context.Context, p FileURLProvider, a store.ContentAsset) (string, error) {
	if p == nil {
		return "", fmt.Errorf("%w: no file url provider", ErrResolveFailed)
	}
	if a.FileID == "" {
		return "", fmt.Errorf("%w: missing file_id", ErrResolveFailed)
	}
	busid := 0
	busid = atoiSafe(a.BusID)

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(time.Second):
			}
		}
		url, err := p.GetGroupFileURL(ctx, a.GroupID, a.FileID, busid)
		if err != nil {
			lastErr = err
			continue
		}
		if url == "" {
			lastErr = errors.New("empty url")
			continue
		}
		return url, nil
	}
	return "", fmt.Errorf("%w: %v", ErrResolveFailed, lastErr)
}

func atoiSafe(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
	}
	return n
}
