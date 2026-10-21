// Package v11 implements the OneBot v11 adapter, both the reverse websocket
// server and the HTTP post fallback, plus the shared action caller.
package v11

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
)

// Caller is the low-level transport used to invoke a OneBot action. Both the
// reverse-WS server and the HTTP post client implement it.
type Caller interface {
	Call(ctx context.Context, action string, params map[string]any) (json.RawMessage, error)
}

// response is the standard OneBot action response envelope.
type response struct {
	Status  string          `json:"status"`
	Retcode int             `json:"retcode"`
	Msg     string          `json:"msg"`
	Wording string          `json:"wording"`
	Data    json.RawMessage `json:"data"`
}

// API implements onebot.APICaller on top of a transport Caller.
type API struct {
	c   Caller
	log *slog.Logger
}

// NewAPI builds an action caller over the given transport.
func NewAPI(c Caller, log *slog.Logger) *API {
	if log == nil {
		log = slog.Default()
	}
	return &API{c: c, log: log}
}

// SendPrivateMsg sends a private message and returns the message id.
func (a *API) SendPrivateMsg(ctx context.Context, userID, message string) (int64, error) {
	data, err := a.invoke(ctx, "send_private_msg", map[string]any{
		"user_id": idParam(userID),
		"message": message,
	})
	if err != nil {
		return 0, err
	}
	return extractMessageID(data), nil
}

// SendGroupMsg sends a group message and returns the message id.
func (a *API) SendGroupMsg(ctx context.Context, groupID, message string) (int64, error) {
	data, err := a.invoke(ctx, "send_group_msg", map[string]any{
		"group_id": idParam(groupID),
		"message":  message,
	})
	if err != nil {
		return 0, err
	}
	return extractMessageID(data), nil
}

// GetGroupFileURL resolves a (possibly expired) group file into a direct URL.
func (a *API) GetGroupFileURL(ctx context.Context, groupID, fileID string, busid int) (string, error) {
	params := map[string]any{
		"group_id": idParam(groupID),
		"file_id":  fileID,
	}
	if busid > 0 {
		params["busid"] = busid
	}
	data, err := a.invoke(ctx, "get_group_file_url", params)
	if err != nil {
		return "", err
	}
	var out struct {
		URL string `json:"url"`
	}
	_ = json.Unmarshal(data, &out)
	if out.URL == "" {
		return "", fmt.Errorf("get_group_file_url: empty url in response")
	}
	return out.URL, nil
}

// GetGroupMsgHistory fetches historical group messages (optional capability).
func (a *API) GetGroupMsgHistory(ctx context.Context, groupID string, count int, messageSeq int64) ([]map[string]any, error) {
	params := map[string]any{
		"group_id": idParam(groupID),
		"count":    count,
	}
	if messageSeq > 0 {
		params["message_seq"] = messageSeq
	}
	data, err := a.invoke(ctx, "get_group_msg_history", params)
	if err != nil {
		return nil, err
	}
	var out struct {
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("decode get_group_msg_history: %w", err)
	}
	return out.Messages, nil
}

// GetGroupInfo resolves a group's display name.
func (a *API) GetGroupInfo(ctx context.Context, groupID string) (string, error) {
	data, err := a.invoke(ctx, "get_group_info", map[string]any{
		"group_id": idParam(groupID),
	})
	if err != nil {
		return "", err
	}
	var out struct {
		GroupName string `json:"group_name"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", fmt.Errorf("decode get_group_info: %w", err)
	}
	return out.GroupName, nil
}

// CallAction invokes any OneBot action by name and returns the unwrapped
// `data` payload. It is the generic escape hatch behind the typed helpers.
func (a *API) CallAction(ctx context.Context, action string, params map[string]any) (json.RawMessage, error) {
	if params == nil {
		params = map[string]any{}
	}
	return a.invoke(ctx, action, params)
}

func (a *API) invoke(ctx context.Context, action string, params map[string]any) (json.RawMessage, error) {
	raw, err := a.c.Call(ctx, action, params)
	if err != nil {
		return nil, err
	}
	var resp response
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("%s: decode response: %w", action, err)
	}
	if resp.Status != "" && resp.Status != "ok" {
		return nil, fmt.Errorf("%s: status=%s retcode=%d msg=%s", action, resp.Status, resp.Retcode, resp.Msg)
	}
	if resp.Status == "" && resp.Retcode != 0 {
		return nil, fmt.Errorf("%s: retcode=%d msg=%s", action, resp.Retcode, resp.Msg)
	}
	return resp.Data, nil
}

func extractMessageID(data json.RawMessage) int64 {
	var out struct {
		MessageID json.Number `json:"message_id"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return 0
	}
	if out.MessageID == "" {
		return 0
	}
	n, _ := out.MessageID.Int64()
	return n
}

// idParam passes numeric-looking ids as numbers, everything else as a string.
func idParam(s string) any {
	if s == "" {
		return ""
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n
	}
	return s
}
