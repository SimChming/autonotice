package docparse

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strings"
)

// parseDOCX extracts text from word/document.xml inside the OOXML zip using the
// standard library only.
func parseDOCX(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("docx: open zip: %w", err)
	}
	if err := GuardZip(zr); err != nil {
		return "", err
	}
	var doc *zip.File
	for _, f := range zr.File {
		if f.Name == "word/document.xml" {
			doc = f
			break
		}
	}
	if doc == nil {
		return "", errors.New("docx: word/document.xml not found")
	}
	rc, err := doc.Open()
	if err != nil {
		return "", fmt.Errorf("docx: open document.xml: %w", err)
	}
	defer rc.Close()

	dec := xml.NewDecoder(io.LimitReader(rc, 32<<20))
	var b strings.Builder
	inText := false
	for {
		tok, err := dec.Token()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return "", fmt.Errorf("docx: decode xml: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "t":
				inText = true
			case "tab":
				b.WriteString("\t")
			case "br", "cr":
				b.WriteString("\n")
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inText = false
			case "p":
				b.WriteString("\n")
			case "tr":
				b.WriteString("\n")
			case "tc":
				b.WriteString("\t")
			}
		case xml.CharData:
			if inText {
				b.Write([]byte(t))
			}
		}
	}
	return normalizeWhitespace(b.String()), nil
}
