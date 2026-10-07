package office

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/x/xpty"
)

type SessionHost struct {
	mu          sync.RWMutex
	deckMu      sync.Mutex
	nameMu      sync.Mutex
	resumeMu    sync.Mutex
	sessions    map[string]*hostSession
	appContext  HostAppContext
	emitter     func(string, any)
	listener    net.Listener
	stop        chan struct{}
	stopped     chan struct{}
	subscribers map[net.Conn]struct{}
	port        uint16
}

type hostSession struct {
	mu              sync.Mutex
	pty             xpty.Pty
	cmd             *exec.Cmd
	snapshot        TerminalSnapshot
	backlog         string
	inputLine       string
	inputEscape     bool
	inputCSI        bool
	activityText    string
	hookToken       string
	codexSessionID  string
	codexTools      map[string]string
	codexPending    map[string]struct{}
	codexPermissionUnknown bool
	lastActivity    time.Time
	activityTimer   *time.Timer
	closed          bool
}

type sessionHostInfo struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Port            uint16 `json:"port"`
	PID             int    `json:"pid"`
	StartedAt       string `json:"startedAt"`
}

type hostRequest struct {
	Type        string                `json:"type"`
	Context     HostAppContext        `json:"context"`
	ID          string                `json:"id"`
	Token       string                `json:"token,omitempty"`
	Event       string                `json:"event,omitempty"`
	RequestedID string                `json:"requestedId"`
	Data        string                `json:"data"`
	Limit       int                   `json:"limit"`
	Cols        int                   `json:"cols"`
	Rows        int                   `json:"rows"`
	Patch       TerminalMetadataPatch `json:"patch"`
	Request     TerminalLaunchRequest `json:"request"`
}

type hostResponse struct {
	Type     string             `json:"type"`
	Context  HostAppContext     `json:"context,omitempty"`
	ID       string             `json:"id,omitempty"`
	Sessions []TerminalSnapshot `json:"sessions,omitempty"`
	Readback []TerminalReadback `json:"readback,omitempty"`
	Error    string             `json:"error,omitempty"`
	Message  string             `json:"message,omitempty"`
	Session  *TerminalSnapshot  `json:"session,omitempty"`
	Port     uint16             `json:"port,omitempty"`
	Started  bool               `json:"started,omitempty"`
	Restored []TerminalSnapshot `json:"restored,omitempty"`
}

func NewSessionHost() *SessionHost {
	return &SessionHost{sessions: map[string]*hostSession{}, subscribers: map[net.Conn]struct{}{}}
}

func (h *SessionHost) setEmitter(emitter func(string, any)) {
	h.mu.Lock()
	h.emitter = emitter
	h.mu.Unlock()
}

func (h *SessionHost) start() error {
	h.mu.Lock()
	if h.listener != nil {
		h.mu.Unlock()
		return nil
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		h.mu.Unlock()
		return err
	}
	h.listener = listener
	h.stop = make(chan struct{})
	h.stopped = make(chan struct{})
	h.port = uint16(listener.Addr().(*net.TCPAddr).Port)
	h.mu.Unlock()
	if err := h.writeInfo(); err != nil {
		_ = listener.Close()
		h.mu.Lock()
		h.listener = nil
		h.mu.Unlock()
		return err
	}
	go h.acceptLoop(listener)
	return nil
}

func (h *SessionHost) writeInfo() error {
	paths, err := (&App{}).AppPaths()
	if err != nil {
		return err
	}
	info := sessionHostInfo{ProtocolVersion: 2, Port: h.port, PID: os.Getpid(), StartedAt: nowISO()}
	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(paths.RuntimeDir, "session-host.json"), append(data, '\n'), 0o600)
}

func (h *SessionHost) acceptLoop(listener net.Listener) {
	defer close(h.stopped)
	for {
		conn, err := listener.Accept()
		if err != nil {
			select {
			case <-h.stop:
				return
			default:
			}
			continue
		}
		go h.handleConnection(conn)
	}
}

func (h *SessionHost) handleConnection(conn net.Conn) {
	defer func() {
		h.removeSubscriber(conn)
		if !h.isSubscriber(conn) {
			_ = conn.Close()
		}
	}()
	reader := bufio.NewScanner(conn)
	reader.Buffer(make([]byte, 4096), 2<<20)
	for reader.Scan() {
		var request hostRequest
		if err := json.Unmarshal(reader.Bytes(), &request); err != nil {
			_ = writeJSONLine(conn, hostResponse{Type: "error", Error: err.Error()})
			continue
		}
		response, keepOpen := h.handleRequest(request, conn)
		if err := writeJSONLine(conn, response); err != nil {
			return
		}
		if keepOpen {
			for reader.Scan() {
			}
			return
		}
	}
}

