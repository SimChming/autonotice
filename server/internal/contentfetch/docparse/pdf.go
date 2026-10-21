package docparse

import (
	"bytes"
	"fmt"
	"io"
	"strings"

	"github.com/ledongthuc/pdf"
)

// parsePDF extracts the plain text layer of a PDF. Scanned PDFs yield little or
// no text, which the pipeline classifies as "empty" so it degrades to an alert.
func parsePDF(data []byte) (string, error) {
	reader, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("pdf: open: %w", err)
	}
	defer func() {
		// The underlying reader has no Close in this version.
		_ = reader
	}()

	rd, err := reader.GetPlainText()
	if err != nil {
		return "", fmt.Errorf("pdf: get text: %w", err)
	}
	buf := &bytes.Buffer{}
	if _, err := io.Copy(buf, rd); err != nil {
		// Partial text is still useful.
		if buf.Len() == 0 {
			return "", fmt.Errorf("pdf: read text: %w", err)
		}
	}
	return normalizeWhitespace(buf.String()), nil
}

func normalizeWhitespace(s string) string {
	lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		l = strings.TrimRight(l, " \t")
		out = append(out, l)
	}
	joined := strings.Join(out, "\n")
	for strings.Contains(joined, "\n\n\n") {
		joined = strings.ReplaceAll(joined, "\n\n\n", "\n\n")
	}
	return strings.TrimSpace(joined)
}
