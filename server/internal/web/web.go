// Package web serves the H5 client embedded into the server binary, so a single
// process on a single port exposes both the REST API and the app UI.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

// dist holds the built Taro H5 client (relative asset paths + hash router).
//
//go:embed dist
var distFS embed.FS

// Handler returns an http.Handler serving the embedded client. The client uses
// a hash router, so every real route is served from index.html; unknown paths
// fall back to index.html so a hard refresh always boots the SPA.
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	index, err := fs.ReadFile(distFS, "dist/index.html")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			serveIndex(w, index)
			return
		}
		if _, err := fs.Stat(sub, p); err != nil {
			serveIndex(w, index)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}

func serveIndex(w http.ResponseWriter, index []byte) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// index.html 是应用外壳，必须始终拿最新（否则会引用到已被替换的旧 hash 资源）
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	_, _ = w.Write(index)
}
