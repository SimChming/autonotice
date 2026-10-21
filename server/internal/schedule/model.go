// Package schedule holds the cross-device stable schedule data model plus the
// pure merge / export helpers shared by the store and HTTP API.
package schedule

import (
	"strings"
	"time"
)

// Item type values.
const (
	TypeTask     = "task"
	TypeEvent    = "event"
	TypeReminder = "reminder"
	TypeFee      = "fee"
	TypeExam     = "exam"
	TypeHomework = "homework"
	TypeOther    = "other"
)

// Item status values.
const (
	StatusPending   = "pending"
	StatusDone      = "done"
	StatusDismissed = "dismissed"
)

// Item priority values.
const (
	PriorityLow    = "low"
	PriorityNormal = "normal"
	PriorityHigh   = "high"
	PriorityUrgent = "urgent"
)

// Source kind values.
const (
	SourceAI      = "ai"
	SourceUser    = "user"
	SourceContent = "content"
	SourceMessage = "message"
)

// SourceGroup identifies one QQ group that contributed to an item. An item may
// be reported by several groups (the same announcement repeated across groups);
// each contributing group is recorded here so the client can show its origin.
type SourceGroup struct {
	GroupID   string `json:"group_id"`
	GroupName string `json:"group_name,omitempty"`
}

// Source describes where an item came from.
type Source struct {
	Kind           string        `json:"kind"`
	GroupID        string        `json:"group_id,omitempty"`
	GroupName      string        `json:"group_name,omitempty"`
	Groups         []SourceGroup `json:"groups,omitempty"`
	MessageIDs     []string      `json:"message_ids,omitempty"`
	Excerpt        string        `json:"excerpt,omitempty"`
	Confidence     float64       `json:"confidence,omitempty"`
	ContentAssetID string        `json:"content_asset_id,omitempty"`
	LinkTitle      string        `json:"link_title,omitempty"`
	FetchStatus    string        `json:"fetch_status,omitempty"`
}

// AddGroup records a contributing group, ignoring duplicates and keeping the
// first display name seen. The primary group_id mirrors the first group added.
func (s *Source) AddGroup(groupID, name string) {
	groupID = strings.TrimSpace(groupID)
	if groupID == "" {
		return
	}
	if s.GroupID == "" {
		s.GroupID = groupID
		if name != "" {
			s.GroupName = name
		}
	}
	for i := range s.Groups {
		if s.Groups[i].GroupID == groupID {
			if s.Groups[i].GroupName == "" && name != "" {
				s.Groups[i].GroupName = name
			}
			return
		}
	}
	s.Groups = append(s.Groups, SourceGroup{GroupID: groupID, GroupName: name})
}

// Absorb unions another source's contributing groups and message ids into this
// one while letting the other side refresh descriptive fields (excerpt, asset,
// fetch status ...). Used to merge the same schedule reported by several groups
// into a single item instead of creating a duplicate row.
func (s *Source) Absorb(other Source) {
	if other.Kind != "" {
		s.Kind = other.Kind
	}
	for _, g := range other.Groups {
		s.AddGroup(g.GroupID, g.GroupName)
	}
	if other.GroupID != "" {
		s.AddGroup(other.GroupID, other.GroupName)
	}
	for _, id := range other.MessageIDs {
		if !containsString(s.MessageIDs, id) {
			s.MessageIDs = append(s.MessageIDs, id)
		}
	}
	if other.Excerpt != "" {
		s.Excerpt = other.Excerpt
	}
	if other.Confidence > s.Confidence {
		s.Confidence = other.Confidence
	}
	if other.ContentAssetID != "" && s.ContentAssetID == "" {
		s.ContentAssetID = other.ContentAssetID
	}
	if other.LinkTitle != "" && s.LinkTitle == "" {
		s.LinkTitle = other.LinkTitle
	}
	if other.FetchStatus != "" {
		s.FetchStatus = other.FetchStatus
	}
}

func containsString(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// Item is a single schedule entry. It is deliberately transport friendly and is
// serialized verbatim into the public schedule document.
type Item struct {
	ID           string     `json:"id"`
	Title        string     `json:"title"`
	Type         string     `json:"type"`
	Status       string     `json:"status"`
	Priority     string     `json:"priority"`
	DueAt        *time.Time `json:"due_at"`
	RemindAt     *time.Time `json:"remind_at"`
	AllDay       bool       `json:"all_day"`
	Notes        string     `json:"notes"`
	LockedByUser bool       `json:"locked_by_user"`
	Revision     int64      `json:"revision"`
	Source       Source     `json:"source"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

// Clone returns a deep copy of the item.
func (it Item) Clone() Item {
	cp := it
	if it.DueAt != nil {
		t := *it.DueAt
		cp.DueAt = &t
	}
	if it.RemindAt != nil {
		t := *it.RemindAt
		cp.RemindAt = &t
	}
	if it.Source.MessageIDs != nil {
		cp.Source.MessageIDs = append([]string(nil), it.Source.MessageIDs...)
	}
	if it.Source.Groups != nil {
		cp.Source.Groups = append([]SourceGroup(nil), it.Source.Groups...)
	}
	return cp
}

// Document is the public schedule document returned by GET /schedules/me.
type Document struct {
	UserID      string    `json:"user_id"`
	QQ          string    `json:"qq_uid"`
	GeneratedAt time.Time `json:"generated_at"`
	Revision    int64     `json:"revision"`
	Digest      string    `json:"digest"`
	Items       []Item    `json:"items"`
}

// Delta is the incremental change set returned by the delta endpoint.
type Delta struct {
	Revision int64    `json:"revision"`
	Changed  []Item   `json:"changed"`
	Deleted  []string `json:"deleted"`
}

// Mutation is a single client-side offline change submitted through /sync.
type Mutation struct {
	Op   string `json:"op"` // create | update | delete
	Item *Item  `json:"item"`
}
