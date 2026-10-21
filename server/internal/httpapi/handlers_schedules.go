package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/qqsched/server/internal/auth"
	"github.com/qqsched/server/internal/schedule"
	"github.com/qqsched/server/internal/store"
)

type createItemRequest struct {
	Title    string           `json:"title"`
	Type     string           `json:"type"`
	Status   string           `json:"status"`
	Priority string           `json:"priority"`
	DueAt    json.RawMessage  `json:"due_at"`
	RemindAt json.RawMessage  `json:"remind_at"`
	AllDay   bool             `json:"all_day"`
	Notes    string           `json:"notes"`
	Source   *schedule.Source `json:"source"`
}

type patchItemRequest struct {
	BaseRevision int64           `json:"base_revision"`
	Title        *string         `json:"title"`
	Type         *string         `json:"type"`
	Status       *string         `json:"status"`
	Priority     *string         `json:"priority"`
	DueAt        json.RawMessage `json:"due_at"`
	RemindAt     json.RawMessage `json:"remind_at"`
	AllDay       *bool           `json:"all_day"`
	Notes        *string         `json:"notes"`
}

type itemResponse struct {
	Revision int64         `json:"revision"`
	Item     schedule.Item `json:"item"`
}

type syncRequest struct {
	LastRevision int64               `json:"last_revision"`
	Mutations    []schedule.Mutation `json:"mutations"`
}

type syncConflict struct {
	ID     string         `json:"id"`
	Server *schedule.Item `json:"server"`
}

type syncResponse struct {
	Revision  int64           `json:"revision"`
	Changed   []schedule.Item `json:"changed"`
	Deleted   []string        `json:"deleted"`
	Conflicts []syncConflict  `json:"conflicts"`
}

func (a *api) buildDocument(ctx context.Context, userID string) (schedule.Document, error) {
	items, err := a.Store.ListItems(ctx, userID)
	if err != nil {
		return schedule.Document{}, err
	}
	state, err := a.Store.GetUserState(ctx, userID)
	if err != nil {
		return schedule.Document{}, err
	}
	// Collapse the same schedule reported by several groups into one entry and
	// attach human-readable group names for the client to show.
	items = schedule.DedupeByKey(items)
	schedule.ApplyGroupNames(items, a.groupNames(ctx))
	qq := a.primaryQQ(ctx, userID)
	doc := schedule.BuildDocument(userID, qq, state.Revision, time.Now().UTC(), items)
	return doc, nil
}

// groupNames returns a group_id -> group_name lookup for source labelling.
func (a *api) groupNames(ctx context.Context) map[string]string {
	groups, err := a.Store.ListGroups(ctx)
	if err != nil {
		return nil
	}
	names := make(map[string]string, len(groups))
	for _, g := range groups {
		if g.GroupName != "" {
			names[g.GroupID] = g.GroupName
		}
	}
	return names
}

func (a *api) refreshDigest(ctx context.Context, userID string) {
	items, err := a.Store.ListItems(ctx, userID)
	if err != nil {
		return
	}
	_ = a.Store.SetUserDigest(ctx, userID, schedule.Digest(items))
}

func (a *api) getSchedule(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	doc, err := a.buildDocument(r.Context(), userID)
	if err != nil {
		a.log.Error("build document", "err", err)
		writeError(w, http.StatusInternalServerError, "store_error", "could not build schedule")
		return
	}
	etag := `"` + strconv.FormatInt(doc.Revision, 10) + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "no-cache")
	if matchETag(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func matchETag(header, etag string) bool {
	header = strings.TrimSpace(header)
	if header == "" {
		return false
	}
	if header == "*" {
		return true
	}
	for _, part := range strings.Split(header, ",") {
		if strings.TrimSpace(part) == etag {
			return true
		}
		if strings.TrimPrefix(strings.TrimSpace(part), "W/") == etag {
			return true
		}
	}
	return false
}

func (a *api) getScheduleDelta(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	since := schedule.ParseRevision(r.URL.Query().Get("since"))
	ctx := r.Context()
	state, err := a.Store.GetUserState(ctx, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not load state")
		return
	}
	if since >= state.Revision {
		writeJSON(w, http.StatusOK, schedule.Delta{Revision: state.Revision, Changed: []schedule.Item{}, Deleted: []string{}})
		return
	}
	changed, err := a.Store.ItemsChangedSince(ctx, userID, since)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not load changes")
		return
	}
	deleted, err := a.Store.DeletedIDsSince(ctx, userID, since)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not load deletions")
		return
	}
	if changed == nil {
		changed = []schedule.Item{}
	}
	schedule.ApplyGroupNames(changed, a.groupNames(ctx))
	if deleted == nil {
		deleted = []string{}
	}
	writeJSON(w, http.StatusOK, schedule.Delta{Revision: state.Revision, Changed: changed, Deleted: deleted})
}

