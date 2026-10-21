package docs

import (
	"archive/zip"
	"os"
	"strconv"
	"strings"
)

// writeDOCX assembles a minimal but valid WordprocessingML package using only
// the standard library, so no extra dependency is needed.
func writeDOCX(path, title string, req Request) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	zw := zip.NewWriter(f)
	defer func() { _ = zw.Close() }()

	contentTypes := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
	rels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

	var body strings.Builder
	body.WriteString(paragraph(title, true, 32, "center"))
	for _, sec := range req.Sections {
		if strings.TrimSpace(sec.Heading) != "" {
			body.WriteString(paragraph(sec.Heading, true, 26, ""))
		}
		if strings.TrimSpace(sec.Body) != "" {
			body.WriteString(paragraph(sec.Body, false, 22, ""))
		}
	}
	if rows := normalizeRows(req.Rows); len(rows) > 0 {
		body.WriteString(table(rows))
	}

	document := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>` + body.String() + `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`

	for _, part := range []struct{ name, data string }{
		{"[Content_Types].xml", contentTypes},
		{"_rels/.rels", rels},
		{"word/document.xml", document},
	} {
		w, err := zw.Create(part.name)
		if err != nil {
			return err
		}
		if _, err := w.Write([]byte(part.data)); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return nil
}

func paragraph(text string, bold bool, sizeHalfPoints int, align string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	var b strings.Builder
	b.WriteString(`<w:p>`)
	if align != "" || bold {
		b.WriteString(`<w:pPr>`)
		if align != "" {
			b.WriteString(`<w:jc w:val="` + align + `"/>`)
		}
		b.WriteString(`</w:pPr>`)
	}
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if i > 0 {
			b.WriteString(`<w:r><w:br/></w:r>`)
		}
		b.WriteString(`<w:r><w:rPr>`)
		if bold {
			b.WriteString(`<w:b/>`)
		}
		if sizeHalfPoints > 0 {
			b.WriteString(`<w:sz w:val="` + strconv.Itoa(sizeHalfPoints) + `"/><w:szCs w:val="` + strconv.Itoa(sizeHalfPoints) + `"/>`)
		}
		b.WriteString(`</w:rPr><w:t xml:space="preserve">` + escapeXML(line) + `</w:t></w:r>`)
	}
	b.WriteString(`</w:p>`)
	return b.String()
}

func table(rows [][]string) string {
	var b strings.Builder
	b.WriteString(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>`)
	for _, edge := range []string{"top", "left", "bottom", "right", "insideH", "insideV"} {
		b.WriteString(`<w:` + edge + ` w:val="single" w:sz="4" w:space="0" w:color="A0A0A0"/>`)
	}
	b.WriteString(`</w:tblBorders></w:tblPr><w:tblGrid>`)
	cols := len(rows[0])
	for i := 0; i < cols; i++ {
		b.WriteString(`<w:gridCol w:w="` + strconv.Itoa(9000/cols) + `"/>`)
	}
	b.WriteString(`</w:tblGrid>`)
	for _, row := range rows {
		b.WriteString(`<w:tr>`)
		for _, cell := range row {
			b.WriteString(`<w:tc><w:tcPr><w:tcW w:w="` + strconv.Itoa(9000/cols) + `" w:type="dxa"/></w:tcPr>`)
			b.WriteString(paragraph(cell, false, 20, ""))
			b.WriteString(`</w:tc>`)
		}
		b.WriteString(`</w:tr>`)
	}
	b.WriteString(`</w:tbl>`)
	return b.String()
}

func escapeXML(s string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	)
	return replacer.Replace(s)
}
