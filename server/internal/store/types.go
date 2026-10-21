package store

import "time"

// Fetch status values for content_assets.fetch_status.
const (
	FetchPending     = "pending"
	FetchOK          = "ok"
	FetchBlocked     = "blocked"
	FetchUnfetchable = "unfetchable"
	FetchFailed      = "failed"
	FetchTooLarge    = "too_large"
)

// Asset kind values.
const (
	AssetFile          = "file"
	AssetLink          = "link"
	AssetMiniapp       = "miniapp"
	AssetWechatArticle = "wechat_article"
)

// Summary run status values.
const (
	RunRunning = "running"
	RunOK      = "ok"
	RunFailed  = "failed"
)

// Group is a QQ group we are allowed to observe.
type Group struct {
	GroupID   string    `json:"group_id"`
	GroupName string    `json:"group_name"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Message is one normalized inbound chat message.
type Message struct {
	ID           string    `json:"id"`
	GroupID      string    `json:"group_id"`
	MessageID    string    `json:"message_id"`
	SenderQQ     string    `json:"sender_qq"`
	SenderName   string    `json:"sender_name"`
	MessageType  string    `json:"message_type"`
	SubType      string    `json:"sub_type"`
	Text         string    `json:"text"`
	RawMessage   string    `json:"raw_message"`
	SegmentsJSON string    `json:"segments_json"`
	Mentions     []string  `json:"mentions"`
	ReplyToMsgID string    `json:"reply_to_msg_id"`
	Fingerprint  string    `json:"fingerprint"`
	MsgTime      time.Time `json:"msg_time"`
	CreatedAt    time.Time `json:"created_at"`
}

// User is an application account.
type User struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	PasswordHash string    `json:"-"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// Binding links an app user to a QQ identity inside a group.
type Binding struct {
	ID         string     `json:"id"`
	UserID     string     `json:"user_id"`
	QQUID      string     `json:"qq_uid"`
	GroupID    string     `json:"group_id"`
	Verified   bool       `json:"verified"`
	VerifiedAt *time.Time `json:"verified_at"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

// BindCode is a short-lived group verification code.
type BindCode struct {
	Code      string    `json:"code"`
	UserID    string    `json:"user_id"`
	QQUID     string    `json:"qq_uid"`
	GroupID   string    `json:"group_id"`
	ExpiresAt time.Time `json:"expires_at"`
	Used      bool      `json:"used"`
	CreatedAt time.Time `json:"created_at"`
}

// SummaryRun records one DeepSeek summarization attempt.
type SummaryRun struct {
	ID           string     `json:"id"`
	UserID       string     `json:"user_id"`
	QQUID        string     `json:"qq_uid"`
	GroupID      string     `json:"group_id"`
	Status       string     `json:"status"`
	StartedAt    time.Time  `json:"started_at"`
	FinishedAt   *time.Time `json:"finished_at"`
	MessageCount int        `json:"message_count"`
	ItemCount    int        `json:"item_count"`
	Revision     int64      `json:"revision"`
	Error        string     `json:"error"`
}

// ContentAsset is one recognized file / link / miniapp card with its fetch
// result and blocked verdict.
type ContentAsset struct {
	ID            string     `json:"id"`
	GroupID       string     `json:"group_id"`
	MessageID     string     `json:"message_id"`
	SenderQQ      string     `json:"sender_qq"`
	// MessageType: "group" | "private" — 告警来源区分用。
	MessageType   string     `json:"message_type"`
	Kind          string     `json:"kind"`
	Title         string     `json:"title"`
	DeclaredURL   string     `json:"declared_url"`
	FileID        string     `json:"file_id"`
	BusID         string     `json:"busid"`
	FileName      string     `json:"file_name"`
	FileExt       string     `json:"file_ext"`
	SizeBytes     int64      `json:"size_bytes"`
	MIME          string     `json:"mime"`
	FetchStatus   string     `json:"fetch_status"`
	FinalURL      string     `json:"final_url"`
	HTTPStatus    int        `json:"http_status"`
	BodyText      string     `json:"body_text"`
	BodyChars     int        `json:"body_chars"`
	BlockedReason string     `json:"blocked_reason"`
	ContentHash   string     `json:"content_hash"`
	Fingerprint   string     `json:"fingerprint"`
	FetchedAt     *time.Time `json:"fetched_at"`
	CreatedAt     time.Time  `json:"created_at"`
}

// Alert is a "needs human review" notification.
type Alert struct {
	ID             string     `json:"id"`
	UserQQ         string     `json:"user_qq"`
	GroupID        string     `json:"group_id"`
	ContentAssetID string     `json:"content_asset_id"`
	Level          string     `json:"level"`
	Title          string     `json:"title"`
	Summary        string     `json:"summary"`
	ContextExcerpt string     `json:"context_excerpt"`
	ReviewReason   string     `json:"review_reason"`
	Delivered      bool       `json:"delivered"`
	ReadAt         *time.Time `json:"read_at"`
	CreatedAt      time.Time  `json:"created_at"`
	// MessageType: "group" | "private" — 区分消息来源于群聊还是私聊，
	// 避免客户端把私聊告警错误展示成 "群 xxx"。
	MessageType string `json:"message_type"`
	// SourceName: 群名或对方昵称（已清洗）。
	SourceName string `json:"source_name"`
	// SourceAvatar: 头像 URL（QQ 公开头像）。
	SourceAvatar string `json:"source_avatar"`
}

// Feedback is a user-submitted "Contact Us" entry shown in the admin back office.
type Feedback struct {
	ID        string    `json:"id"`
	UserQQ    string    `json:"user_qq"`
	UserID    string    `json:"user_id"`
	Subject   string    `json:"subject"`
	Body      string    `json:"body"`
	Contact   string    `json:"contact"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// UserState tracks the per-user schedule document revision and digest.
type UserState struct {
	UserID        string     `json:"user_id"`
	Revision      int64      `json:"revision"`
	Digest        string     `json:"digest"`
	LastSummaryAt *time.Time `json:"last_summary_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}