func (h *SessionHost) handleRequest(request hostRequest, conn net.Conn) (hostResponse, bool) {
	switch strings.ToLower(request.Type) {
	case "ping":
		return hostResponse{Type: "pong"}, false
	case "list":
		return hostResponse{Type: "sessions", Sessions: h.listSnapshots()}, false
	case "appcontext":
		return hostResponse{Type: "appContext", Context: h.getAppContext()}, false
	case "updateappcontext":
		h.updateAppContext(request.Context)
		return hostResponse{Type: "ok"}, false
	case "listsaveddeck":
		deck, err := h.listSavedDeck()
		if err != nil {
			return hostResponse{Type: "error", Error: err.Error()}, false
		}
		return hostResponse{Type: "sessions", Sessions: deck}, false
	case "restoredeck":
		restored, err := h.restoreDeck()
		if err != nil {
			return hostResponse{Type: "error", Error: err.Error()}, false
		}
		return hostResponse{Type: "sessions", Restored: restored}, false
	case "spawn":
		snapshot, err := h.spawn(request.Request, request.RequestedID)
		if err != nil {
			return hostResponse{Type: "error", Error: err.Error()}, false
		}
		return hostResponse{Type: "spawned", ID: snapshot.ID, Session: &snapshot}, false
	case "write":
		if err := h.write(request.ID, request.Data); err != nil {
			return hostResponse{Type: "error", Error: err.Error()}, false
		}
		return hostResponse{Type: "ok"}, false
	case "codex_hook":
		if err := h.handleCodexHook(request); err != nil {
			return hostResponse{Type: "error", Error: err.Error()}, false
		}
		return hostResponse{Type: "ok"}, false
	case "read":
		return hostResponse{Type: "readback", Readback: h.read(request.ID, request.Limit)}, false
	case "resize":
		if err := h.resize(request.ID, request.Cols, request.Rows); err != nil {
			return hostResponse{Type: "error", Error: err.Error()}, false
		}
		return hostResponse{Type: "ok"}, false
	case "kill":
		if err := h.kill(request.ID); err != nil {
			return hostResponse{Type: "error", Error: err.Error()}, false
		}
		return hostResponse{Type: "ok"}, false
	case "remove":
		if err := h.remove(request.ID); err != nil {
			return hostResponse{Type: "error", Error: err.Error()}, false
		}
		return hostResponse{Type: "ok"}, false
	case "updatemetadata":
		if err := h.updateMetadata(request.ID, request.Patch); err != nil {
			return hostResponse{Type: "error", Error: err.Error()}, false
		}
		return hostResponse{Type: "ok"}, false
	case "subscribe":
		h.addSubscriber(conn)
		return hostResponse{Type: "subscribed"}, true
	case "shutdown":
		go h.shutdown()
		return hostResponse{Type: "ok"}, false
	default:
		return hostResponse{Type: "error", Error: "unknown request type: " + request.Type}, false
	}
}

func (h *SessionHost) shutdown() {
	h.mu.Lock()
	listener := h.listener
	stop := h.stop
	if listener == nil {
		h.mu.Unlock()
		return
	}
	h.listener = nil
	h.mu.Unlock()
	if stop != nil {
		close(stop)
	}
	_ = listener.Close()
	h.mu.RLock()
	sessions := make([]*hostSession, 0, len(h.sessions))
	for _, session := range h.sessions {
		sessions = append(sessions, session)
	}
	subscribers := make([]net.Conn, 0, len(h.subscribers))
	for subscriber := range h.subscribers {
		subscribers = append(subscribers, subscriber)
	}
	h.mu.RUnlock()
	for _, session := range sessions {
		_ = h.kill(session.snapshot.ID)
	}
	for _, subscriber := range subscribers {
		_ = subscriber.Close()
	}
	_ = h.persistDeck()
	paths, err := (&App{}).AppPaths()
	if err == nil {
		_ = os.Remove(filepath.Join(paths.RuntimeDir, "session-host.json"))
	}
}

func (h *SessionHost) getAppContext() HostAppContext {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.appContext
}

func (h *SessionHost) updateAppContext(context HostAppContext) {
	h.mu.Lock()
	h.appContext = context
	sessions := make([]*hostSession, 0, len(h.sessions))
	for _, session := range h.sessions {
		sessions = append(sessions, session)
	}
	h.mu.Unlock()
	for _, session := range sessions {
		session.mu.Lock()
		if session.cmd != nil {
			setCommandEnv(session.cmd, h.port, session.snapshot.ID, session.snapshot.Title, session.snapshot.Role, context, session.hookToken)
		}
		session.mu.Unlock()
	}
}

