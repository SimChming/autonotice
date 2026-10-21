package bot

import (
	"strings"
)

// splitMessage breaks a reply into chunks of at most size runes without ever
// cutting a CQ code in half. Images and files embed long URLs or base64 data in
// their CQ code, so the old fixed-width split silently corrupted them and made
// NapCat reject the whole message.
func splitMessage(text string, size int) []string {
	if size <= 0 || text == "" {
		return []string{text}
	}
	var (
		chunks []string
		cur    strings.Builder
		curLen int
	)
	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			chunks = append(chunks, s)
		}
		cur.Reset()
		curLen = 0
	}
	pos := 0
	for pos < len(text) {
		loc := cqCodeRe.FindStringIndex(text[pos:])
		if loc == nil {
			appendPlain(&cur, &curLen, text[pos:], size, flush)
			break
		}
		start, end := pos+loc[0], pos+loc[1]
		appendPlain(&cur, &curLen, text[pos:start], size, flush)
		code := text[start:end]
		codeLen := len([]rune(code))
		if curLen > 0 && curLen+codeLen > size {
			flush()
		}
		cur.WriteString(code)
		curLen += codeLen
		pos = end
	}
	flush()
	if len(chunks) == 0 {
		return []string{text}
	}
	return chunks
}

// appendPlain appends plain text, preferring a natural break near the limit.
func appendPlain(cur *strings.Builder, curLen *int, plain string, size int, flush func()) {
	runes := []rune(plain)
	for len(runes) > 0 {
		avail := size - *curLen
		if avail <= 0 {
			flush()
			avail = size
		}
		if len(runes) <= avail {
			cur.WriteString(string(runes))
			*curLen += len(runes)
			return
		}
		cut := avail
		for i := avail - 1; i > 0; i-- {
			switch runes[i] {
			case '\n', '。', '！', '？', '；', '…', '.', '!', '?':
				cut = i + 1
			}
			if cut != avail {
				break
			}
		}
		cur.WriteString(string(runes[:cut]))
		*curLen += cut
		runes = runes[cut:]
		flush()
	}
}
