package docs

import (
	"fmt"
	"strings"

	"github.com/go-pdf/fpdf"
)

// writePDF renders the document with an embedded CJK font. Without a usable
// TrueType font it fails fast; the bot then falls back to docx.
func (s *Service) writePDF(path, title string, req Request) error {
	font := s.resolveFont()
	if font == "" {
		return fmt.Errorf("未找到可嵌入的中文 TTF 字体，无法生成 PDF")
	}
	pdf := fpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(18, 18, 18)
	pdf.AddPage()
	pdf.AddUTF8Font("cjk", "", font)
	pdf.SetFont("cjk", "", 16)
	pdf.MultiCell(0, 9, title, "", "C", false)
	pdf.Ln(4)

	pdf.SetFont("cjk", "", 12)
	for _, sec := range req.Sections {
		if strings.TrimSpace(sec.Heading) != "" {
			pdf.SetFont("cjk", "B", 13)
			pdf.MultiCell(0, 7.5, sec.Heading, "", "L", false)
			pdf.SetFont("cjk", "", 12)
		}
		if strings.TrimSpace(sec.Body) != "" {
			pdf.MultiCell(0, 6.5, sec.Body, "", "L", false)
			pdf.Ln(1.5)
		}
	}
	for _, row := range normalizeRows(req.Rows) {
		line := strings.Join(row, "  |  ")
		pdf.MultiCell(0, 6.5, line, "1", "L", false)
	}
	if err := pdf.OutputFileAndClose(path); err != nil {
		return fmt.Errorf("生成 PDF 失败: %w", err)
	}
	return nil
}
