package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
)

// --- groups ---

// UpsertGroup inserts or refreshes a watched group.
func (s *Store) UpsertGroup(ctx context.Context, groupID, name string) error {
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO groups (group_id, group_name, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)
		 ON CONFLICT(group_id) DO UPDATE SET
		     group_name = CASE WHEN excluded.group_name != '' THEN excluded.group_name ELSE groups.group_name END,
		     updated_at = excluded.updated_at`,
		groupID, name, now.Unix(), now.Unix())
	return err
}

// ListGroups returns every configured group.
func (s *Store) ListGroups(ctx context.Context) ([]Group, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT group_id, group_name, enabled, created_at, updated_at FROM groups ORDER BY group_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Group
	for rows.Next() {
		var (
			g         Group
			name      sql.NullString
			enabled   int
			createdAt sql.NullInt64
			updatedAt sql.NullInt64
		)
		if err := rows.Scan(&g.GroupID, &name, &enabled, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		g.GroupName = name.String
		g.Enabled = enabled != 0
		g.CreatedAt = timeVal(createdAt)
		g.UpdatedAt = timeVal(updatedAt)
		out = append(out, g)
	}
	return out, rows.Err()
}

// --- content assets ---

const assetCols = `id, group_id, message_id, sender_qq, kind, title, declared_url, file_id, busid,
	file_name, file_ext, size_bytes, mime, fetch_status, final_url, http_status, body_text,
	body_chars, blocked_reason, content_hash, fingerprint, fetched_at, created_at`

// InsertAsset stores an asset idempotently on fingerprint. The bool reports
// whether a new row was created.
func (s *Store) InsertAsset(ctx context.Context, a ContentAsset) (*ContentAsset, bool, error) {
	if a.ID == "" {
		a.ID = uuid.NewString()
	}
	if a.CreatedAt.IsZero() {
		a.CreatedAt = time.Now().UTC()
	}
	if a.FetchStatus == "" {
		a.FetchStatus = FetchPending
	}
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO content_assets (`+assetCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(fingerprint) DO NOTHING`,
		a.ID, a.GroupID, a.MessageID, a.SenderQQ, a.Kind, a.Title, a.DeclaredURL, a.FileID, a.BusID,
		a.FileName, a.FileExt, a.SizeBytes, a.MIME, a.FetchStatus, a.FinalURL, a.HTTPStatus, a.BodyText,
		a.BodyChars, a.BlockedReason, a.ContentHash, a.Fingerprint, unixPtr(a.FetchedAt), a.CreatedAt.Unix())
	if err != nil {
		return nil, false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil, false, err
	}
	if n == 0 {
		existing, err := s.GetAssetByFingerprint(ctx, a.Fingerprint)
		if err != nil {
			return nil, false, err
		}
		return existing, false, nil
	}
	return &a, true, nil
}

// GetAsset loads an asset by id.
func (s *Store) GetAsset(ctx context.Context, id string) (*ContentAsset, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+assetCols+` FROM content_assets WHERE id = ?`, id)
	return scanAsset(row)
}

// GetAssetByFingerprint loads an asset by its dedup fingerprint.
func (s *Store) GetAssetByFingerprint(ctx context.Context, fp string) (*ContentAsset, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+assetCols+` FROM content_assets WHERE fingerprint = ?`, fp)
	return scanAsset(row)
}

// FindRecentAssetByHash returns a recently fetched asset with the same content
// hash so its parsed body can be reused instead of re-fetching.
func (s *Store) FindRecentAssetByHash(ctx context.Context, hash string, since time.Time) (*ContentAsset, error) {
	if hash == "" {
		return nil, ErrNotFound
	}
	row := s.db.QueryRowContext(ctx,
		`SELECT `+assetCols+` FROM content_assets
		 WHERE content_hash = ? AND fetched_at IS NOT NULL AND fetched_at >= ? AND fetch_status != 'pending'
		 ORDER BY fetched_at DESC LIMIT 1`, hash, since.Unix())
	return scanAsset(row)
}

// ListPendingAssets returns assets awaiting fetch, oldest first.
func (s *Store) ListPendingAssets(ctx context.Context, limit int) ([]ContentAsset, error) {
	q := `SELECT ` + assetCols + ` FROM content_assets WHERE fetch_status = 'pending' ORDER BY created_at ASC`
	if limit > 0 {
		q += " LIMIT " + itoa(limit)
	}
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanAssets(rows)
}

// ListAssetsByMessage returns every asset extracted from one message.
func (s *Store) ListAssetsByMessage(ctx context.Context, groupID, messageID string) ([]ContentAsset, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+assetCols+` FROM content_assets WHERE group_id = ? AND message_id = ? ORDER BY created_at ASC`,
		groupID, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanAssets(rows)
}

// UpdateAssetResult persists the outcome of a fetch / parse cycle.
func (s *Store) UpdateAssetResult(ctx context.Context, a ContentAsset) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE content_assets SET
		   fetch_status = ?, final_url = ?, http_status = ?, body_text = ?, body_chars = ?,
		   blocked_reason = ?, content_hash = ?, mime = ?, fetched_at = ?
		 WHERE id = ?`,
		a.FetchStatus, a.FinalURL, a.HTTPStatus, a.BodyText, a.BodyChars,
		a.BlockedReason, a.ContentHash, a.MIME, unixPtr(a.FetchedAt), a.ID)
	return err
}

