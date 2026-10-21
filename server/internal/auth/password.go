package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const (
	passwordIterations = 120000
	passwordSaltBytes  = 16
	passwordKeyBytes   = 32
)

// HashPassword derives a salted PBKDF2-SHA256 hash in the form
// "pbkdf2_sha256$<iter>$<saltHex>$<hashHex>".
func HashPassword(password string) (string, error) {
	if strings.TrimSpace(password) == "" {
		return "", errors.New("auth: empty password")
	}
	salt := make([]byte, passwordSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	dk := pbkdf2SHA256([]byte(password), salt, passwordIterations, passwordKeyBytes)
	return fmt.Sprintf("pbkdf2_sha256$%d$%s$%s",
		passwordIterations, hex.EncodeToString(salt), hex.EncodeToString(dk)), nil
}

// VerifyPassword compares a password against a stored hash in constant time.
func VerifyPassword(stored, password string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2_sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter <= 0 {
		return false
	}
	salt, err := hex.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := hex.DecodeString(parts[3])
	if err != nil {
		return false
	}
	got := pbkdf2SHA256([]byte(password), salt, iter, len(want))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// pbkdf2SHA256 implements RFC 2898 PBKDF2 with HMAC-SHA256.
func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	hashLen := prf.Size()
	numBlocks := (keyLen + hashLen - 1) / hashLen

	var dk []byte
	block := make([]byte, 4)
	for i := 1; i <= numBlocks; i++ {
		prf.Reset()
		prf.Write(salt)
		binary.BigEndian.PutUint32(block, uint32(i))
		prf.Write(block)
		u := prf.Sum(nil)
		t := make([]byte, len(u))
		copy(t, u)
		for n := 1; n < iter; n++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(nil)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		dk = append(dk, t...)
	}
	return dk[:keyLen]
}
