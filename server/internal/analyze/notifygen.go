package analyze

import (
	"fmt"
	"strings"

	"github.com/qqsched/server/internal/store"
)

// ReasonText renders a human explanation for a blocked_reason code.
func ReasonText(reason string) string {
	switch reason {
	case "http_4xx":
		return "服务器返回了拒绝访问的状态（可能需要权限或已失效）"
	case "login_wall":
		return "该页面需要登录后才能查看"
	case "captcha":
		return "触发了验证码/人机验证，或需要在微信内打开"
	case "js_required":
		return "页面内容由 JavaScript 渲染，服务端无法直接读到正文"
	case "paywall":
		return "正文被付费/会员墙遮挡"
	case "empty":
		return "抓取到的正文为空（可能是扫描件或空页面）"
	case "scheme":
		return "这是小程序/微信专用链接，只能在手机端打开"
	case "timeout":
		return "抓取超时或网络不可达"
	case "mismatch":
		return "声明的标题与抓取到的正文内容明显不符"
	case "too_large":
		return "文件过大，已跳过解析"
	default:
		return "内容无法自动解析"
	}
}

// FallbackMessage builds the conservative four-part copy used when DeepSeek is
// unavailable or returns something unusable. It never pollutes the schedule.
func FallbackMessage(a store.ContentAsset, contextLines []string) (title, summary string) {
	what := describeWhat(a)

	line1 := "1) 是什么：" + what
	line2 := "2) 讲了什么："
	if a.BodyChars > 0 && a.BodyText != "" {
		line2 += "已抓取到约 " + itoa(a.BodyChars) + " 字正文，摘要：" + truncateRunes(squash(a.BodyText), 120)
	} else {
		line2 += "未能获取到正文内容。"
	}

	line3 := "3) 与前文关系："
	if len(contextLines) > 0 {
		last := contextLines[len(contextLines)-1]
		line3 += "该消息出现在以下群聊上下文中（最近一条：" + truncateRunes(squash(last), 80) + "）。"
	} else {
		line3 += "群聊中没有明显相关的前文。"
	}

	line4 := "4) 为何建议亲自查看：" + ReasonText(a.BlockedReason)
	if a.BlockedReason == "" {
		line4 = "4) 为何建议亲自查看：需要你本人结合群聊上下文判断。"
	}

	title = "需人工查看：" + what
	summary = strings.Join([]string{line1, line2, line3, line4}, "\n")
	return title, summary
}

func describeWhat(a store.ContentAsset) string {
	switch a.Kind {
	case store.AssetFile:
		name := a.FileName
		if name == "" {
			name = a.Title
		}
		if name == "" {
			name = "一个群文件"
		}
		return "群文件《" + name + "》"
	case store.AssetMiniapp:
		if a.Title != "" {
			return "小程序卡片「" + a.Title + "」"
		}
		return "一个小程序卡片"
	case store.AssetWechatArticle:
		if a.Title != "" {
			return "微信文章《" + a.Title + "》"
		}
		return "一篇微信文章"
	default:
		if a.Title != "" {
			return "链接《" + a.Title + "》"
		}
		if a.DeclaredURL != "" {
			return "链接 " + a.DeclaredURL
		}
		return "一条内容"
	}
}

func squash(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(s, "\n", " ")), " ")
}

func itoa(n int) string { return fmt.Sprintf("%d", n) }
