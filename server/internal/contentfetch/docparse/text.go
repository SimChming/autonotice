package docparse

import (
	"bytes"
	"fmt"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

// parseText decodes bytes to a UTF-8 string, falling back to GBK for the common
// legacy encoding used by Chinese Windows files.
func parseText(data []byte) (string, error) {
	trimmed := bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	if utf8.Valid(trimmed) {
		return string(trimmed), nil
	}
	out, err := simplifiedchinese.GBK.NewDecoder().Bytes(trimmed)
	if err != nil {
		return string(trimmed), fmt.Errorf("text: gbk decode: %w", err)
	}
	return string(out), nil
}