func (a *api) getRevision(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	state, err := a.Store.GetUserState(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not load state")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revision": state.Revision})
}

func (a *api) createItem(w http.ResponseWriter, r *http.Request) {
	var req createItemRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		writeError(w, http.StatusBadRequest, "invalid_title", "title is required")
		return
	}
	ctx := r.Context()
	userID := auth.UserIDFromContext(ctx)

	dueAt, err := parseNullableTime(req.DueAt)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_due_at", "due_at must be RFC3339 or null")
		return
	}
	remindAt, err := parseNullableTime(req.RemindAt)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_remind_at", "remind_at must be RFC3339 or null")
		return
	}

	rev, err := a.Store.BumpRevision(ctx, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not bump revision")
		return
	}
	now := time.Now().UTC()
	item := schedule.Item{
		ID:           uuid.NewString(),
		Title:        req.Title,
		Type:         defaultStr(req.Type, schedule.TypeTask),
		Status:       defaultStr(req.Status, schedule.StatusPending),
		Priority:     defaultStr(req.Priority, schedule.PriorityNormal),
		DueAt:        dueAt,
		RemindAt:     remindAt,
		AllDay:       req.AllDay,
		Notes:        strings.TrimSpace(req.Notes),
		LockedByUser: true,
		Revision:     rev,
		Source:       sourceOrDefault(req.Source),
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := a.Store.UpsertItem(ctx, userID, item); err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not create item")
		return
	}
	a.refreshDigest(ctx, userID)
	if a.Hub != nil {
		a.Hub.PushScheduleUpdate(userID, rev)
	}
	schedule.ApplyGroupNames([]schedule.Item{item}, a.groupNames(ctx))
	writeJSON(w, http.StatusOK, itemResponse{Revision: rev, Item: item})
}

func (a *api) patchItem(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := auth.UserIDFromContext(ctx)
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "invalid_id", "item id is required")
		return
	}
	var req patchItemRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}

	existing, err := a.Store.GetItem(ctx, userID, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "item not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "store_error", "could not load item")
		return
	}

	// Optimistic lock: the client must present the revision it last saw.
	if req.BaseRevision != 0 && req.BaseRevision != existing.Revision {
		writeJSON(w, http.StatusConflict, map[string]any{"conflict": existing})
		return
	}

	item := existing.Clone()
	if req.Title != nil {
		if t := strings.TrimSpace(*req.Title); t != "" {
			item.Title = t
		}
	}
	if req.Type != nil && *req.Type != "" {
		item.Type = *req.Type
	}
	if req.Status != nil && *req.Status != "" {
		item.Status = *req.Status
	}
	if req.Priority != nil && *req.Priority != "" {
		item.Priority = *req.Priority
	}
	if req.AllDay != nil {
		item.AllDay = *req.AllDay
	}
	if req.Notes != nil {
		item.Notes = *req.Notes
	}
	if len(req.DueAt) > 0 {
		t, err := parseNullableTime(req.DueAt)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_due_at", "due_at must be RFC3339 or null")
			return
		}
		item.DueAt = t
	}
	if len(req.RemindAt) > 0 {
		t, err := parseNullableTime(req.RemindAt)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_remind_at", "remind_at must be RFC3339 or null")
			return
		}
		item.RemindAt = t
	}

	rev, err := a.Store.BumpRevision(ctx, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not bump revision")
		return
	}
	item.LockedByUser = true
	item.Revision = rev
	item.UpdatedAt = time.Now().UTC()
	if err := a.Store.UpsertItem(ctx, userID, item); err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not update item")
		return
	}
	a.refreshDigest(ctx, userID)
	if a.Hub != nil {
		a.Hub.PushScheduleUpdate(userID, rev)
	}
	schedule.ApplyGroupNames([]schedule.Item{item}, a.groupNames(ctx))
	writeJSON(w, http.StatusOK, itemResponse{Revision: rev, Item: item})
}

