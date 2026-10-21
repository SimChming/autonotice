package docparse

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
)

// MaxUncompressedBytes caps the total uncompressed size of an archive to guard
// against zip bombs.
const MaxUncompressedBytes = 128 << 20 // 128 MB

// MaxEntries caps the number of files inside an archive.
const MaxEntries = 4096

// GuardZip rejects archives that look like zip bombs.
func GuardZip(zr *zip.Reader) error {
	if len(zr.File) > MaxEntries {
		return fmt.Errorf("zipguard: too many entries (%d)", len(zr.File))
	}
	var total uint64
	for _, f := range zr.File {
		if f.UncompressedSize64 > MaxUncompressedBytes {
			return fmt.Errorf("zipguard: entry %s too large (%d bytes)", f.Name, f.UncompressedSize64)
		}
		total += f.UncompressedSize64
		if total > MaxUncompressedBytes {
			return errors.New("zipguard: total uncompressed size exceeds limit")
		}
	}
	return nil
}

// LimitedCopy copies at most limit bytes from r to w.
func LimitedCopy(w io.Writer, r io.Reader, limit int64) (int64, error) {
	return io.Copy(w, io.LimitReader(r, limit))
}
