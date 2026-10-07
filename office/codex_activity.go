package office

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

const codexActivityQuietPeriod = 30 * time.Second

var codexHookEvents = []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Interrupt"}

type codexHookPayload struct {
	SessionID  string `json:"session_id"`
	AgentID    string `json:"agent_id"`
	AgentType  string `json:"agent_type"`
	Source     string `json:"source"`
	ToolName   string `json:"tool_name"`
	ToolUseID  string `json:"tool_use_id"`
}

func isCodexTerminal(profile, command string) bool {
	return strings.Contains(strings.ToLower(profile+" "+command), "codex")
}

func codexHookArgs(executable string) []string {
	args := make([]string, 0, len(codexHookEvents)*2)
	for _, event := range codexHookEvents {
		command := hookShellQuote(executable) + " codex-hook " + hookShellQuote(event)
		config := fmt.Sprintf(`hooks.%s=[{hooks=[{type="command",command=%s,timeout=3}]}]`, event, strconv.Quote(command))
		args = append(args, "-c", config)
	}
	return args
}

func hookShellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }

func RunCodexHook(args []string, input io.Reader, output io.Writer) error {
	if len(args) != 1 || !containsString(codexHookEvents, args[0]) {
		return nil
	}
	port := strings.TrimSpace(os.Getenv("AGENTOFFICE_HOST_PORT"))
	id := strings.TrimSpace(os.Getenv("AGENTOFFICE_SESSION_ID"))
	token := strings.TrimSpace(os.Getenv("AGENTOFFICE_HOOK_TOKEN"))
	if port == "" || id == "" || token == "" {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(input, 64*1024+1))
	if err != nil || len(raw) > 64*1024 {
		return nil
	}
	var payload codexHookPayload
	if json.Unmarshal(raw, &payload) != nil || strings.TrimSpace(payload.SessionID) == "" || len(payload.SessionID) > 160 || len(payload.ToolName) > 160 || len(payload.ToolUseID) > 160 || payload.AgentID != "" || payload.AgentType != "" {
		return nil
	}
	compact, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", port), 2*time.Second)
	if err != nil {
		return nil
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if json.NewEncoder(conn).Encode(hostRequest{Type: "codex_hook", ID: id, Token: token, Event: args[0], Data: string(compact)}) != nil {
		return nil
	}
	var response hostResponse
	if json.NewDecoder(conn).Decode(&response) == nil && response.Type == "ok" {
		_, _ = io.WriteString(output, "{}")
	}
	return nil
}

func containsString(values []string, value string) bool { for _, item := range values { if item == value { return true } }; return false }

func (h *SessionHost) handleCodexHook(request hostRequest) error {
	if !containsString(codexHookEvents, request.Event) {
		return fmt.Errorf("unsupported Codex hook event")
	}
	session, err := h.session(request.ID)
	if err != nil {
		return err
	}
	var payload codexHookPayload
	if len(request.Data) > 64*1024 || json.Unmarshal([]byte(request.Data), &payload) != nil || strings.TrimSpace(payload.SessionID) == "" || len(payload.SessionID) > 160 || len(payload.ToolName) > 160 || len(payload.ToolUseID) > 160 || payload.AgentID != "" || payload.AgentType != "" {
		return fmt.Errorf("invalid Codex hook payload")
	}
	session.mu.Lock()
	if session.hookToken == "" || subtle.ConstantTimeCompare([]byte(request.Token), []byte(session.hookToken)) != 1 || !isCodexTerminal(session.snapshot.ProfileID, session.snapshot.Command) {
		session.mu.Unlock()
		return fmt.Errorf("unauthorized Codex hook")
	}
	if request.Event != "SessionStart" && session.codexSessionID != "" && session.codexSessionID != payload.SessionID {
		session.mu.Unlock()
		return fmt.Errorf("stale Codex session")
	}
	if session.codexSessionID == "" {
		session.codexSessionID = payload.SessionID
	}
	if session.codexTools == nil { session.codexTools = map[string]string{} }
	if session.codexPending == nil { session.codexPending = map[string]struct{}{} }
	previous := session.snapshot.ActivityState
	activity := previous
	switch request.Event {
	case "SessionStart":
		session.codexSessionID = payload.SessionID
		session.codexTools = map[string]string{}
		session.codexPending = map[string]struct{}{}
		session.codexPermissionUnknown = false
		session.activityText = ""
		activity = "idle"
	case "UserPromptSubmit":
		session.codexTools = map[string]string{}
		session.codexPending = map[string]struct{}{}
		session.codexPermissionUnknown = false
		activity = "working"
	case "PreToolUse":
		if payload.ToolUseID != "" && (len(session.codexTools) < 256 || session.codexTools[payload.ToolUseID] != "") { session.codexTools[payload.ToolUseID] = payload.ToolName }
		if strings.Contains(strings.ToLower(payload.ToolName), "askuserquestion") || strings.Contains(strings.ToLower(payload.ToolName), "request_user_input") {
			if payload.ToolUseID != "" { session.codexPending[payload.ToolUseID] = struct{}{} } else { session.codexPermissionUnknown = true }
		}
		activity = "working"
		if len(session.codexPending) > 0 || session.codexPermissionUnknown { activity = "needs_input" }
	case "PermissionRequest":
		matched := false
		for id, tool := range session.codexTools { if tool == payload.ToolName { session.codexPending[id] = struct{}{}; matched = true } }
		if !matched { session.codexPermissionUnknown = true }
		activity = "needs_input"
	case "PostToolUse":
		delete(session.codexTools, payload.ToolUseID)
		delete(session.codexPending, payload.ToolUseID)
		if len(session.codexPending) > 0 || session.codexPermissionUnknown { activity = "needs_input" } else { activity = "working" }
	case "Stop", "Interrupt":
		session.codexTools = map[string]string{}
		session.codexPending = map[string]struct{}{}
		session.codexPermissionUnknown = false
		activity = "done"
	}
	session.snapshot.ActivityState = activity
	if activity == "working" { session.lastActivity = time.Now() }
	snapshot := session.snapshot
	session.mu.Unlock()
	if previous != activity { h.emitLifecycle(snapshot.ID, snapshot.Title, activity) }
	h.touchActivity(session)
	_ = h.persistDeck()
	return nil
}

func (h *SessionHost) touchActivity(session *hostSession) {
	session.mu.Lock()
	if session.closed || session.snapshot.ActivityState != "working" {
		if session.activityTimer != nil { session.activityTimer.Stop(); session.activityTimer = nil }
		session.mu.Unlock()
		return
	}
	session.lastActivity = time.Now()
	if session.activityTimer == nil { session.activityTimer = time.AfterFunc(codexActivityQuietPeriod, func() { h.expireActivity(session) }) } else { session.activityTimer.Reset(codexActivityQuietPeriod) }
	session.mu.Unlock()
}

func (h *SessionHost) expireActivity(session *hostSession) {
	session.mu.Lock()
	if session.closed || session.snapshot.ActivityState != "working" { session.activityTimer = nil; session.mu.Unlock(); return }
	quiet := time.Since(session.lastActivity)
	if quiet < codexActivityQuietPeriod { session.activityTimer.Reset(codexActivityQuietPeriod - quiet); session.mu.Unlock(); return }
	session.snapshot.ActivityState = "idle"
	session.activityText = ""
	session.activityTimer = nil
	snapshot := session.snapshot
	session.mu.Unlock()
	h.emitLifecycle(snapshot.ID, snapshot.Title, "idle")
	_ = h.persistDeck()
}
