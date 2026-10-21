package contentfetch

import "strings"

// Blocked reason codes.
const (
	ReasonHTTP4xx    = "http_4xx"
	ReasonLoginWall  = "login_wall"
	ReasonCaptcha    = "captcha"
	ReasonJSRequired = "js_required"
	ReasonPaywall    = "paywall"
	ReasonEmpty      = "empty"
	ReasonScheme     = "scheme"
	ReasonTimeout    = "timeout"
	ReasonMismatch   = "mismatch"
	ReasonTooLarge   = "too_large"
)

// BlockInput carries everything the heuristics need.
type BlockInput struct {
	StatusCode int
	FinalURL   string
	BodyText   string
	BodyChars  int
	Scheme     bool // scheme-only link (weixin://, #小程序://)
	TimedOut   bool // fetch failed with timeout/TLS/DNS error
	JinaTried  bool
	JinaFailed bool
	TooLarge   bool
}

var (
	loginMarkers   = []string{"请登录", "登录后查看", "请先登录", "立即登录", "sign in", "log in to continue"}
	captchaMarkers = []string{"验证码", "人机验证", "环境异常", "请在微信中打开", "请在微信客户端打开", "滑动验证", "安全验证"}
	paywallMarkers = []string{"开通会员", "订阅后", "仅VIP", "仅会员", "剩余%可见", "开通后查看", "付费阅读"}
	jsMarkers      = []string{"启用 javascript", "enable javascript", "enable js", "requires javascript", "javascript is required"}
)

// Classify applies the blocked-content heuristics in priority order. It returns
// (blocked, reason); reason is empty when nothing matched.
func Classify(in BlockInput) (bool, string) {
	if in.Scheme {
		return true, ReasonScheme
	}
	if in.TooLarge {
		return true, ReasonTooLarge
	}
	if in.TimedOut {
		return true, ReasonTimeout
	}

	code := in.StatusCode
	if code == 401 || code == 403 || code == 429 {
		return true, ReasonHTTP4xx
	}
	if code >= 400 && code != 404 && code != 410 {
		return true, ReasonHTTP4xx
	}

	body := strings.ToLower(in.BodyText)
	finalURL := strings.ToLower(in.FinalURL)

	if strings.Contains(finalURL, "/login") || strings.Contains(finalURL, "passport") ||
		strings.Contains(finalURL, "/signin") || containsAny(body, loginMarkers) {
		return true, ReasonLoginWall
	}
	if containsAny(body, captchaMarkers) {
		return true, ReasonCaptcha
	}
	if containsAny(body, paywallMarkers) {
		return true, ReasonPaywall
	}
	if in.JinaTried && in.JinaFailed && in.BodyChars < 300 && containsAny(body, jsMarkers) {
		return true, ReasonJSRequired
	}
	if in.BodyChars == 0 {
		return true, ReasonEmpty
	}
	return false, ""
}

func containsAny(haystack string, needles []string) bool {
	for _, n := range needles {
		if strings.Contains(haystack, strings.ToLower(n)) {
			return true
		}
	}
	return false
}
