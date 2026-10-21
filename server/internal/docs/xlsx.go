package docs

import (
	"strings"

	"github.com/xuri/excelize/v2"
)

// writeXLSX builds a simple spreadsheet: an optional header row plus data rows,
// or a two-column heading/body layout when only sections were provided.
func writeXLSX(path, title string, req Request) error {
	f := excelize.NewFile()
	defer func() { _ = f.Close() }()

	sheet := "Sheet1"
	rows := normalizeRows(req.Rows)
	if len(rows) == 0 {
		rows = [][]string{{"项目", "内容"}}
		for _, sec := range req.Sections {
			rows = append(rows, []string{sec.Heading, sec.Body})
		}
	}

	for i, row := range rows {
		cell, err := excelize.CoordinatesToCellName(1, i+1)
		if err != nil {
			return err
		}
		if err := f.SetSheetRow(sheet, cell, &row); err != nil {
			return err
		}
	}
	_ = f.SetColWidth(sheet, "A", "A", 22)
	_ = f.SetColWidth(sheet, "B", "Z", 40)

	headerStyle, err := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Size: 12},
		Fill:      excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{"#E8F1FF"}},
		Alignment: &excelize.Alignment{Vertical: "center", WrapText: true},
	})
	if err == nil {
		if err := f.SetCellStyle(sheet, "A1", "Z1", headerStyle); err != nil {
			return err
		}
	}
	wrapStyle, err := f.NewStyle(&excelize.Style{
		Alignment: &excelize.Alignment{Vertical: "top", WrapText: true},
	})
	if err == nil {
		last, _ := excelize.CoordinatesToCellName(26, len(rows))
		_ = f.SetCellStyle(sheet, "A2", last, wrapStyle)
	}
	_ = title
	return f.SaveAs(path)
}

// normalizeRows drops trailing empty rows and pads ragged rows.
func normalizeRows(in [][]string) [][]string {
	width := 0
	for _, r := range in {
		if len(r) > width {
			width = len(r)
		}
	}
	if width == 0 {
		return nil
	}
	out := make([][]string, 0, len(in))
	for _, r := range in {
		if strings.TrimSpace(strings.Join(r, "")) == "" {
			continue
		}
		row := make([]string, width)
		copy(row, r)
		out = append(out, row)
	}
	return out
}
