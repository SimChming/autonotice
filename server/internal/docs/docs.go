// Package docs generates xlsx / docx / pdf documents locally and uploads them
// through NapCat's OneBot file actions.
package docs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/qqsched/server/internal/onebot"
	"github.com/qqsched/server/internal/store"
)

// Section is one heading/body block of a document.
type Section struct {
	Heading string `json:"heading"`
	Body    string `json:"body"`
}

// Request is a model-authored document description.
type Request struct {
	Type     string    `json:"type"`
	Title    string    `json:"title"`
	Sections []Section `json:"sections"`
	Rows     [][]string `json:"rows"`
	UserQQ   string    `json:"-"`
	ChatKey  string    `json:"-"`
}

// Service owns the document output directory and generation.
type Service struct {
	st       *store.Store
	root     string
	fontPath string
	quota    func() int
	log      *slog.Logger

	fontOnce sync.Once
	fontRes  string
}

// New builds the document service. root is created lazily on first write.
func New(st *store.Store, root, fontPath string, quota func() int, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	if quota == nil {
		quota = func() int { return 2 }
	}
	return &Service{st: st, root: root, fontPath: fontPath, quota: quota, log: log}
}

// Quota returns the per-user daily document limit.
func (s *Service) Quota() int {
	if s == nil || s.quota == nil {
		return 2
	}
	return s.quota()
}

// TodayCount counts documents a QQ produced since local midnight.
func (s *Service) TodayCount(ctx context.Context, userQQ string) (int, error) {
	now := time.Now()
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	return s.st.CountDocFilesSince(ctx, userQQ, start)
}

// Generate writes the file and records it in doc_files.
func (s *Service) Generate(ctx context.Context, req Request) (*store.DocFile, error) {
	typ, ext, err := normalizeType(req.Type)
	if err != nil {
		return nil, err
	}
	title := cleanTitle(req.Title)
	if title == "" {
		title = "文档"
	}
	if err := os.MkdirAll(s.root, 0o755); err != nil {
		return nil, fmt.Errorf("create docs dir: %w", err)
	}
	id := uuid.NewString()
	absRoot, err := filepath.Abs(s.root)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(absRoot, id+"."+ext)

	switch typ {
	case "xlsx":
		err = writeXLSX(path, title, req)
	case "docx":
		err = writeDOCX(path, title, req)
	case "pdf":
		err = s.writePDF(path, title, req)
	default:
		err = fmt.Errorf("unsupported document type %q", typ)
	}
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	file := &store.DocFile{
		ID:        id,
		UserQQ:    req.UserQQ,
		ChatKey:   req.ChatKey,
		Filename:  title + "." + ext,
		Type:      typ,
		Path:      path,
		SizeBytes: info.Size(),
		CreatedAt: time.Now().UTC(),
	}
	if err := s.st.CreateDocFile(ctx, file); err != nil {
		return nil, err
	}
	return file, nil
}

// Send uploads a generated file to the originating chat.
func (s *Service) Send(ctx context.Context, api onebot.APICaller, file *store.DocFile, groupID, userID string) error {
	if api == nil {
		return errors.New("onebot api unavailable")
	}
	if file == nil || file.Path == "" {
		return errors.New("document not found")
	}
	params := map[string]any{
		"file": "file://" + filepath.ToSlash(file.Path),
		"name": file.Filename,
	}
	action := "upload_private_file"
	if groupID != "" {
		action = "upload_group_file"
		params["group_id"] = groupID
	} else {
		params["user_id"] = userID
	}
	if _, err := api.CallAction(ctx, action, params); err == nil {
		return nil
	} else {
		// NapCat builds differ on whether local paths need the file:// prefix.
		params["file"] = filepath.ToSlash(file.Path)
		if _, retryErr := api.CallAction(ctx, action, params); retryErr != nil {
			return fmt.Errorf("%w（本地路径重试也失败: %v）", err, retryErr)
		}
	}
	return nil
}

