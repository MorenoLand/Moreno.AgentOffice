package office

import (
	"encoding/base64"
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type MusicTrack struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

var musicExtensions = map[string]bool{".aac": true, ".flac": true, ".m4a": true, ".mp3": true, ".ogg": true, ".opus": true, ".wav": true, ".wma": true}

func (a *App) ScanMusic(directory string) ([]MusicTrack, error) {
	directory = strings.TrimSpace(directory)
	if directory == "" {
		return nil, errors.New("enter a music folder path")
	}
	root, err := filepath.Abs(filepath.Clean(directory))
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("music path is not a folder")
	}
	files := make(map[string]string)
	tracks := make([]MusicTrack, 0)
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			if path != root {
				rel, err := filepath.Rel(root, path)
				if err != nil || strings.Count(rel, string(os.PathSeparator)) >= 3 {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if !entry.Type().IsRegular() || !musicExtensions[strings.ToLower(filepath.Ext(path))] {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		id := base64.RawURLEncoding.EncodeToString([]byte(filepath.ToSlash(rel)))
		files[id] = rel
		tracks = append(tracks, MusicTrack{ID: id, Name: filepath.Base(path)})
		if len(tracks) >= 1000 {
			return fs.SkipAll
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(tracks, func(i, j int) bool { return strings.ToLower(tracks[i].Name) < strings.ToLower(tracks[j].Name) })
	a.musicMu.Lock()
	a.musicRoot = root
	a.musicFiles = files
	a.musicMu.Unlock()
	return tracks, nil
}

func (a *App) serveMusic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	user, _ := a.auth.sessionFromRequest(r)
	if user == nil || user.Role != RoleOwner {
		http.Error(w, "admin access required", http.StatusForbidden)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/music/")
	a.musicMu.RLock()
	root, rel := a.musicRoot, a.musicFiles[id]
	a.musicMu.RUnlock()
	if root == "" || rel == "" {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(root, rel)
	clean, err := filepath.Rel(root, path)
	if err != nil || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		http.Error(w, "invalid music path", http.StatusBadRequest)
		return
	}
	file, err := os.Open(path)
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
	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}
