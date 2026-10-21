package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

const messageCols = `id, group_id, message_id, sender_qq, sender_name, message_type, sub_type,
	text, raw_message, segments_json, mentions, reply_to_msg_id, fingerprint, msg_time, created_at`

// messageSelectCols 在查询时额外带上 rowid，供总结指针同秒内精确定位。
const messageSelectCols = `rowid, ` + messageCols

// InsertMessage stores a message idempotently (keyed on fingerprint). The bool
// result reports whether a new row was actually inserted.
func (s *Store) InsertMessage(ctx context.Context, m Message) (bool, error) {
	if m.ID == "" {
		m.ID = uuid.NewString()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = time.Now().UTC()
	}
	mentions, err := json.Marshal(m.Mentions)
	if err != nil {
		return false, err
	}
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO messages (`+messageCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(fingerprint) DO NOTHING`,
		m.ID, m.GroupID, m.MessageID, m.SenderQQ, m.SenderName, m.MessageType, m.SubType,
		m.Text, m.RawMessage, m.SegmentsJSON, string(mentions), m.ReplyToMsgID,
		m.Fingerprint, m.MsgTime.Unix(), m.CreatedAt.Unix())
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// QueryMessages returns schema messages matching a filter, oldest first.
type MessageFilter struct {
	GroupID  string
	SenderQQ string
	Since    time.Time
	Limit    int
}

func (s *Store) QueryMessages(ctx context.Context, f MessageFilter) ([]Message, error) {
	var (
		clauses []string
		args    []any
	)
	if f.GroupID != "" {
		clauses = append(clauses, "group_id = ?")
		args = append(args, f.GroupID)
	}
	if f.SenderQQ != "" {
		clauses = append(clauses, "sender_qq = ?")
		args = append(args, f.SenderQQ)
	}
	if !f.Since.IsZero() {
		clauses = append(clauses, "msg_time >= ?")
		args = append(args, f.Since.Unix())
	}
	q := `SELECT ` + messageSelectCols + ` FROM messages`
	if len(clauses) > 0 {
		q += " WHERE " + strings.Join(clauses, " AND ")
	}
	q += " ORDER BY msg_time ASC, rowid ASC"
	if f.Limit > 0 {
		q += fmt.Sprintf(" LIMIT %d", f.Limit)
	}
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows)
}

// QueryMessagesForUser returns messages relevant to a bound QQ identity:
// messages sent by that user, messages that mention them, or replies to their
// messages. groupID may be empty to search across all groups.
//
// since/afterRowID 是「总结指针」：只返回严格晚于该游标的消息。afterRowID
// 用于同一秒内多条消息的精确定位（0 表示不做行号过滤）。
func (s *Store) QueryMessagesForUser(ctx context.Context, groupID, qqUID string, since time.Time, afterRowID int64, limit int) ([]Message, error) {
	var (
		clauses []string
		args    []any
	)
	base := `SELECT ` + messageSelectCols + ` FROM messages`
	if groupID != "" {
		clauses = append(clauses, "group_id = ?")
		args = append(args, groupID)
	}
	if !since.IsZero() {
		clauses = append(clauses, "(msg_time > ? OR (msg_time = ? AND rowid > ?))")
		args = append(args, since.Unix(), since.Unix(), afterRowID)
	} else if afterRowID > 0 {
		clauses = append(clauses, "rowid > ?")
		args = append(args, afterRowID)
	}
	mention := "%\"" + qqUID + "\"%"

	relevance := `(sender_qq = ? OR (mentions IS NOT NULL AND mentions LIKE ?) ` +
		`OR (reply_to_msg_id IS NOT NULL AND reply_to_msg_id IN ` +
		`(SELECT message_id FROM messages WHERE sender_qq = ?` + groupSub(groupID) + `)))`
	clauses = append(clauses, relevance)
	args = append(args, qqUID, mention, qqUID)
	if groupID != "" {
		args = append(args, groupID)
	}

	q := base
	if len(clauses) > 0 {
		q += " WHERE " + strings.Join(clauses, " AND ")
	}
	q += " ORDER BY msg_time ASC, rowid ASC"
	if limit > 0 {
		q += fmt.Sprintf(" LIMIT %d", limit)
	}
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows)
}

func groupSub(groupID string) string {
	if groupID == "" {
		return ""
	}
	return " AND group_id = ?"
}

