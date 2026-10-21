package schedule

import (
	"strconv"
	"strings"
	"time"
)

// NormalizeTitle produces a comparison key for matching AI items against
// existing ones. It lowercases, strips whitespace and common punctuation.
func NormalizeTitle(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch r {
		case ' ', '\t', '\n', '\r', '，', '。', ',', '.', '!', '！', '?', '？',
			':', '：', ';', '；', '(', ')', '（', '）', '[', ']', '【', '】',
			'"', '\'', '“', '”', '-', '_', '/', '\\':
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// matchKey builds the cross-group dedup key: two items are considered the same
// schedule when their (normalized) title AND due time are identical, regardless
// of which group reported them. When the same announcement is repeated in
// several groups it therefore collapses into a single row instead of spawning a
// duplicate per group.
func matchKey(it Item) string {
	key := "t:" + NormalizeTitle(it.Title)
	if it.DueAt != nil {
		key += "@" + it.DueAt.UTC().Format(time.RFC3339)
	} else {
		key += "@~"
	}
	return key
}

// MergeAI merges DeepSeek-generated items into the existing set.
//
// Rules (matching the plan's field ownership):
//   - AI owns title / due_at / remind_at / source; the client owns status / notes.
//   - An item the user has edited (locked_by_user) is never overwritten.
//   - Existing items that no longer match are kept (AI does not delete).
//   - Matched items get Revision bumped to rev.
//
// It returns the full merged list plus the subset that actually changed.
func MergeAI(existing []Item, incoming []Item, rev int64, now time.Time) (merged []Item, changed []Item) {
	byKey := make(map[string]int, len(existing))
	merged = make([]Item, len(existing))
	for i, it := range existing {
		cp := it.Clone()
		// Keep the contributing-group list in sync for older rows that only
		// carried a bare group_id.
		if cp.Source.GroupID != "" && len(cp.Source.Groups) == 0 {
			cp.Source.AddGroup(cp.Source.GroupID, cp.Source.GroupName)
		}
		merged[i] = cp
		byKey[matchKey(it)] = i
	}

	for _, inc := range incoming {
		inc = inc.Clone()
		if inc.Source.GroupID != "" && len(inc.Source.Groups) == 0 {
			inc.Source.AddGroup(inc.Source.GroupID, inc.Source.GroupName)
		}
		idx, ok := byKey[matchKey(inc)]
		if !ok {
			if inc.ID == "" {
				inc.ID = ""
			}
			inc.Revision = rev
			inc.CreatedAt = now
			inc.UpdatedAt = now
			if inc.Status == "" {
				inc.Status = StatusPending
			}
			if inc.Type == "" {
				inc.Type = TypeTask
			}
			if inc.Priority == "" {
				inc.Priority = PriorityNormal
			}
			byKey[matchKey(inc)] = len(merged)
			merged = append(merged, inc)
			changed = append(changed, inc)
			continue
		}

		cur := merged[idx]
		if cur.LockedByUser {
			continue // user owns this row now, AI must not touch it.
		}
		updated := cur
		if inc.Title != "" {
			updated.Title = inc.Title
		}
		updated.DueAt = inc.DueAt
		updated.RemindAt = inc.RemindAt
		if inc.Type != "" {
			updated.Type = inc.Type
		}
		if inc.Priority != "" {
			updated.Priority = inc.Priority
		}
		// Union the contributing groups so a schedule reported by several
		// groups stays one row that lists every origin.
		if inc.Source.Kind != "" || inc.Source.GroupID != "" || len(inc.Source.Groups) > 0 {
			updated.Source.Absorb(inc.Source)
		}
		updated.Revision = rev
		updated.UpdatedAt = now
		// status / notes are preserved from the existing item on purpose.
		merged[idx] = updated
		changed = append(changed, updated)
	}
	return merged, changed
}

// DedupeByKey collapses AI-reported items that share the same (title + due) key
// into a single entry, unioning their contributing groups. It is applied when
// reading the schedule so legacy rows stored before cross-group dedup existed do
// not show up twice, and so the client can display every origin group.
//
// User-owned rows (LockedByUser or Source.Kind == user) are never collapsed:
// if the user deliberately created two same-named schedules they must stay two.
func DedupeByKey(items []Item) []Item {
	if len(items) < 2 {
		return items
	}
	seen := make(map[string]int, len(items))
	out := make([]Item, 0, len(items))
	for _, it := range items {
		cp := it.Clone()
		if cp.Source.GroupID != "" && len(cp.Source.Groups) == 0 {
			cp.Source.AddGroup(cp.Source.GroupID, cp.Source.GroupName)
		}
		if cp.LockedByUser || cp.Source.Kind == SourceUser {
			out = append(out, cp)
			continue
		}
		key := matchKey(cp)
		idx, ok := seen[key]
		if !ok {
			seen[key] = len(out)
			out = append(out, cp)
			continue
		}
		out[idx].Source.Absorb(cp.Source)
	}
	return out
}

// ApplyGroupNames backfills display names onto each item's source using a
// group_id -> group_name lookup.
func ApplyGroupNames(items []Item, names map[string]string) {
	if len(names) == 0 {
		return
	}
	for i := range items {
		src := &items[i].Source
		if src.GroupName == "" {
			src.GroupName = names[src.GroupID]
		}
		for j := range src.Groups {
			if src.Groups[j].GroupName == "" {
				src.Groups[j].GroupName = names[src.Groups[j].GroupID]
			}
		}
	}
}

// ApplyUserPatch applies a client patch (already validated) onto an item.
// Only mutable-by-client fields are taken: title, due_at, remind_at, all_day,
// notes, status, priority, type.
func ApplyUserPatch(base Item, patch Item, rev int64, now time.Time) Item {
	out := base.Clone()
	if patch.Title != "" {
		out.Title = patch.Title
	}
	out.DueAt = patch.DueAt
	out.RemindAt = patch.RemindAt
	out.AllDay = patch.AllDay
	if patch.Notes != "" || patch.Notes == "" {
		out.Notes = patch.Notes
	}
	if patch.Status != "" {
		out.Status = patch.Status
	}
	if patch.Priority != "" {
		out.Priority = patch.Priority
	}
	if patch.Type != "" {
		out.Type = patch.Type
	}
	out.LockedByUser = true
	out.Revision = rev
	out.UpdatedAt = now
	return out
}

// ParseRevision parses a revision string, returning 0 when not a valid number.
func ParseRevision(s string) int64 {
	s = strings.TrimSpace(strings.Trim(s, `"`))
	if s == "" {
		return 0
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}
