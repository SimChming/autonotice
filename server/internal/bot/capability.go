package bot

import (
	"regexp"
	"strings"

	"github.com/qqsched/server/internal/settings"
)

// Capability keys mirror settings.Capabilities.
const (
	capImage   = "image"
	capSticker = "sticker"
	capVoice   = "voice"
	capVideo   = "video"
	capFile    = "file"
	capRecall  = "recall"
	capAtAll   = "at_all"
)

// actionCapabilities maps a OneBot action (plus message payload) to the
// capabilities it requires. Query-only actions return nil and stay allowed.
func actionCapabilities(action string, params map[string]any) []string {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "upload_group_file", "upload_private_file", "upload_group_file_folder", "upload_private_file_folder":
		return []string{capFile}
	case "delete_msg":
		return []string{capRecall}
	case "send_group_msg", "send_private_msg", "send_msg":
		var msg any
		if params != nil {
			msg = params["message"]
		}
		return messageCapabilities(msg)
	}
	return nil
}

var cqTypeRe = regexp.MustCompile(`\[CQ:([a-zA-Z0-9_]+)`)
var cqAtAllRe = regexp.MustCompile(`\[CQ:at,qq=all[^\]]*\]`)

// messageCapabilities inspects a OneBot message (CQ string or segment array).
func messageCapabilities(msg any) []string {
	seen := map[string]bool{}
	add := func(c string) {
		if c != "" {
			seen[c] = true
		}
	}
	switch m := msg.(type) {
	case string:
		for _, sub := range cqTypeRe.FindAllStringSubmatch(m, -1) {
			if len(sub) > 1 {
				add(cqCapability(strings.ToLower(sub[1])))
			}
		}
		if cqAtAllRe.MatchString(m) {
			add(capAtAll)
		}
	case []any:
		for _, item := range m {
			obj, ok := item.(map[string]any)
			if !ok {
				continue
			}
			typ, _ := obj["type"].(string)
			typ = strings.ToLower(strings.TrimSpace(typ))
			add(cqCapability(typ))
			if typ == "at" {
				if data, ok := obj["data"].(map[string]any); ok {
					if qq, _ := data["qq"].(string); qq == "all" {
						add(capAtAll)
					}
				}
			}
		}
	}
	out := make([]string, 0, len(seen))
	for c := range seen {
		out = append(out, c)
	}
	return out
}

func cqCapability(cqType string) string {
	switch cqType {
	case "image":
		return capImage
	case "face", "mface":
		return capSticker
	case "record":
		return capVoice
	case "video":
		return capVideo
	case "file":
		return capFile
	}
	return ""
}

func capEnabled(c settings.Capabilities, cap string) bool {
	switch cap {
	case capImage:
		return c.Image
	case capSticker:
		return c.Sticker
	case capVoice:
		return c.Voice
	case capVideo:
		return c.Video
	case capFile:
		return c.File
	case capRecall:
		return c.Recall
	case capAtAll:
		return c.AtAll
	}
	return true
}

func capLabel(cap string) string {
	switch cap {
	case capImage:
		return "图片"
	case capSticker:
		return "表情"
	case capVoice:
		return "语音"
	case capVideo:
		return "视频"
	case capFile:
		return "文件"
	case capRecall:
		return "撤回"
	case capAtAll:
		return "@全体成员"
	}
	return cap
}

// blockedAction reports whether an action hits a disabled capability.
func (s *Service) blockedAction(action string, params map[string]any) (bool, string) {
	caps := s.capabilities()
	for _, c := range actionCapabilities(action, params) {
		if !capEnabled(caps, c) {
			return true, capLabel(c)
		}
	}
	return false, ""
}
