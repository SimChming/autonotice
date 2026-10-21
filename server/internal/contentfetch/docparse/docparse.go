package docparse

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Limits for extraction.
const (
	// MaxOutputRunes caps how much text is returned.
	MaxOutputRunes = 200000
	// ParseTimeout bounds a single parse attempt.
	ParseTimeout = 25 * time.Second
)

// ErrUnsupported is returned for formats without a pure-Go parser (.doc, ...).
var ErrUnsupported = errors.New("docparse: unsupported format")

type parseResult struct {
	text string
	err  error
}

// ParseBytes dispatches to the right parser based on filename / MIME. It always
// runs under recover + timeout and truncates the result.
func ParseBytes(ctx context.Context, filename, mime string, data []byte) (string, error) {
	if len(data) == 0 {
		return "", errors.New("docparse: empty input")
	}
	t := Detect(filename, mime)
	var fn func() (string, error)
	switch t {
	case TypePDF:
		fn = func() (string, error) { return parsePDF(data) }
	case TypeXLSX:
		fn = func() (string, error) { return parseXLSX(data) }
	case TypeXLS:
		fn = func() (string, error) { return parseXLS(data) }
	case TypeDOCX:
		fn = func() (string, error) { return parseDOCX(data) }
	case TypeCSV:
		fn = func() (string, error) { return parseCSV(data) }
	case TypeText, TypeHTML:
		fn = func() (string, error) { return parseText(data) }
	case TypeDOC:
		return "", ErrUnsupported
	default:
		// Unknown extension: fall back to a best-effort text decode.
		fn = func() (string, error) { return parseText(data) }
	}

	text, err := runGuarded(ctx, ParseTimeout, fn)
	if err != nil {
		return "", err
	}
	return truncateRunes(strings.TrimSpace(text), MaxOutputRunes), nil
}

// runGuarded executes fn with panic recovery, a timeout and context support.
func runGuarded(ctx context.Context, timeout time.Duration, fn func() (string, error)) (string, error) {
	ch := make(chan parseResult, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				ch <- parseResult{err: fmt.Errorf("docparse: parser panic: %v", r)}
			}
		}()
		text, err := fn()
		ch <- parseResult{text: text, err: err}
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-timer.C:
		return "", fmt.Errorf("docparse: parse timeout after %s", timeout)
	case r := <-ch:
		return r.text, r.err
	}
}

func truncateRunes(s string, n int) string {
	if n <= 0 {
		return s
	}
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
