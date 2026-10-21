package schedule

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"sort"
	"time"
)

// Digest computes a stable content digest over the item list. Items are sorted
// by id first so ordering changes never alter the digest.
func Digest(items []Item) string {
	sorted := make([]Item, len(items))
	copy(sorted, items)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })
	payload := make([]Item, len(sorted))
	for i, it := range sorted {
		cp := it.Clone()
		// These are not part of the semantic content of the document.
		cp.UpdatedAt = time.Time{}
		cp.Revision = 0
		payload[i] = cp
	}
	buf, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	sum := sha1.Sum(buf)
	return "sha1:" + hex.EncodeToString(sum[:])
}

// BuildDocument assembles the public schedule document.
func BuildDocument(userID, qqUID string, revision int64, generatedAt time.Time, items []Item) Document {
	if items == nil {
		items = []Item{}
	}
	// Keep a deterministic order: due_at ascending (nil last), then title.
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.DueAt == nil && b.DueAt == nil {
			return a.Title < b.Title
		}
		if a.DueAt == nil {
			return false
		}
		if b.DueAt == nil {
			return true
		}
		if a.DueAt.Equal(*b.DueAt) {
			return a.Title < b.Title
		}
		return a.DueAt.Before(*b.DueAt)
	})
	return Document{
		UserID:      userID,
		QQ:          qqUID,
		GeneratedAt: generatedAt,
		Revision:    revision,
		Digest:      Digest(items),
		Items:       items,
	}
}
