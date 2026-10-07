package office

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type WallArtPlacement struct {
	ID    string  `json:"id"`
	URL   string  `json:"url"`
	Title string  `json:"title,omitempty"`
	Wall  string  `json:"wall"`
	U     float64 `json:"u"`
	Y     float64 `json:"y"`
	W     float64 `json:"w"`
	H     float64 `json:"h"`
	Frame int     `json:"frame"`
}

type wallImageCacheEntry struct {
	contentType string
	body        []byte
	at          time.Time
}

const maxWallArt = 200
const maxWallImageBytes = 15 * 1024 * 1024
const maxWallImageCacheBytes = 96 * 1024 * 1024
const wallImageCacheAge = 30 * time.Minute

var wallArtIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func validBlindID(id string) bool { return wallArtIDPattern.MatchString(id) }
func validSeason(season string) bool {
	switch season {
	case "auto", "spring", "summer", "autumn", "winter":
		return true
	}
	return false
}

func checkWallImageURL(raw string) (string, error) {
	if len(raw) > 2048 {
		return "", errors.New("image link is too long")
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil {
		return "", errors.New("image link must use http or https")
	}
	return u.String(), nil
}

func validateWallArt(items []WallArtPlacement) error {
	if len(items) > maxWallArt {
		return fmt.Errorf("the wall can hold at most %d pictures", maxWallArt)
	}
	seen := make(map[string]struct{}, len(items))
	for i := range items {
		item := &items[i]
		if !validBlindID(item.ID) {
			return errors.New("picture id is invalid")
		}
		if _, exists := seen[item.ID]; exists {
			return errors.New("picture ids must be unique")
		}
		seen[item.ID] = struct{}{}
		imageURL, err := checkWallImageURL(item.URL)
		if err != nil {
			return err
		}
		item.URL = imageURL
		if item.Wall != "north" && item.Wall != "south" && item.Wall != "east" && item.Wall != "west" {
			return errors.New("picture wall is invalid")
		}
		longest := math.Max(item.W, item.H)
		shortest := math.Min(item.W, item.H)
		if math.IsNaN(item.U) || math.IsInf(item.U, 0) || math.IsNaN(item.Y) || math.IsInf(item.Y, 0) || math.IsNaN(item.W) || math.IsInf(item.W, 0) || math.IsNaN(item.H) || math.IsInf(item.H, 0) || item.U < -100 || item.U > 100 || item.Y < 0.1 || item.Y > 20 || longest < 0.3 || longest > 3.4 || shortest < 0.05 {
			return errors.New("picture placement or size is invalid")
		}
		if item.Frame < 0 || item.Frame > 5 {
			return errors.New("picture frame is invalid")
		}
		if len(item.Title) > 240 {
			item.Title = item.Title[:240]
		}
	}
	return nil
}

func wallImageAddressAllowed(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return false
	}
	ips, err := net.LookupIP(u.Hostname())
	if err != nil || len(ips) == 0 {
		return false
	}
	for _, ip := range ips {
		if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
			return false
		}
	}
	return true
}

func (a *App) serveWallImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if a.auth == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	user, _ := a.auth.sessionFromRequest(r)
	if user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	imageURL, err := checkWallImageURL(r.URL.Query().Get("url"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if user.Role == RoleGuest {
		allowed := false
		for _, art := range a.OfficeStateGet().WallArt {
			if art.URL == imageURL {
				allowed = true
				break
			}
		}
		if !allowed {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
	}
	entry, err := a.loadWallImage(r.Context(), imageURL)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", entry.contentType)
	w.Header().Set("Cache-Control", "private, max-age=1800")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(entry.body)
}

func (a *App) loadWallImage(ctx context.Context, imageURL string) (wallImageCacheEntry, error) {
	now := time.Now()
	a.wallImageMu.Lock()
	if cached, ok := a.wallImageCache[imageURL]; ok && now.Sub(cached.at) < wallImageCacheAge {
		a.wallImageMu.Unlock()
		return cached, nil
	}
	a.wallImageMu.Unlock()
	if !wallImageAddressAllowed(imageURL) {
		return wallImageCacheEntry{}, errors.New("image host must resolve to a public address")
	}
	client := &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many image redirects")
		}
		if _, err := checkWallImageURL(req.URL.String()); err != nil || !wallImageAddressAllowed(req.URL.String()) {
			return errors.New("image redirected to an unsupported address")
		}
		return nil
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return wallImageCacheEntry{}, err
	}
	req.Header.Set("Accept", "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5")
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; Moreno.AgentOffice)")
	response, err := client.Do(req)
	if err != nil {
		return wallImageCacheEntry{}, fmt.Errorf("couldn't load image: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return wallImageCacheEntry{}, fmt.Errorf("image host answered HTTP %d", response.StatusCode)
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	if contentType == "text/html" || contentType == "application/xhtml+xml" {
		return wallImageCacheEntry{}, errors.New("link points to a web page, not an image")
	}
	if response.ContentLength > maxWallImageBytes {
		return wallImageCacheEntry{}, errors.New("image is over 15 MB")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxWallImageBytes+1))
	if err != nil {
		return wallImageCacheEntry{}, fmt.Errorf("couldn't read image: %w", err)
	}
	if len(body) > maxWallImageBytes {
		return wallImageCacheEntry{}, errors.New("image is over 15 MB")
	}
	if !strings.HasPrefix(contentType, "image/") {
		contentType = sniffWallImage(body)
	}
	if contentType == "" {
		return wallImageCacheEntry{}, errors.New("link isn't a supported image")
	}
	entry := wallImageCacheEntry{contentType: contentType, body: body, at: now}
	a.wallImageMu.Lock()
	if old, ok := a.wallImageCache[imageURL]; ok {
		a.wallImageBytes -= int64(len(old.body))
	}
	a.wallImageCache[imageURL] = entry
	a.wallImageBytes += int64(len(body))
	for a.wallImageBytes > maxWallImageCacheBytes {
		var staleURL string
		var staleAt time.Time
		for key, cached := range a.wallImageCache {
			if staleURL == "" || cached.at.Before(staleAt) {
				staleURL, staleAt = key, cached.at
			}
		}
		if staleURL == "" {
			break
		}
		a.wallImageBytes -= int64(len(a.wallImageCache[staleURL].body))
		delete(a.wallImageCache, staleURL)
	}
	a.wallImageMu.Unlock()
	return entry, nil
}

func sniffWallImage(body []byte) string {
	switch {
	case bytes.HasPrefix(body, []byte{0x89, 'P', 'N', 'G'}):
		return "image/png"
	case len(body) >= 3 && body[0] == 0xff && body[1] == 0xd8 && body[2] == 0xff:
		return "image/jpeg"
	case bytes.HasPrefix(body, []byte("GIF8")):
		return "image/gif"
	case len(body) >= 12 && string(body[:4]) == "RIFF" && string(body[8:12]) == "WEBP":
		return "image/webp"
	case len(body) >= 12 && (string(body[4:12]) == "ftypavif" || string(body[4:12]) == "ftypavis"):
		return "image/avif"
	case bytes.Contains(bytes.ToLower(body[:min(len(body), 512)]), []byte("<svg")):
		return "image/svg+xml"
	default:
		return ""
	}
}