// Resend re-uploads a previously generated file to its original chat.
func (s *Service) Resend(ctx context.Context, api onebot.APICaller, id string) (*store.DocFile, error) {
	file, err := s.st.GetDocFile(ctx, id)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(file.Path); err != nil {
		return nil, fmt.Errorf("file missing on disk: %w", err)
	}
	groupID, userID := parseChatKey(file.ChatKey)
	if err := s.Send(ctx, api, file, groupID, userID); err != nil {
		return nil, err
	}
	return file, nil
}

// PDFFontReady reports whether a usable TTF font was found.
func (s *Service) PDFFontReady() bool { return s.resolveFont() != "" }

// SaveDraft persists the multi-turn slot state for a chat.
func (s *Service) SaveDraft(ctx context.Context, chatKey, typ string, slot any) error {
	buf, err := json.Marshal(slot)
	if err != nil {
		return err
	}
	return s.st.SaveDocDraft(ctx, chatKey, typ, string(buf))
}

// Draft returns the stored slot JSON and type for a chat ("" when absent).
func (s *Service) Draft(ctx context.Context, chatKey string) (typ, slotJSON string, err error) {
	d, err := s.st.GetDocDraft(ctx, chatKey)
	if err != nil || d == nil {
		return "", "", err
	}
	return d.Type, d.SlotJSON, nil
}

// ClearDraft removes the stored slot state for a chat.
func (s *Service) ClearDraft(ctx context.Context, chatKey string) error {
	return s.st.ClearDocDraft(ctx, chatKey)
}

func (s *Service) resolveFont() string {
	s.fontOnce.Do(func() {
		s.fontRes = findFont(s.fontPath)
	})
	return s.fontRes
}

// findFont looks for a TrueType font with CJK coverage. fpdf cannot load TTC
// collections, so only .ttf files are accepted.
func findFont(preferred string) string {
	if preferred != "" && strings.HasSuffix(strings.ToLower(preferred), ".ttf") {
		if _, err := os.Stat(preferred); err == nil {
			return preferred
		}
	}
	candidates := []string{
		"/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
		"/usr/share/fonts/truetype/arphic/uming.ttc",
		"/usr/share/fonts/truetype/wqy/wqy-microhei.ttf",
		`C:\Windows\Fonts\simhei.ttf`,
		`C:\Windows\Fonts\msyh.ttf`,
	}
	for _, p := range candidates {
		if !strings.HasSuffix(strings.ToLower(p), ".ttf") {
			continue
		}
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	// Last resort: scan the common font roots for any CJK-capable TTF.
	roots := []string{"/usr/share/fonts", "/usr/local/share/fonts"}
	for _, root := range roots {
		var found string
		_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil || found != "" || d.IsDir() {
				return nil
			}
			low := strings.ToLower(d.Name())
			if !strings.HasSuffix(low, ".ttf") {
				return nil
			}
			if strings.Contains(low, "cjk") || strings.Contains(low, "droid") ||
				strings.Contains(low, "wqy") || strings.Contains(low, "hei") ||
				strings.Contains(low, "song") || strings.Contains(low, "noto") {
				found = path
			}
			return nil
		})
		if found != "" {
			return found
		}
	}
	return ""
}

func normalizeType(t string) (typ, ext string, err error) {
	switch strings.ToLower(strings.TrimSpace(t)) {
	case "xlsx", "excel", "sheet":
		return "xlsx", "xlsx", nil
	case "docx", "word", "doc":
		return "docx", "docx", nil
	case "pdf":
		return "pdf", "pdf", nil
	default:
		return "", "", fmt.Errorf("unsupported document type %q", t)
	}
}

func cleanTitle(title string) string {
	title = strings.TrimSpace(title)
	replacer := strings.NewReplacer(
		"/", " ", "\\", " ", ":", " ", "*", " ", "?", " ",
		"\"", " ", "<", " ", ">", " ", "|", " ", "\n", " ", "\t", " ",
	)
	title = strings.TrimSpace(replacer.Replace(title))
	if utf8.RuneCountInString(title) > 40 {
		r := []rune(title)
		title = string(r[:40])
	}
	return title
}

func parseChatKey(key string) (groupID, userID string) {
	if strings.HasPrefix(key, "group:") {
		return strings.TrimPrefix(key, "group:"), ""
	}
	if strings.HasPrefix(key, "private:") {
		return "", strings.TrimPrefix(key, "private:")
	}
	return "", ""
}
