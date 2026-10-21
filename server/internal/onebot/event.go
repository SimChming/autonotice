// Package onebot defines the protocol-independent event model and the Provider
// interface that concrete OneBot implementations (v11 today) satisfy.
package onebot

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// EventKind classifies a normalized event.
type EventKind string

const (
	KindMessage EventKind = "message"
	KindNotice  EventKind = "notice"
	KindMeta    EventKind = "meta"
	KindRequest EventKind = "request"
	KindUnknown EventKind = "unknown"
)

// Segment is one normalized message segment.
type Segment struct {
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
}

// Str returns a string field from the segment data map.
func (s Segment) Str(key string) string {
	if s.Data == nil {
		return ""
	}
	v, ok := s.Data[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	default:
		return ""
	}
}

// Int returns an integer field from the segment data map.
func (s Segment) Int(key string) int {
	v := s.Str(key)
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return 0
	}
	return n
}

// Sender carries message sender metadata.
type Sender struct {
	UserID   string `json:"user_id"`
	Nickname string `json:"nickname"`
	Card     string `json:"card"`
	Role     string `json:"role"`
}

// DisplayName returns the best available sender name.
func (s Sender) DisplayName() string {
	if s.Card != "" {
		return s.Card
	}
	return s.Nickname
}

// Event is the normalized, protocol-independent view of an inbound event.
type Event struct {
	Kind          EventKind       `json:"kind"`
	Time          int64           `json:"time"`
	SelfID        string          `json:"self_id"`
	PostType      string          `json:"post_type"`
	MessageType   string          `json:"message_type"`
	SubType       string          `json:"sub_type"`
	MessageID     string          `json:"message_id"`
	GroupID       string          `json:"group_id"`
	UserID        string          `json:"user_id"`
	Sender        Sender          `json:"sender"`
	Segments      []Segment       `json:"segments"`
	RawMessage    string          `json:"raw_message"`
	Text          string          `json:"text"`
	Mentions      []string        `json:"mentions"`
	ReplyTo       string          `json:"reply_to_msg_id"`
	NoticeType    string          `json:"notice_type"`
	MetaEventType string          `json:"meta_event_type"`
	Raw           json.RawMessage `json:"-"`
}

// IsGroup reports whether the event is a group message.
func (e Event) IsGroup() bool {
	return e.Kind == KindMessage && (e.MessageType == "group" || e.GroupID != "")
}

// NormalizeV11 converts a decoded OneBot v11 JSON object into an Event.
// The bool result reports whether the payload was a recognized event.
func NormalizeV11(payload map[string]any) (Event, bool) {
	postType, _ := payload["post_type"].(string)
	ev := Event{
		PostType:    postType,
		Raw:         marshalRaw(payload),
		SelfID:      anyString(payload["self_id"]),
		Time:        anyInt(payload["time"]),
		SubType:     anyString(payload["sub_type"]),
		MessageID:   anyString(payload["message_id"]),
		GroupID:     anyString(payload["group_id"]),
		UserID:      anyString(payload["user_id"]),
		RawMessage:  anyString(payload["raw_message"]),
		MessageType: anyString(payload["message_type"]),
	}

	switch postType {
	case "message", "message_sent":
		ev.Kind = KindMessage
	case "notice":
		ev.Kind = KindNotice
		ev.NoticeType = anyString(payload["notice_type"])
	case "meta_event":
		ev.Kind = KindMeta
		ev.MetaEventType = anyString(payload["meta_event_type"])
	case "request":
		ev.Kind = KindRequest
	default:
		ev.Kind = KindUnknown
		return ev, false
	}

	if sender, ok := payload["sender"].(map[string]any); ok {
		ev.Sender = Sender{
			UserID:   anyString(sender["user_id"]),
			Nickname: anyString(sender["nickname"]),
			Card:     anyString(sender["card"]),
			Role:     anyString(sender["role"]),
		}
	}

	ev.Segments, ev.Text, ev.Mentions, ev.ReplyTo = parseMessage(payload["message"], ev.RawMessage)
	if ev.Text == "" && ev.RawMessage != "" {
		ev.Text = ev.RawMessage
	}
	if ev.UserID == "" {
		ev.UserID = ev.Sender.UserID
	}
	return ev, true
}

func parseMessage(message any, rawMessage string) (segs []Segment, text string, mentions []string, replyTo string) {
	switch m := message.(type) {
	case string:
		if m != "" {
			segs = append(segs, Segment{Type: "text", Data: map[string]any{"text": m}})
			text = m
			// NapCat may report `message` as a CQ-code string rather than a
			// segment array; pull @-targets out of the raw codes so mention
			// detection still works either way.
			mentions = append(mentions, cqAtMentions(m)...)
		}
	case []any:
		var b strings.Builder
		for _, item := range m {
			obj, ok := item.(map[string]any)
			if !ok {
				continue
			}
			seg := Segment{Type: anyString(obj["type"])}
			if data, ok := obj["data"].(map[string]any); ok {
				seg.Data = data
			} else {
				seg.Data = map[string]any{}
			}
			segs = append(segs, seg)
			switch seg.Type {
			case "text":
				b.WriteString(seg.Str("text"))
			case "at":
				qq := seg.Str("qq")
				if qq != "" && qq != "all" {
					mentions = append(mentions, qq)
				}
			case "reply":
				if id := seg.Str("id"); id != "" {
					replyTo = id
				}
			}
		}
		text = b.String()
	}
	if text == "" && rawMessage != "" {
		text = rawMessage
	}
	return segs, text, mentions, replyTo
}

var cqAtRe = regexp.MustCompile(`\[CQ:at,qq=([^,\]]+)\]`)

// cqAtMentions extracts the @-targets from a raw CQ-code message string.
func cqAtMentions(s string) []string {
	matches := cqAtRe.FindAllStringSubmatch(s, -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		if len(m) > 1 && m[1] != "" && m[1] != "all" {
			out = append(out, m[1])
		}
	}
	return out
}

func marshalRaw(v any) json.RawMessage {
	buf, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return buf
}

func anyString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		// QQ ids fit in float64 exactly (< 2^53).
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		if t {
			return "true"
		}
		return "false"
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	default:
		buf, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return string(buf)
	}
}

func anyInt(v any) int64 {
	switch t := v.(type) {
	case json.Number:
		n, _ := t.Int64()
		return n
	case float64:
		return int64(t)
	case int:
		return int64(t)
	case int64:
		return t
	case string:
		n, _ := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
		return n
	default:
		return 0
	}
}
