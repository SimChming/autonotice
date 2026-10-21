package docparse

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/xuri/excelize/v2"
)

// maxXLSXRows bounds how many rows per sheet are emitted.
const maxXLSXRows = 3000

// parseXLSX extracts cell text from an xlsx/xlsm workbook.
func parseXLSX(data []byte) (string, error) {
	f, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("xlsx: open: %w", err)
	}
	defer func() { _ = f.Close() }()

	var b strings.Builder
	for _, sheet := range f.GetSheetList() {
		rows, err := f.GetRows(sheet)
		if err != nil {
			continue
		}
		b.WriteString("# ")
		b.WriteString(sheet)
		b.WriteString("\n")
		for i, row := range rows {
			if i >= maxXLSXRows {
				b.WriteString("...（更多行已省略）\n")
				break
			}
			b.WriteString(strings.Join(trimCells(row), "\t"))
			b.WriteString("\n")
		}
	}
	return normalizeWhitespace(b.String()), nil
}

func trimCells(row []string) []string {
	out := make([]string, len(row))
	for i, c := range row {
		out[i] = strings.TrimSpace(c)
	}
	return out
}
