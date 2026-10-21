package docparse

import (
	"encoding/csv"
	"errors"
	"io"
	"strings"
)

// parseCSV reads a CSV/TSV file, tolerating malformed rows.
func parseCSV(data []byte) (string, error) {
	text, err := parseText(data)
	if err != nil {
		return "", err
	}
	text = strings.TrimPrefix(text, "\ufeff")
	r := csv.NewReader(strings.NewReader(text))
	r.LazyQuotes = true
	r.FieldsPerRecord = -1
	r.TrimLeadingSpace = true

	var b strings.Builder
	for i := 0; ; i++ {
		if i >= 5000 {
			b.WriteString("...（更多行已省略）\n")
			break
		}
		rec, err := r.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			// Skip a malformed line rather than failing the whole file.
			continue
		}
		b.WriteString(strings.Join(rec, "\t"))
		b.WriteString("\n")
	}
	return normalizeWhitespace(b.String()), nil
}
