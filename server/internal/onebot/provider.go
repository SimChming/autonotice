package onebot

import (
	"context"
	"encoding/json"
	"net/http"
)

// Provider is the protocol-independent bot adapter. Swapping NapCat for
// Lagrange or a different OneBot version only means a different implementation.
type Provider interface {
	// Name identifies the concrete implementation.
	Name() string
	// Start begins consuming events (for reverse-WS this merely records state).
	Start(ctx context.Context) error
	// Stop releases resources and closes live connections.
	Stop(ctx context.Context) error
	// Events returns the stream of normalized inbound events.
	Events() <-chan Event
	// API returns the outbound action caller.
	API() APICaller
}

// InboundHandler is implemented by providers that receive events over HTTP:
// reverse WebSocket upgrades (NapCat connects in) or http_post reports. The
// mount path is configured separately so the router can register it.
type InboundHandler interface {
	Handler() http.Handler
}

// APICaller performs OneBot actions against the connected implementation.
type APICaller interface {
	SendPrivateMsg(ctx context.Context, userID, message string) (int64, error)
	SendGroupMsg(ctx context.Context, groupID, message string) (int64, error)
	GetGroupFileURL(ctx context.Context, groupID, fileID string, busid int) (string, error)
	GetGroupMsgHistory(ctx context.Context, groupID string, count int, messageSeq int64) ([]map[string]any, error)
	// GetGroupInfo resolves a group display name (used to label schedule sources).
	GetGroupInfo(ctx context.Context, groupID string) (name string, err error)
	// CallAction invokes any OneBot action by name (NapCat exposes the full
	// v11 action set, e.g. send_group_msg with CQ image segments). params is
	// the raw action payload; the result is the unwrapped `data` field.
	CallAction(ctx context.Context, action string, params map[string]any) (json.RawMessage, error)
}