func (h *SessionHost) listSnapshots() []TerminalSnapshot {
	h.mu.RLock()
	items := make([]*hostSession, 0, len(h.sessions))
	for _, session := range h.sessions {
		items = append(items, session)
	}
	h.mu.RUnlock()
	result := make([]TerminalSnapshot, 0, len(items))
	for _, session := range items {
		session.mu.Lock()
		result = append(result, session.snapshot)
		session.mu.Unlock()
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func (h *SessionHost) spawn(request TerminalLaunchRequest, requestedID string) (TerminalSnapshot, error) {
	if strings.TrimSpace(request.Command) == "" {
		return TerminalSnapshot{}, errors.New("terminal command is required")
	}
	cols, rows := int(request.Cols), int(request.Rows)
	if cols < 20 {
		cols = 20
	}
	if rows < 8 {
		rows = 8
	}
	id := strings.TrimSpace(requestedID)
	if id == "" {
		id = "terminal-" + randomID()
	}
	h.mu.RLock()
	_, exists := h.sessions[id]
	h.mu.RUnlock()
	if exists {
		id = "terminal-" + randomID()
	}
	args := append([]string(nil), request.Args...)
	hookToken := ""
	if isCodexTerminal(request.ProfileID, request.Command) {
		if executable, err := os.Executable(); err == nil {
			hookToken = randomID() + randomID()
			args = append(args, codexHookArgs(executable)...)
		}
	}
	command, args := normalizeCommand(request.Command, args)
	cmd := exec.Command(command, args...)
	hidePtyWindow(cmd)
	if request.CWD != "" {
		if info, err := os.Stat(request.CWD); err != nil || !info.IsDir() {
			return TerminalSnapshot{}, fmt.Errorf("invalid terminal cwd: %s", request.CWD)
		}
		cmd.Dir = request.CWD
	}
	snapshot := TerminalSnapshot{ID: id, ProfileID: request.ProfileID, Title: request.Label, Command: request.Command, CWD: request.CWD, Args: request.Args, Env: request.Env, Role: request.Role, Accent: request.Accent, Icon: request.Icon, SwarmX: request.SwarmX, SwarmY: request.SwarmY, Mode: "pty", State: "launching", ActivityState: "idle", Cols: uint16(cols), Rows: uint16(rows)}
	if snapshot.Title == "" {
		snapshot.Title = filepath.Base(request.Command)
	}
	h.mu.RLock()
	context := h.appContext
	port := h.port
	h.mu.RUnlock()
	setCommandEnv(cmd, port, id, snapshot.Title, snapshot.Role, context, hookToken)
	for key, value := range request.Env {
		if strings.EqualFold(key, "AGENTOFFICE_HOOK_TOKEN") {
			continue
		}
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	pty, err := xpty.NewPty(cols, rows)
	if err != nil {
		return TerminalSnapshot{}, err
	}
	if err := pty.Start(cmd); err != nil {
		_ = pty.Close()
		return TerminalSnapshot{}, err
	}
	session := &hostSession{pty: pty, cmd: cmd, snapshot: snapshot, hookToken: hookToken, codexTools: map[string]string{}, codexPending: map[string]struct{}{}}
	h.mu.Lock()
	h.sessions[id] = session
	h.mu.Unlock()
	_ = h.persistDeck()
	h.emit("terminal-session", TerminalSessionEvent{Session: snapshot})
	h.emitLifecycle(id, snapshot.Title, "running")
	go h.readOutput(session)
	return snapshot, nil
}

func setCommandEnv(cmd *exec.Cmd, port uint16, id, label, role string, context HostAppContext, hookToken string) {
	env := append([]string{}, os.Environ()...)
	for _, key := range []string{"AGENTOFFICE", "AGENTOFFICE_ADE_NAME", "AGENTOFFICE_APP_CONTEXT", "AGENTOFFICE_HOST_PORT", "AGENTOFFICE_SESSION_ID", "AGENTOFFICE_SESSION_NAME", "AGENTOFFICE_SESSION_ROLE", "AGENTOFFICE_CONTEXT_COMMAND", "AGENTOFFICE_BRIDGE_CLI", "AGENTOFFICE_HOOK_TOKEN", "TERM"} {
		filtered := env[:0]
		for _, entry := range env {
			if !strings.HasPrefix(entry, key+"=") {
				filtered = append(filtered, entry)
			}
		}
		env = filtered
	}
	env = append(env,
		"TERM=xterm-256color",
		"AGENTOFFICE=1",
		"AGENTOFFICE_ADE_NAME=AgentOffice",
		"AGENTOFFICE_APP_CONTEXT="+context.WorkspaceCWD,
		fmt.Sprintf("AGENTOFFICE_HOST_PORT=%d", port),
		"AGENTOFFICE_SESSION_ID="+id,
		"AGENTOFFICE_SESSION_NAME="+label,
		"AGENTOFFICE_SESSION_ROLE="+role,
		"AGENTOFFICE_CONTEXT_COMMAND=agentoffice-bridge",
	)
	if hookToken != "" {
		env = append(env, "AGENTOFFICE_HOOK_TOKEN="+hookToken)
	}
	if home, err := agentOfficeHomeDir(); err == nil {
		env = append(env, "AGENTOFFICE_BRIDGE_CLI="+filepath.Join(home, "bin", "agentoffice-bridge.js"))
	}
	cmd.Env = env
}

func normalizeCommand(command string, args []string) (string, []string) {
	if runtime.GOOS != "windows" {
		return command, args
	}
	ext := strings.ToLower(filepath.Ext(command))
	if ext != ".cmd" && ext != ".bat" {
		return command, args
	}
	shell := os.Getenv("COMSPEC")
	if shell == "" {
		shell = "cmd.exe"
	}
	quoted := []string{"/d", "/c", quoteWindowsArg(command)}
	for _, arg := range args {
		quoted = append(quoted, quoteWindowsArg(arg))
	}
	return shell, quoted
}

func quoteWindowsArg(value string) string {
	if value == "" {
		return `""`
	}
	if !strings.ContainsAny(value, " \t\"") {
		return value
	}
	return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
}

func (h *SessionHost) readOutput(session *hostSession) {
	exited := make(chan struct{})
	go func() { _ = xpty.WaitProcess(context.Background(), session.cmd); close(exited) }()
	go func() { <-exited; time.Sleep(500 * time.Millisecond); _ = session.pty.Close() }()
	buffer := make([]byte, 8192)
	for {
		n, err := session.pty.Read(buffer)
		if n > 0 {
			data := string(buffer[:n])
			if strings.Contains(data, "\x1b[6n") {
				data = strings.ReplaceAll(data, "\x1b[6n", "")
				_, _ = session.pty.Write([]byte("\x1b[1;1R"))
			}
			session.mu.Lock()
			session.backlog += data
			if len(session.backlog) > 256*1024 {
				session.backlog = session.backlog[len(session.backlog)-(256*1024):]
			}
			activityDone := false
			activityTick := false
			if session.snapshot.ActivityState == "working" {
				plain := stripANSI(data)
				activityTick = strings.TrimSpace(plain) != ""
				session.activityText += plain
				if len(session.activityText) > 8192 {
					session.activityText = session.activityText[len(session.activityText)-8192:]
				}
				if terminalActivityDone(session.snapshot, session.activityText) {
					session.snapshot.ActivityState = "done"
					activityDone = true
				}
			}
			snapshot := session.snapshot
			session.snapshot.Backlog = session.backlog
			session.mu.Unlock()
			if activityTick {
				h.touchActivity(session)
			}
			h.emit("terminal-output", TerminalOutputEvent{ID: snapshot.ID, Data: data})
			if activityDone {
				h.emitLifecycle(snapshot.ID, snapshot.Title, "done")
				_ = h.persistDeck()
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && !isPtyClosed(err) {
				select {
				case <-exited:
				default:
					h.emit("terminal-output", TerminalOutputEvent{ID: session.snapshot.ID, Data: "\r\n[session read error: " + err.Error() + "]\r\n"})
				}
			}
			break
		}
	}
	<-exited
	session.mu.Lock()
	if !session.closed {
		session.snapshot.State = "closed"
		session.snapshot.ActivityState = "done"
		session.closed = true
		if session.activityTimer != nil { session.activityTimer.Stop(); session.activityTimer = nil }
	}
	snapshot := session.snapshot
	session.mu.Unlock()
	h.emitLifecycle(snapshot.ID, snapshot.Title, "closed")
	_ = h.persistDeck()
}

func (h *SessionHost) write(id, data string) error {
	session, err := h.session(id)
	if err != nil {
		return err
	}
	session.mu.Lock()
	started := session.recordInput(data)
	snapshot := session.snapshot
	session.mu.Unlock()
	if started {
		h.touchActivity(session)
		h.emitLifecycle(snapshot.ID, snapshot.Title, "working")
		_ = h.persistDeck()
	}
	_, err = session.pty.Write([]byte(data))
	if err != nil && started {
		session.mu.Lock()
		if !session.closed && session.snapshot.ActivityState == "working" {
			session.snapshot.ActivityState = "idle"
			snapshot = session.snapshot
			session.mu.Unlock()
			h.emitLifecycle(snapshot.ID, snapshot.Title, "idle")
			_ = h.persistDeck()
		} else {
			session.mu.Unlock()
		}
	}
	return err
}

func (s *hostSession) recordInput(data string) bool {
	started := false
	for _, char := range data {
		if s.inputEscape {
			s.inputEscape = false
			if char == '[' {
				s.inputCSI = true
			}
			continue
		}
		if s.inputCSI {
			if char >= '@' && char <= '~' {
				s.inputCSI = false
			}
			continue
		}
		switch char {
		case '\x1b':
			s.inputEscape = true
		case '\r', '\n':
			if strings.TrimSpace(s.inputLine) != "" {
				started = true
			}
			s.inputLine = ""
		case '\b', '\x7f':
			runes := []rune(s.inputLine)
			if len(runes) > 0 {
				s.inputLine = string(runes[:len(runes)-1])
			}
		default:
			if char >= 0x20 && char != 0x7f {
				s.inputLine += string(char)
			}
		}
	}
	if started {
		if s.hookToken == "" {
			s.snapshot.ActivityState = "working"
			s.activityText = ""
			return true
		}
	}
	return false
}

func isCommandShell(snapshot TerminalSnapshot) bool {
	command := strings.ToLower(snapshot.ProfileID + " " + snapshot.Command)
	for _, shell := range []string{"cmd.exe", "windows-cmd", "powershell", "pwsh", "bash", "zsh", "sh.exe"} {
		if strings.Contains(command, shell) {
			return true
		}
	}
	return false
}

func terminalActivityDone(snapshot TerminalSnapshot, output string) bool {
	if isCodexTerminal(snapshot.ProfileID, snapshot.Command) {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(output))
	if strings.Contains(text, "baked for") && strings.Contains(text, "done") {
		return true
	}
	if !isCommandShell(snapshot) {
		return false
	}
	line := strings.TrimSpace(text[strings.LastIndexAny(text, "\r\n")+1:])
	if strings.HasPrefix(line, "ps ") && strings.HasSuffix(line, ">") {
		return true
	}
	return len(line) >= 3 && line[1] == ':' && strings.HasSuffix(line, ">") && strings.Contains(line, `\`)
}

func (h *SessionHost) read(id string, limit int) []TerminalReadback {
	if limit <= 0 || limit > 256*1024 {
		limit = 256 * 1024
	}
	h.mu.RLock()
	sessions := make([]*hostSession, 0, len(h.sessions))
	if id != "" {
		if session, ok := h.sessions[id]; ok {
			sessions = append(sessions, session)
		}
	} else {
		for _, session := range h.sessions {
			sessions = append(sessions, session)
		}
	}
	h.mu.RUnlock()
	result := make([]TerminalReadback, 0, len(sessions))
	for _, session := range sessions {
		session.mu.Lock()
		value := stripANSI(session.backlog)
		if len(value) > limit {
			value = value[len(value)-limit:]
		}
		result = append(result, TerminalReadback{ID: session.snapshot.ID, Text: value})
		session.mu.Unlock()
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func (h *SessionHost) resize(id string, cols, rows int) error {
	if cols < 20 {
		cols = 20
	}
	if rows < 8 {
		rows = 8
	}
	session, err := h.session(id)
	if err != nil {
		return err
	}
	if err := session.pty.Resize(cols, rows); err != nil {
		return err
	}
	session.mu.Lock()
	session.snapshot.Cols, session.snapshot.Rows = uint16(cols), uint16(rows)
	snapshot := session.snapshot
	session.mu.Unlock()
	_ = h.persistDeck()
	h.emit("terminal-session", TerminalSessionEvent{Session: snapshot})
	h.emitLifecycle(id, snapshot.Title, "resized")
	return nil
}

func (h *SessionHost) kill(id string) error {
	session, err := h.session(id)
	if err != nil {
		return err
	}
	session.mu.Lock()
	if session.cmd != nil && session.cmd.Process != nil {
		_ = session.cmd.Process.Kill()
	}
	session.snapshot.State = "killed"
	snapshot := session.snapshot
	session.mu.Unlock()
	h.emitLifecycle(id, snapshot.Title, "killed")
	return nil
}

func (h *SessionHost) remove(id string) error {
	h.mu.Lock()
	session, ok := h.sessions[id]
	if ok {
		delete(h.sessions, id)
	}
	h.mu.Unlock()
	if !ok {
		if err := h.forgetSaved(id); err != nil {
			return err
		}
		h.emitLifecycle(id, "", "removed")
		h.emitBridge(map[string]any{"type": "removed", "id": id})
		return nil
	}
	session.mu.Lock()
	if session.cmd != nil && session.cmd.Process != nil {
		_ = session.cmd.Process.Kill()
	}
	session.closed = true
	label := session.snapshot.Title
	session.mu.Unlock()
	_ = session.pty.Close()
	persistErr := h.forgetSaved(id)
	h.emit("terminal-lifecycle", TerminalLifecycleEvent{ID: id, Label: label, State: "removed"})
	h.emitBridge(map[string]any{"type": "removed", "id": id})
	return persistErr
}

func (h *SessionHost) updateMetadata(id string, patch TerminalMetadataPatch) error {
	session, err := h.session(id)
	if err != nil {
		return err
	}
	session.mu.Lock()
	if patch.Title != nil {
		session.snapshot.Title = *patch.Title
	}
	if patch.Role != nil {
		session.snapshot.Role = *patch.Role
	}
	if patch.Accent != nil {
		session.snapshot.Accent = *patch.Accent
	}
	if patch.Icon != nil {
		session.snapshot.Icon = *patch.Icon
	}
	if patch.CWD != nil {
		session.snapshot.CWD = *patch.CWD
	}
	if patch.SwarmX != nil {
		session.snapshot.SwarmX = *patch.SwarmX
	}
	if patch.SwarmY != nil {
		session.snapshot.SwarmY = *patch.SwarmY
	}
	if patch.State != nil {
		session.snapshot.State = *patch.State
	}
	snapshot := session.snapshot
	session.mu.Unlock()
	_ = h.persistDeck()
	h.emit("terminal-session", TerminalSessionEvent{Session: snapshot})
	return nil
}

func (h *SessionHost) session(id string) (*hostSession, error) {
	h.mu.RLock()
	session, ok := h.sessions[id]
	h.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("terminal session not found: %s", id)
	}
	return session, nil
}

func (h *SessionHost) readSavedDeck() ([]TerminalSnapshot, error) {
	paths, err := (&App{}).AppPaths()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(paths.RuntimeDir, "terminal-deck.json"))
	if errors.Is(err, os.ErrNotExist) {
		return []TerminalSnapshot{}, nil
	}
	if err != nil {
		return nil, err
	}
	var deck []TerminalSnapshot
	if err := json.Unmarshal(data, &deck); err != nil {
		return nil, err
	}
	return deck, nil
}

func (h *SessionHost) listSavedDeck() ([]TerminalSnapshot, error) {
	h.deckMu.Lock()
	defer h.deckMu.Unlock()
	return h.readSavedDeck()
}

func (h *SessionHost) writeSavedDeck(snapshots []TerminalSnapshot) error {
	paths, err := (&App{}).AppPaths()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(snapshots, "", "  ")
	if err != nil {
		return err
	}
	temporary := filepath.Join(paths.RuntimeDir, "terminal-deck.json.tmp")
	if err := os.WriteFile(temporary, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, filepath.Join(paths.RuntimeDir, "terminal-deck.json"))
}

func (h *SessionHost) persistDeck() error {
	h.deckMu.Lock()
	defer h.deckMu.Unlock()
	deck, err := h.readSavedDeck()
	if err != nil {
		return err
	}
	byID := make(map[string]TerminalSnapshot, len(deck))
	for _, saved := range deck {
		byID[saved.ID] = saved
	}
	for _, active := range h.listSnapshots() {
		active.Backlog = ""
		byID[active.ID] = active
	}
	result := make([]TerminalSnapshot, 0, len(byID))
	for _, saved := range byID {
		result = append(result, saved)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return h.writeSavedDeck(result)
}

func (h *SessionHost) forgetSaved(id string) error {
	h.deckMu.Lock()
	defer h.deckMu.Unlock()
	deck, err := h.readSavedDeck()
	if err != nil {
		return err
	}
	result := deck[:0]
	for _, saved := range deck {
		if saved.ID != id {
			result = append(result, saved)
		}
	}
	return h.writeSavedDeck(result)
}

func (h *SessionHost) resumeTerminal(id string) (TerminalSnapshot, error) {
	h.resumeMu.Lock()
	defer h.resumeMu.Unlock()
	if _, err := h.session(id); err == nil {
		return TerminalSnapshot{}, fmt.Errorf("worker already running: %s", id)
	}
	deck, err := h.listSavedDeck()
	if err != nil {
		return TerminalSnapshot{}, err
	}
	for _, saved := range deck {
		if saved.ID != id {
			continue
		}
	return h.spawn(TerminalLaunchRequest{RequestedID: saved.ID, Command: saved.Command, CWD: saved.CWD, Label: saved.Title, ProfileID: saved.ProfileID, Role: saved.Role, Accent: saved.Accent, Icon: saved.Icon, SwarmX: saved.SwarmX, SwarmY: saved.SwarmY, Cols: saved.Cols, Rows: saved.Rows, Args: saved.Args, Env: saved.Env}, saved.ID)
	}
	return TerminalSnapshot{}, fmt.Errorf("saved worker not found: %s", id)
}

func (h *SessionHost) restoreDeck() ([]TerminalSnapshot, error) {
	deck, err := h.listSavedDeck()
	if err != nil {
		return nil, err
	}
	result := make([]TerminalSnapshot, 0, len(deck))
	for _, saved := range deck {
		if strings.TrimSpace(saved.Command) == "" {
			continue
		}
		if _, err := h.session(saved.ID); err == nil {
			continue
		}
		snapshot, spawnErr := h.resumeTerminal(saved.ID)
		if spawnErr != nil {
			return result, spawnErr
		}
		result = append(result, snapshot)
	}
	return result, nil
}

func (h *SessionHost) addSubscriber(conn net.Conn) {
	h.mu.Lock()
	h.subscribers[conn] = struct{}{}
	h.mu.Unlock()
}

func (h *SessionHost) isSubscriber(conn net.Conn) bool {
	h.mu.RLock()
	_, ok := h.subscribers[conn]
	h.mu.RUnlock()
	return ok
}

func (h *SessionHost) removeSubscriber(conn net.Conn) {
	h.mu.Lock()
	delete(h.subscribers, conn)
	h.mu.Unlock()
}

func (h *SessionHost) emit(name string, payload any) {
	h.mu.RLock()
	emitter := h.emitter
	h.mu.RUnlock()
	if emitter != nil {
		emitter(name, payload)
	}
	message := map[string]any{"type": name, "data": payload}
	if name == "terminal-output" {
		message["type"] = "output"
	} else if name == "terminal-lifecycle" {
		message["type"] = "lifecycle"
	} else if name == "terminal-session" {
		message["type"] = "session"
	}
	h.emitBridge(message)
}

func (h *SessionHost) emitLifecycle(id, label, state string) {
	h.emit("terminal-lifecycle", TerminalLifecycleEvent{ID: id, Label: label, State: state})
}

func (h *SessionHost) emitBridge(message map[string]any) {
	data, err := json.Marshal(message)
	if err != nil {
		return
	}
	h.mu.RLock()
	subscribers := make([]net.Conn, 0, len(h.subscribers))
	for subscriber := range h.subscribers {
		subscribers = append(subscribers, subscriber)
	}
	h.mu.RUnlock()
	for _, subscriber := range subscribers {
		if _, err := subscriber.Write(append(data, '\n')); err != nil {
			h.removeSubscriber(subscriber)
			_ = subscriber.Close()
		}
	}
}

func writeJSONLine(writer io.Writer, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = writer.Write(append(data, '\n'))
	return err
}

func stripANSI(value string) string {
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		if value[index] != 0x1b {
			builder.WriteByte(value[index])
			continue
		}
		if index+1 >= len(value) {
			break
		}
		index++
		if value[index] != '[' {
			continue
		}
		for index+1 < len(value) {
			index++
			if value[index] >= 0x40 && value[index] <= 0x7e {
				break
			}
		}
	}
	return builder.String()
}

func (a *App) UpdateAppContext(context HostAppContext) error {
	a.host.updateAppContext(context)
	return nil
}

func (a *App) ListTerminals() []TerminalSnapshot {
	return a.host.listSnapshots()
}

func (a *App) ListSavedTerminalDeck() ([]TerminalSnapshot, error) {
	return a.host.listSavedDeck()
}

func (a *App) RestoreTerminalDeck() ([]TerminalSnapshot, error) {
	return a.host.restoreDeck()
}

func (a *App) ResumeTerminal(id string) (TerminalSnapshot, error) {
	return a.host.resumeTerminal(id)
}

var workerFirstNames = []string{"Ari", "Bea", "Cleo", "Dev", "Emi", "Finn", "Gia", "Hugo", "Iris", "Juno", "Kira", "Luca", "Mara", "Nico", "Opal", "Pax", "Quinn", "Rae", "Sage", "Tess", "Uma", "Vera", "Wren", "Xavi", "Yara", "Zeke", "Ada", "Bryn", "Cora", "Dax", "Eden", "Nova"}
var workerLastNames = []string{"Ash", "Bell", "Cole", "Dale", "Ellis", "Finch", "Gray", "Hale", "Knox", "Lane", "Moss", "Reed", "Aster", "Briar", "Cedar", "Drake", "Ember", "Frost", "Grove", "Harbor", "Ivory", "Jasper", "Kepler", "Lumen", "North", "Orion", "Piper", "Quill", "Rowan", "Sloan", "Vale", "Willow"}

func (h *SessionHost) workerName() (string, error) {
	deck, err := h.listSavedDeck()
	if err != nil {
		return "", err
	}
	used := map[string]bool{}
	for _, saved := range deck {
		used[strings.ToLower(saved.Title)] = true
	}
	for _, active := range h.listSnapshots() {
		used[strings.ToLower(active.Title)] = true
	}
	available := make([]string, 0, len(workerFirstNames)*len(workerLastNames))
	for _, first := range workerFirstNames {
		for _, last := range workerLastNames {
			name := first + " " + last
			if !used[strings.ToLower(name)] {
				available = append(available, name)
			}
		}
	}
	if len(available) > 0 {
		return available[rand.Intn(len(available))], nil
	}
	for suffix := 2; ; suffix++ {
		name := fmt.Sprintf("%s %s %d", workerFirstNames[rand.Intn(len(workerFirstNames))], workerLastNames[rand.Intn(len(workerLastNames))], suffix)
		if !used[strings.ToLower(name)] {
			return name, nil
		}
	}
}

func (a *App) SpawnTerminal(request TerminalLaunchRequest) (TerminalSnapshot, error) {
	if request.CWD == "" {
		request.CWD = a.workspace
	}
	if request.Label == "" && request.ProfileID != "" {
		a.host.nameMu.Lock()
		defer a.host.nameMu.Unlock()
		name, err := a.host.workerName()
		if err != nil {
			return TerminalSnapshot{}, err
		}
		request.Label = name
	}
	snapshot, err := a.host.spawn(request, "")
	if err == nil {
		_ = ensureBridgeCLI()
	}
	return snapshot, err
}

func (a *App) WriteTerminal(id, data string) error {
	return a.host.write(id, data)
}

func (a *App) ResizeTerminal(id string, cols, rows int) error {
	return a.host.resize(id, cols, rows)
}

func (a *App) KillTerminal(id string) error {
	return a.host.kill(id)
}

func (a *App) RemoveTerminal(id string) error {
	return a.host.remove(id)
}

func (a *App) UpdateTerminalMetadata(id string, patch TerminalMetadataPatch) error {
	return a.host.updateMetadata(id, patch)
}

func ensureBridgeCLI() error {
	paths, err := (&App{}).AppPaths()
	if err != nil {
		return err
	}
	binDir := filepath.Join(paths.RuntimeDir, "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		return err
	}
	bridgePath := filepath.Join(binDir, "agentoffice-bridge.js")
	if err := os.WriteFile(bridgePath, []byte(bridgeCLI), 0o700); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		wrapper := filepath.Join(binDir, "agentoffice-bridge.cmd")
		return os.WriteFile(wrapper, []byte("@echo off\r\nnode \"%~dp0agentoffice-bridge.js\" %*\r\n"), 0o700)
	}
	return nil
}

const bridgeCLI = `#!/usr/bin/env node
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const home = process.env.AGENTOFFICE_HOME || path.join(os.homedir(), ".agentoffice");
const info = JSON.parse(fs.readFileSync(path.join(home, "session-host.json"), "utf8"));
const request = { type: process.argv[2] || "ping" };
const values = process.argv.slice(3);
if (request.type === "write") { request.id = values.shift(); request.data = values.join(" "); }
else if (request.type === "read" || request.type === "kill" || request.type === "remove") request.id = values.shift();
else if (request.type === "resize") { request.id = values.shift(); request.cols = Number(values.shift()); request.rows = Number(values.shift()); }
else if (request.type === "spawn") { request.request = { command: values.shift(), args: values }; }
const socket = net.createConnection(info.port, "127.0.0.1", () => socket.write(JSON.stringify(request) + "\n"));
let output = "";
socket.on("data", chunk => { output += chunk.toString(); const lines = output.split("\n"); output = lines.pop(); for (const line of lines) if (line) { process.stdout.write(line + "\n"); socket.end(); } });
socket.on("error", error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
`