func (a *api) deleteItem(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := auth.UserIDFromContext(ctx)
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "invalid_id", "item id is required")
		return
	}
	if _, err := a.Store.GetItem(ctx, userID, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "item not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "store_error", "could not load item")
		return
	}
	rev, err := a.Store.BumpRevision(ctx, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not bump revision")
		return
	}
	if err := a.Store.SoftDeleteItem(ctx, userID, id, rev); err != nil {
		writeError(w, http.StatusInternalServerError, "store_error", "could not delete item")
		return
	}
	a.refreshDigest(ctx, userID)
	if a.Hub != nil {
		a.Hub.PushScheduleUpdate(userID, rev)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) syncItems(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := auth.UserIDFromContext(ctx)
	var req syncRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid json body")
		return
	}

	resp := syncResponse{Changed: []schedule.Item{}, Deleted: []string{}, Conflicts: []syncConflict{}}
	now := time.Now().UTC()

	for _, mut := range req.Mutations {
		switch strings.ToLower(strings.TrimSpace(mut.Op)) {
		case "create":
			if mut.Item == nil || strings.TrimSpace(mut.Item.Title) == "" {
				continue
			}
			rev, err := a.Store.BumpRevision(ctx, userID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "store_error", "could not bump revision")
				return
			}
			item := mut.Item.Clone()
			if item.ID == "" {
				item.ID = uuid.NewString()
			}
			if item.Type == "" {
				item.Type = schedule.TypeTask
			}
			if item.Status == "" {
				item.Status = schedule.StatusPending
			}
			if item.Priority == "" {
				item.Priority = schedule.PriorityNormal
			}
			item.LockedByUser = true
			item.Revision = rev
			item.CreatedAt = now
			item.UpdatedAt = now
			if err := a.Store.UpsertItem(ctx, userID, item); err != nil {
				writeError(w, http.StatusInternalServerError, "store_error", "could not create item")
				return
			}
			resp.Changed = append(resp.Changed, item)

		case "update":
			if mut.Item == nil || mut.Item.ID == "" {
				continue
			}
			existing, err := a.Store.GetItem(ctx, userID, mut.Item.ID)
			if err != nil {
				if errors.Is(err, store.ErrNotFound) {
					resp.Conflicts = append(resp.Conflicts, syncConflict{ID: mut.Item.ID})
					continue
				}
				writeError(w, http.StatusInternalServerError, "store_error", "could not load item")
				return
			}
			if mut.Item.Revision != 0 && mut.Item.Revision != existing.Revision {
				resp.Conflicts = append(resp.Conflicts, syncConflict{ID: existing.ID, Server: existing})
				continue
			}
			rev, err := a.Store.BumpRevision(ctx, userID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "store_error", "could not bump revision")
				return
			}
			merged := schedule.ApplyUserPatch(*existing, *mut.Item, rev, now)
			if err := a.Store.UpsertItem(ctx, userID, merged); err != nil {
				writeError(w, http.StatusInternalServerError, "store_error", "could not update item")
				return
			}
			resp.Changed = append(resp.Changed, merged)

		case "delete":
			if mut.Item == nil || mut.Item.ID == "" {
				continue
			}
			existing, err := a.Store.GetItem(ctx, userID, mut.Item.ID)
			if err != nil {
				if errors.Is(err, store.ErrNotFound) {
					continue
				}
				writeError(w, http.StatusInternalServerError, "store_error", "could not load item")
				return
			}
			if mut.Item.Revision != 0 && mut.Item.Revision != existing.Revision {
				resp.Conflicts = append(resp.Conflicts, syncConflict{ID: existing.ID, Server: existing})
				continue
			}
			rev, err := a.Store.BumpRevision(ctx, userID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "store_error", "could not bump revision")
				return
			}
			if err := a.Store.SoftDeleteItem(ctx, userID, existing.ID, rev); err != nil {
				writeError(w, http.StatusInternalServerError, "store_error", "could not delete item")
				return
			}
			resp.Deleted = append(resp.Deleted, existing.ID)
		}
	}

	state, err := a.Store.GetUserState(ctx, userID)
	if err == nil {
		resp.Revision = state.Revision
	}
	schedule.ApplyGroupNames(resp.Changed, a.groupNames(ctx))
	for i := range resp.Conflicts {
		if resp.Conflicts[i].Server != nil {
			schedule.ApplyGroupNames([]schedule.Item{*resp.Conflicts[i].Server}, a.groupNames(ctx))
		}
	}
	a.refreshDigest(ctx, userID)
	if a.Hub != nil && (len(resp.Changed) > 0 || len(resp.Deleted) > 0) {
		a.Hub.PushScheduleUpdate(userID, resp.Revision)
	}
	writeJSON(w, http.StatusOK, resp)
}

// parseNullableTime parses "null" (or empty) into nil, otherwise RFC3339.
func parseNullableTime(raw json.RawMessage) (*time.Time, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return nil, nil
	}
	var str string
	if err := json.Unmarshal(raw, &str); err != nil {
		// Maybe it was already a time value from a client using Date objects.
		var t time.Time
		if err2 := json.Unmarshal(raw, &t); err2 != nil {
			return nil, err
		}
		return &t, nil
	}
	str = strings.TrimSpace(str)
	if str == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339, str)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func defaultStr(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

func sourceOrDefault(src *schedule.Source) schedule.Source {
	if src == nil {
		return schedule.Source{Kind: schedule.SourceUser}
	}
	if src.Kind == "" {
		src.Kind = schedule.SourceUser
	}
	return *src
}