func scanMessages(rows *sql.Rows) ([]Message, error) {
	var out []Message
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

func scanMessage(row rowScanner) (*Message, error) {
	var (
		m          Message
		mentions   sql.NullString
		segments   sql.NullString
		raw        sql.NullString
		text       sql.NullString
		subType    sql.NullString
		senderQQ   sql.NullString
		senderName sql.NullString
		replyTo    sql.NullString
		msgTime    sql.NullInt64
		createdAt  sql.NullInt64
	)
	if err := row.Scan(&m.RowID, &m.ID, &m.GroupID, &m.MessageID, &senderQQ, &senderName, &m.MessageType, &subType,
		&text, &raw, &segments, &mentions, &replyTo, &m.Fingerprint, &msgTime, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	m.SenderQQ = senderQQ.String
	m.SenderName = senderName.String
	m.SubType = subType.String
	m.Text = text.String
	m.RawMessage = raw.String
	m.SegmentsJSON = segments.String
	m.ReplyToMsgID = replyTo.String
	m.MsgTime = timeVal(msgTime)
	m.CreatedAt = timeVal(createdAt)
	if mentions.Valid && mentions.String != "" {
		_ = json.Unmarshal([]byte(mentions.String), &m.Mentions)
	}
	return &m, nil
}

// RecentMessages returns up to limit messages for a group that are older than
// `before` (ascending order after reversal). A zero `before` means "now".
func (s *Store) RecentMessages(ctx context.Context, groupID string, before time.Time, limit int) ([]Message, error) {
	var (
		clauses []string
		args    []any
	)
	if groupID != "" {
		clauses = append(clauses, "group_id = ?")
		args = append(args, groupID)
	}
	if !before.IsZero() {
		clauses = append(clauses, "msg_time < ?")
		args = append(args, before.Unix())
	}
	q := `SELECT ` + messageSelectCols + ` FROM messages`
	if len(clauses) > 0 {
		q += " WHERE " + strings.Join(clauses, " AND ")
	}
	q += " ORDER BY msg_time DESC, rowid DESC"
	if limit > 0 {
		q += fmt.Sprintf(" LIMIT %d", limit)
	}
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	msgs, err := scanMessages(rows)
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return msgs, nil
}

// ActiveGroup is a group that has been chatting recently.
type ActiveGroup struct {
	GroupID string
	Name    string
	Count   int
}

// ListActiveGroups returns groups with at least two messages from other people
// since `since`, busiest first. It feeds the unprompted "冒泡" behaviour, which
// only joins conversations that are actually live.
func (s *Store) ListActiveGroups(ctx context.Context, since time.Time, excludeQQ string) ([]ActiveGroup, error) {
	q := `SELECT m.group_id, COALESCE(g.group_name, ''), COUNT(*) AS n
	        FROM messages m LEFT JOIN groups g ON g.group_id = m.group_id
	       WHERE m.msg_time >= ? AND m.message_type = 'group'`
	args := []any{since.Unix()}
	if excludeQQ != "" {
		q += ` AND (m.sender_qq IS NULL OR m.sender_qq != ?)`
		args = append(args, excludeQQ)
	}
	q += ` GROUP BY m.group_id HAVING COUNT(*) >= 2 ORDER BY n DESC, MAX(m.msg_time) DESC LIMIT 20`
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ActiveGroup
	for rows.Next() {
		var (
			g    ActiveGroup
			name sql.NullString
		)
		if err := rows.Scan(&g.GroupID, &name, &g.Count); err != nil {
			return nil, err
		}
		g.Name = name.String
		out = append(out, g)
	}
	return out, rows.Err()
}

// GetMessageByMessageID loads a message by its OneBot message id (unique per group).
func (s *Store) GetMessageByMessageID(ctx context.Context, groupID, messageID string) (*Message, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+messageSelectCols+` FROM messages WHERE group_id = ? AND message_id = ? LIMIT 1`, groupID, messageID)
	return scanMessage(row)
}

// PruneMessagesBefore deletes messages older than the cutoff.
func (s *Store) PruneMessagesBefore(ctx context.Context, cutoff time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM messages WHERE msg_time < ?`, cutoff.Unix())
	if err != nil {
		return 0, fmt.Errorf("prune messages: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// DeleteMessagesByUser removes every message belonging to a bound identity
// (right-to-erasure support).
func (s *Store) DeleteMessagesByUser(ctx context.Context, qqUID string) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM messages WHERE sender_qq = ?`, qqUID)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// CountMessagesByUser counts stored messages sent by a QQ identity.
func (s *Store) CountMessagesByUser(ctx context.Context, qqUID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE sender_qq = ?`, qqUID).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return n, err
}
