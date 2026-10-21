package docparse

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/extrame/xls"
)

// maxXLSRows bounds how many rows per sheet are emitted.
const maxXLSRows = 3000

// parseXLS extracts cell text from a legacy BIFF .xls workbook using the
// extrame/xls reader. It is wrapped by the caller's recover guard.
func parseXLS(data []byte) (string, error) {
	wb, err := xls.OpenReader(bytes.NewReader(data), "utf-8")
	if err != nil {
		return "", fmt.Errorf("xls: open: %w", err)
	}
	var b strings.Builder
	sheets := wb.NumSheets()
	for i := 0; i < sheets; i++ {
		sheet := wb.GetSheet(i)
		if sheet == nil {
			continue
		}
		b.WriteString("# ")
		b.WriteString(sheet.Name)
		b.WriteString("\n")
		last := int(sheet.MaxRow)
		for r := 0; r <= last && r < maxXLSRows; r++ {
			row := safeRow(sheet, r)
			if row == nil {
				continue
			}
			cols := row.LastCol()
			cells := make([]string, 0, cols)
			for c := 0; c < cols; c++ {
				cells = append(cells, strings.TrimSpace(row.Col(c)))
			}
			b.WriteString(strings.Join(cells, "\t"))
			b.WriteString("\n")
		}
	}
	return normalizeWhitespace(b.String()), nil
}

// safeRow wraps WorkSheet.Row, which dereferences the stored row pointer and
// panics when the row index is absent. Sparse sheets commonly leave gaps, so a
// recovered panic is treated as an empty row.
func safeRow(sheet *xls.WorkSheet, i int) (row *xls.Row) {
	defer func() {
		if recover() != nil {
			row = nil
		}
	}()
	return sheet.Row(i)
}