// CountGroupFetchesSince counts fetch attempts for a group since a time,
// supporting the per-group hourly rate limit.
func (s *Store) CountGroupFetchesSince(ctx context.Context, groupID string, since time.Time) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM content_assets WHERE group_id = ? AND fetched_at IS NOT NULL AND fetched_at >= ?`,
		groupID, since.Unix()).Scan(&n)
	return n, err
}

func scanAssets(rows *sql.Rows) ([]ContentAsset, error) {
	var out []ContentAsset
	for rows.Next() {
		a, err := scanAsset(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

func scanAsset(row rowScanner) (*ContentAsset, error) {
	var (
		a         ContentAsset
		title     sql.NullString
		declared  sql.NullString
		fileID    sql.NullString
		busID     sql.NullString
		fileName  sql.NullString
		fileExt   sql.NullString
		sizeBytes sql.NullInt64
		mime      sql.NullString
		finalURL  sql.NullString
		httpStat  sql.NullInt64
		bodyText  sql.NullString
		bodyChars sql.NullInt64
		blocked   sql.NullString
		hash      sql.NullString
		senderQQ  sql.NullString
		fetchedAt sql.NullInt64
		createdAt sql.NullInt64
	)
	if err := row.Scan(&a.ID, &a.GroupID, &a.MessageID, &senderQQ, &a.Kind, &title, &declared, &fileID, &busID,
		&fileName, &fileExt, &sizeBytes, &mime, &a.FetchStatus, &finalURL, &httpStat, &bodyText,
		&bodyChars, &blocked, &hash, &a.Fingerprint, &fetchedAt, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	a.SenderQQ = senderQQ.String
	a.Title = title.String
	a.DeclaredURL = declared.String
	a.FileID = fileID.String
	a.BusID = busID.String
	a.FileName = fileName.String
	a.FileExt = fileExt.String
	if sizeBytes.Valid {
		a.SizeBytes = sizeBytes.Int64
	}
	a.MIME = mime.String
	a.FinalURL = finalURL.String
	if httpStat.Valid {
		a.HTTPStatus = int(httpStat.Int64)
	}
	a.BodyText = bodyText.String
	if bodyChars.Valid {
		a.BodyChars = int(bodyChars.Int64)
	}
	a.BlockedReason = blocked.String
	a.ContentHash = hash.String
	a.FetchedAt = timePtr(fetchedAt)
	a.CreatedAt = timeVal(createdAt)
	return &a, nil
}

// --- alerts ---

const alertCols = `id, user_qq, group_id, content_asset_id, level, title, summary,
	context_excerpt, review_reason, delivered, read_at, created_at`

// InsertAlert stores an alert idempotently on (content_asset_id, user_qq).
func (s *Store) InsertAlert(ctx context.Context, al Alert) (*Alert, bool, error) {
	if al.ID == "" {
		al.ID = uuid.NewString()
	}
	if al.Level == "" {
		al.Level = "high"
	}
	if al.CreatedAt.IsZero() {
		al.CreatedAt = time.Now().UTC()
	}
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO alerts (`+alertCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(content_asset_id, user_qq) DO NOTHING`,
		al.ID, al.UserQQ, al.GroupID, al.ContentAssetID, al.Level, al.Title, al.Summary,
		al.ContextExcerpt, al.ReviewReason, boolInt(al.Delivered), unixPtr(al.ReadAt), al.CreatedAt.Unix())
	if err != nil {
		return nil, false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil, false, err
	}
	if n == 0 {
		existing, err := s.GetAlertByAssetUser(ctx, al.ContentAssetID, al.UserQQ)
		if err != nil {
			return nil, false, err
		}
		return existing, false, nil
	}
	return &al, true, nil
}

// GetAlertByAssetUser loads the alert for an asset / user pair.
func (s *Store) GetAlertByAssetUser(ctx context.Context, assetID, userQQ string) (*Alert, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+alertCols+` FROM alerts WHERE content_asset_id = ? AND user_qq = ?`, assetID, userQQ)
	return scanAlert(row)
}

// ListAlertsByUser returns alerts for a QQ identity, newest first.
func (s *Store) ListAlertsByUser(ctx context.Context, userQQ string, unreadOnly bool) ([]Alert, error) {
	q := `SELECT ` + alertCols + ` FROM alerts WHERE user_qq = ?`
	if unreadOnly {
		q += " AND read_at IS NULL"
	}
	q += " ORDER BY created_at DESC"
	rows, err := s.db.QueryContext(ctx, q, userQQ)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Alert
	for rows.Next() {
		a, err := scanAlert(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// UnreadAlertCount counts unread alerts for a QQ identity.
func (s *Store) UnreadAlertCount(ctx context.Context, userQQ string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM alerts WHERE user_qq = ? AND read_at IS NULL`, userQQ).Scan(&n)
	return n, err
}

