package web

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// embeddedDist contains the production Vite bundle. The build scripts refresh
// this directory before compiling the Go binary, so the resulting executable
// does not depend on a separate web root at runtime.
//
//go:embed dist
var embeddedDist embed.FS

type spaHandler struct {
	dist       fs.FS
	files      http.Handler
	indexHTML  []byte
	publicRoot string
}

// NewHandler serves the embedded Vite application and files stored under
// <dataDir>/public. API-style paths are deliberately excluded from SPA
// fallback so a missing backend route remains a 404 instead of index.html.
func NewHandler(dataDir string) (http.Handler, error) {
	dist, err := fs.Sub(embeddedDist, "dist")
	if err != nil {
		return nil, err
	}
	indexHTML, err := fs.ReadFile(dist, "index.html")
	if err != nil {
		return nil, err
	}
	publicRoot := filepath.Join(dataDir, "public")
	if err := os.MkdirAll(publicRoot, 0o755); err != nil {
		return nil, err
	}

	return &spaHandler{
		dist:       dist,
		files:      http.FileServerFS(dist),
		indexHTML:  indexHTML,
		publicRoot: publicRoot,
	}, nil
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestPath := path.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
	if isReservedPath(requestPath) {
		http.NotFound(w, r)
		return
	}
	if requestPath == "/public" || strings.HasPrefix(requestPath, "/public/") {
		h.servePublic(w, r, requestPath)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	name := strings.TrimPrefix(requestPath, "/")
	if name == "" || name == "index.html" {
		h.serveIndex(w, r)
		return
	}
	isAssetPath := name == "assets" || strings.HasPrefix(name, "assets/")

	if fs.ValidPath(name) {
		if info, err := fs.Stat(h.dist, name); err == nil && info.Mode().IsRegular() {
			if isAssetPath {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			h.files.ServeHTTP(w, r)
			return
		}
	}

	// Missing asset-like requests should be real 404s. Returning index.html for
	// them hides deployment mistakes and produces misleading MIME-type errors.
	if isAssetPath || path.Ext(name) != "" {
		http.NotFound(w, r)
		return
	}

	// The path is not a file and is not reserved for the backend, so treat it as
	// a client-side route (for example /login or /admin/users).
	h.serveIndex(w, r)
}

func (h *spaHandler) serveIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache, must-revalidate")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(h.indexHTML))
}

func (h *spaHandler) servePublic(w http.ResponseWriter, r *http.Request, requestPath string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if requestPath == "/public" {
		if r.URL.Path == "/public" {
			http.Redirect(w, r, "/public/", http.StatusPermanentRedirect)
		} else {
			// /public/ is intentionally not a browsable directory. Keep it a
			// 404 instead of redirecting it back to itself after path.Clean.
			http.NotFound(w, r)
		}
		return
	}

	name := strings.TrimPrefix(requestPath, "/public/")
	// os.Root enforces that followed symlinks stay inside publicRoot. Rejecting
	// directories also prevents accidental directory listings.
	if name == "" || strings.ContainsRune(name, '\\') || !fs.ValidPath(name) {
		http.NotFound(w, r)
		return
	}
	root, err := os.OpenRoot(h.publicRoot)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()

	file, err := root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, path.Base(name), info.ModTime(), file)
}

func isReservedPath(requestPath string) bool {
	for _, prefix := range [...]string{
		"/api", "/traffic", "/mcp", "/healthz",
		// Keep invalid or missing short-link paths and Telegram WebApp subpaths
		// on their original 404 behavior instead of presenting the SPA shell.
		"/x", "/t", "/tg-app",
	} {
		if requestPath == prefix || strings.HasPrefix(requestPath, prefix+"/") {
			return true
		}
	}
	return false
}
