package ingest

import (
	"encoding/json"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/qqsched/server/internal/onebot"
	"github.com/qqsched/server/internal/store"
)

var linkPattern = regexp.MustCompile(`https?://[^\s<>"'）】\]]+`)

// ExtractAssets walks the message segments of an event and produces content
// assets (files, links, miniapp cards and inline URLs). Deduplication happens
// later via the asset fingerprint.
func ExtractAssets(ev onebot.Event, messageRowID, groupID, senderQQ string, now time.Time) []store.ContentAsset {
	var out []store.ContentAsset
	seen := map[string]bool{}

	add := func(a store.ContentAsset) {
		a.ID = ""
		a.GroupID = groupID
		a.MessageID = messageRowID
		a.SenderQQ = senderQQ
		a.CreatedAt = now
		a.FetchStatus = store.FetchPending
		if a.Fingerprint == "" {
			a.Fingerprint = assetFingerprint(groupID, a.Kind, firstNonEmpty(a.DeclaredURL, a.FileID))
		}
		if a.Fingerprint == "" || seen[a.Fingerprint] {
			return
		}
		seen[a.Fingerprint] = true
		out = append(out, a)
	}

	for _, seg := range ev.Segments {
		switch seg.Type {
		case "file":
			fileID := seg.Str("file_id")
			if fileID == "" {
				continue
			}
			name := seg.Str("file")
			a := store.ContentAsset{
				Kind:      store.AssetFile,
				FileID:    fileID,
				BusID:     seg.Str("busid"),
				FileName:  name,
				FileExt:   strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), "."),
				SizeBytes: int64(seg.Int("file_size")),
			}
			add(a)

		case "share":
			link := seg.Str("url")
			if link == "" {
				continue
			}
			add(store.ContentAsset{
				Kind:        kindForURL(link),
				Title:       seg.Str("title"),
				DeclaredURL: link,
			})

		case "json", "lightapp":
			raw := firstNonEmpty(seg.Str("data"), seg.Str("text"))
			title, desc, link := parseArk(raw)
			if link == "" && title == "" {
				continue
			}
			add(store.ContentAsset{
				Kind:        kindForURL(link),
				Title:       firstNonEmpty(title, desc),
				DeclaredURL: link,
			})

		case "text":
			for _, link := range ExtractLinks(seg.Str("text")) {
				add(store.ContentAsset{
					Kind:        kindForURL(link),
					DeclaredURL: link,
				})
			}

		case "image":
			// Images are out of scope (no OCR): nothing is extracted.
		}
	}

	// Also scan the raw message for links that were not captured otherwise.
	if ev.Text != "" {
		for _, link := range ExtractLinks(ev.Text) {
			add(store.ContentAsset{
				Kind:        kindForURL(link),
				DeclaredURL: link,
			})
		}
	}
	return out
}

// ExtractLinks returns unique http(s) links found in the given text.
func ExtractLinks(text string) []string {
	matches := linkPattern.FindAllString(text, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		m = strings.TrimRight(m, ".,;:!?，。；：！？")
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		out = append(out, m)
	}
	return out
}

// kindForURL classifies a link into one of the asset kinds.
func kindForURL(link string) string {
	link = strings.TrimSpace(link)
	if link == "" {
		return store.AssetMiniapp
	}
	if strings.HasPrefix(strings.ToLower(link), "http://") || strings.HasPrefix(strings.ToLower(link), "https://") {
		if strings.Contains(link, "mp.weixin.qq.com") || strings.Contains(link, "weixin.qq.com/s") {
			return store.AssetWechatArticle
		}
		return store.AssetLink
	}
	// weixin://, #小程序://, wxaurl.cn handled elsewhere -> miniapp.
	return store.AssetMiniapp
}

type arkDetail struct {
	Title    string `json:"title"`
	Desc     string `json:"desc"`
	URL      string `json:"url"`
	QQDocURL string `json:"qqdocurl"`
}

type arkMeta struct {
	Detail1 *arkDetail `json:"detail_1"`
	Detail  *arkDetail `json:"detail"`
	News    *arkDetail `json:"news"`
	Invite  *arkDetail `json:"invite"`
	Contact *arkDetail `json:"contact"`
}

type arkPayload struct {
	App    string          `json:"app"`
	Desc   string          `json:"desc"`
	Prompt string          `json:"prompt"`
	Meta   json.RawMessage `json:"meta"`
}

// parseArk extracts a title, description and URL from an ark/miniapp card JSON.
func parseArk(raw string) (title, desc, link string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", "", ""
	}
	var payload arkPayload
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		// Not JSON at all: treat it as a plain link if it looks like one.
		if links := ExtractLinks(raw); len(links) > 0 {
			return "", "", links[0]
		}
		return "", "", ""
	}
	desc = strings.TrimSpace(payload.Desc)
	if payload.Prompt != "" && desc == "" {
		desc = strings.TrimSpace(payload.Prompt)
	}

	if len(payload.Meta) > 0 {
		var meta map[string]arkDetail
		if err := json.Unmarshal(payload.Meta, &meta); err == nil {
			for _, d := range meta {
				candidate := firstNonEmpty(d.QQDocURL, d.URL)
				if candidate != "" {
					link = candidate
					title = firstNonEmpty(d.Title, d.Desc)
					if title != "" {
						return title, desc, link
					}
				}
			}
		}
	}
	if links := ExtractLinks(raw); len(links) > 0 {
		link = links[0]
	}
	return title, desc, link
}

func assetFingerprint(groupID, kind, key string) string {
	if key == "" {
		return ""
	}
	return "asset-" + hashKey(groupID, kind, key)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// SanitizeURL keeps only http(s) targets, returning "" otherwise (used to decide
// whether a declared URL is directly fetchable).
func SanitizeURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
		return u.String()
	default:
		return ""
	}
}
