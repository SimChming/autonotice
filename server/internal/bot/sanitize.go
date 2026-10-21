package bot

import (
	"regexp"
	"strings"

	"github.com/qqsched/server/internal/settings"
)

var cqSegmentRe = regexp.MustCompile(`\[CQ:([a-zA-Z0-9_]+)(?:,[^\]]*)?\]`)

// sanitizeCQ strips CQ codes for media categories the administrator disabled,
// so a plain-text reply cannot smuggle them past the action gate.
func sanitizeCQ(text string, caps settings.Capabilities) string {
	if text == "" {
		return ""
	}
	return cqSegmentRe.ReplaceAllStringFunc(text, func(seg string) string {
		sub := cqSegmentRe.FindStringSubmatch(seg)
		if len(sub) < 2 {
			return seg
		}
		switch strings.ToLower(sub[1]) {
		case "image":
			if !caps.Image {
				return ""
			}
		case "face", "mface":
			if !caps.Sticker {
				return ""
			}
		case "record":
			if !caps.Voice {
				return ""
			}
		case "video":
			if !caps.Video {
				return ""
			}
		case "file":
			if !caps.File {
				return ""
			}
		case "at":
			if !caps.AtAll && strings.Contains(strings.ToLower(seg), "qq=all") {
				return ""
			}
		}
		return seg
	})
}
