// Command agentoffice serves a Three.js virtual office for AI agents.
//
// A single Go process owns everything: provider OAuth, PTY-backed workers,
// model calls, and the browser client that renders the office.
package main

import (
	"errors"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"agentoffice/office"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "codex-hook" {
		_ = office.RunCodexHook(os.Args[2:], os.Stdin, os.Stdout)
		return
	}
	addr := flag.String("addr", "0.0.0.0:7317", "listen address (use 127.0.0.1 to keep it local-only)")
	httpsAddr := flag.String("https-addr", "", "optional HTTPS listener address for WebXR")
	tlsCert := flag.String("tls-cert", "", "TLS certificate PEM path")
	tlsKey := flag.String("tls-key", "", "TLS private key PEM path")
	open := flag.Bool("open", true, "open the office in your default browser on start")
	dev := flag.Bool("dev", false, "serve web/dist from disk instead of the embedded bundle")
	create := flag.Bool("create", false, "allow new accounts to be created from the sign-in screen")
	workspace := flag.String("workspace", "", "directory workers run in (default: your home directory)")
	flag.Parse()

	if err := run(*addr, *httpsAddr, *tlsCert, *tlsKey, *dev, *open, *create, *workspace); err != nil {
		log.Fatal(err)
	}
}

func run(addr string, httpsAddr string, tlsCert string, tlsKey string, dev bool, open bool, create bool, workspace string) error {
	assets, err := buildAssetHandler(dev)
	if err != nil {
		return err
	}
	return office.RunWithHTTPS(addr, httpsAddr, tlsCert, tlsKey, open, create, workspace, assets)
}

func buildAssetHandler(dev bool) (http.Handler, error) {
	if dev {
		// Live-from-disk mode so `vite` HMR works without rebuilding Go.
		root, err := filepath.Abs("web/dist")
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(root); err != nil {
			return nil, errors.New("web/dist not found; run `npm run build` in web/ first")
		}
		log.Printf("dev mode: serving %s from disk", root)
		return spaHandler(http.FileServer(http.Dir(root)), nil), nil
	}
	sub, err := fs.Sub(webAssets, "web/dist")
	if err != nil {
		return nil, err
	}
	return spaHandler(http.FileServer(http.FS(sub)), sub), nil
}

// spaHandler serves static files and falls back to index.html for navigation
// requests. A missing asset is a hard 404: answering those with index.html makes
// a stale cached document fail silently instead of visibly.
func spaHandler(next http.Handler, embedded fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path != "" && path != "index.html" {
			found := false
			if embedded != nil {
				if file, err := embedded.Open(path); err == nil {
					_ = file.Close()
					found = true
				}
			} else if info, err := os.Stat(filepath.Join("web", "dist", filepath.FromSlash(path))); err == nil && !info.IsDir() {
				found = true
			}
			if found {
				if strings.HasPrefix(path, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				next.ServeHTTP(w, r)
				return
			}
			if strings.HasPrefix(path, "assets/") {
				http.NotFound(w, r)
				return
			}
			if embedded == nil {
				next.ServeHTTP(w, r)
				return
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}
