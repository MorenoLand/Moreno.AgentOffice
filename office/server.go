package office

import (
	"context"
	"crypto/tls"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
	"time"
)

func Run(addr string, open bool, create bool, workspace string, assets http.Handler) error {
	return RunWithHTTPS(addr, "", "", "", open, create, workspace, assets)
}

func RunWithHTTPS(addr string, httpsAddr string, tlsCert string, tlsKey string, open bool, create bool, workspace string, assets http.Handler) error {
	if workspace == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		workspace = home
	}
	app := NewApp()
	app.workspace = workspace
	app.allowCreate = create
	hub := NewHub(app, NewAuthStore(app.dataDir()))

	app.browser = &webBrowser{hub: hub}
	app.attach(hub)

	if err := app.host.start(); err != nil {
		return err
	}
	defer app.shutdown()

	mux := http.NewServeMux()
	mux.HandleFunc("/music/", app.serveMusic)
	mux.HandleFunc("/wall-image", app.serveWallImage)
	mux.Handle("/", assets)
	mux.HandleFunc("/ws", hub.handleWS)
	mux.HandleFunc("/rpc", hub.handleRPC)

	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	var httpsListener net.Listener
	if httpsAddr != "" {
		if tlsCert == "" || tlsKey == "" {
			_ = listener.Close()
			return errors.New("HTTPS requires both -tls-cert and -tls-key")
		}
		certificate, err := tls.LoadX509KeyPair(tlsCert, tlsKey)
		if err != nil {
			_ = listener.Close()
			return err
		}
		rawListener, err := net.Listen("tcp", httpsAddr)
		if err != nil {
			_ = listener.Close()
			return err
		}
		httpsListener = tls.NewListener(rawListener, &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}})
	}
	log.Printf("agent-office listening on %s", displayURL(listener.Addr()))
	log.Printf("  workers run in: %s", workspace)
	log.Printf("  account creation: %v", create)
	boundHost, boundPort, _ := net.SplitHostPort(listener.Addr().String())
	if boundHost == "0.0.0.0" || boundHost == "::" {
		for _, ip := range lanAddresses(boundPort) {
			log.Printf("  lan: http://%s", ip)
		}
	}
	if httpsListener != nil {
		_, httpsPort, _ := net.SplitHostPort(httpsListener.Addr().String())
		log.Printf("agent-office HTTPS listening on %s", httpsListener.Addr())
		for _, ip := range lanAddresses(httpsPort) {
			log.Printf("  lan: https://%s", ip)
		}
	}
	if open {
		go func() {
			time.Sleep(200 * time.Millisecond)
			if err := openDefaultBrowser(displayURL(listener.Addr())); err != nil {
				log.Printf("could not open a browser automatically: %v", err)
			}
		}()
	}

	server := &http.Server{
		Handler:           logRequests(mux),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: /ws is a long-lived connection.
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	errs := make(chan error, 2)
	go func() { errs <- server.Serve(listener) }()
	if httpsListener != nil {
		go func() { errs <- server.Serve(httpsListener) }()
	}

	select {
	case err := <-errs:
		_ = server.Close()
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-stop:
		log.Println("shutting down")
		hub.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		return server.Shutdown(ctx)
	}
}

func displayURL(addr net.Addr) string {
	host, port, err := net.SplitHostPort(addr.String())
	if err != nil {
		return "http://" + addr.String()
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "localhost"
	}
	return "http://" + net.JoinHostPort(host, port)
}

func lanAddresses(port string) []string {
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var out []string
	for _, address := range addresses {
		ipNet, ok := address.(*net.IPNet)
		if !ok || ipNet.IP.IsLoopback() {
			continue
		}
		ip := ipNet.IP.To4()
		if ip == nil {
			continue
		}
		out = append(out, net.JoinHostPort(ip.String(), port))
	}
	return out
}

func openDefaultBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}
