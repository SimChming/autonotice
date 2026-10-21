// Package docparse extracts plain text from downloaded documents. Every parser
// runs under a recover + timeout guard because several third-party decoders
// panic on malformed input.
package docparse

import (
	"path/filepath"
	"strings"
)

// DocType enumerates supported document formats.
type DocType int

const (
	TypeUnknown DocType = iota
	TypePDF
	TypeXLSX
	TypeXLS
	TypeDOCX
	TypeDOC
	TypeCSV
	TypeText
	TypeHTML
)

// String renders the doc type for logging.
func (t DocType) String() string {
	switch t {
	case TypePDF:
		return "pdf"
	case TypeXLSX:
		return "xlsx"
	case TypeXLS:
		return "xls"
	case TypeDOCX:
		return "docx"
	case TypeDOC:
		return "doc"
	case TypeCSV:
		return "csv"
	case TypeText:
		return "text"
	case TypeHTML:
		return "html"
	default:
		return "unknown"
	}
}

// Detect chooses a parser by extension first and MIME type second.
func Detect(filename, mime string) DocType {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(filename), "."))
	switch ext {
	case "pdf":
		return TypePDF
	case "xlsx", "xlsm":
		return TypeXLSX
	case "xls":
		return TypeXLS
	case "docx":
		return TypeDOCX
	case "doc":
		return TypeDOC
	case "csv", "tsv":
		return TypeCSV
	case "txt", "md", "log", "json", "xml":
		return TypeText
	case "html", "htm":
		return TypeHTML
	}

	mime = strings.ToLower(strings.TrimSpace(mime))
	if i := strings.IndexByte(mime, ';'); i >= 0 {
		mime = strings.TrimSpace(mime[:i])
	}
	switch {
	case strings.Contains(mime, "pdf"):
		return TypePDF
	case strings.Contains(mime, "spreadsheetml") || strings.Contains(mime, "sheet"):
		return TypeXLSX
	case mime == "application/vnd.ms-excel":
		return TypeXLS
	case strings.Contains(mime, "wordprocessingml"):
		return TypeDOCX
	case mime == "application/msword":
		return TypeDOC
	case mime == "text/csv":
		return TypeCSV
	case strings.HasPrefix(mime, "text/"):
		return TypeText
	case strings.Contains(mime, "html"):
		return TypeHTML
	default:
		return TypeUnknown
	}
}