// MarkAlertRead marks an alert read (scoped to its owner).
func (s *Store) MarkAlertRead(ctx context.Context, userQQ, id string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE alerts SET read_at = ? WHERE id = ? AND user_qq = ? AND read_at IS NULL`,
		time.Now().Unix(), id, userQQ)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// Either already read or not found; verify existence.
		if _, err := s.GetAlertForUser(ctx, userQQ, id); err != nil {
			return err
		}
	}
	return nil
}

// GetAlertForUser loads a single alert scoped to its owner.
func (s *Store) GetAlertForUser(ctx context.Context, userQQ, id string) (*Alert, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+alertCols+` FROM alerts WHERE id = ? AND user_qq = ?`, id, userQQ)
	return scanAlert(row)
}

// MarkAlertDelivered flips the delivered flag.
func (s *Store) MarkAlertDelivered(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE alerts SET delivered = 1 WHERE id = ?`, id)
	return err
}

func scanAlert(row rowScanner) (*Alert, error) {
	var (
		a         Alert
		ctxEx     sql.NullString
		review    sql.NullString
		delivered int
		readAt    sql.NullInt64
		createdAt sql.NullInt64
	)
	if err := row.Scan(&a.ID, &a.UserQQ, &a.GroupID, &a.ContentAssetID, &a.Level, &a.Title, &a.Summary,
		&ctxEx, &review, &delivered, &readAt, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	a.ContextExcerpt = ctxEx.String
	a.ReviewReason = review.String
	a.Delivered = delivered != 0
	a.ReadAt = timePtr(readAt)
	a.CreatedAt = timeVal(createdAt)
	return &a, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
