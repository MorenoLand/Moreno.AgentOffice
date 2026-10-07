package office

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
)

var errReadOnly = errors.New("guests have read-only access")
var errOwnerOnly = errors.New("admin access required")
var errAuthOverHTTP = errors.New("authenticate over HTTP")

var publicCommands = map[string]bool{
	"auth_whoami": true, "auth_register": true, "auth_login": true,
	"auth_guest_request": true, "auth_guest_poll": true, "auth_logout": true,
	"auth_config": true,
}

var guestCommands = map[string]bool{
	"auth_pending_guests": false, "app_paths": true, "list_app_state": true,
	"list_terminals": true, "list_providers": true, "detect_agent_profiles": true,
	"list_workspaces": true, "provider_usage": true, "workspace_options": true,
	"whiteboard_get":   true,
	"office_state_get": true,
	"vehicles_get":     true,
	"dog_pet":          true,
	"chat_send":        true,
}

var moderationCommands = map[string]bool{
	"auth_kick_user": true, "auth_ban_user": true,
	"auth_unban_user": true, "auth_banned_users": true,
	"auth_set_nickname": true,
	"scan_music":        true,
}

func isPublicCommand(command string) bool { return publicCommands[command] }

func commandAllowed(command string, role Role) bool {
	if isPublicCommand(command) {
		return true
	}
	if moderationCommands[command] {
		return role == RoleOwner
	}
	if role == RoleGuest {
		return guestCommands[command]
	}
	return true
}

type App struct {
	host            *SessionHost
	browser         Browser
	hub             *Hub
	auth            *AuthStore
	workspace       string
	allowCreate     bool
	conductor       sync.Mutex
	conductorCancel func()
	ctx             context.Context
	officeMu        sync.RWMutex
	officeState     OfficeState
	wallImageMu     sync.Mutex
	wallImageCache  map[string]wallImageCacheEntry
	wallImageBytes  int64
	musicMu         sync.RWMutex
	musicRoot       string
	musicFiles      map[string]string
}

func NewApp() *App {
	a := &App{host: NewSessionHost(), ctx: context.Background(), officeState: OfficeState{LightsOn: true, LightRows: [3]bool{true, true, true}, BreakroomOn: true, BlindStages: map[string]int{}, Season: "auto", WallArt: []WallArtPlacement{}}, wallImageCache: make(map[string]wallImageCacheEntry), musicFiles: make(map[string]string)}
	a.loadOfficeState()
	return a
}

func (a *App) context() context.Context { return a.ctx }

func (a *App) dataDir() string {
	home, err := agentOfficeHomeDir()
	if err != nil {
		return ".agentoffice"
	}
	return home
}

func (a *App) attach(hub *Hub) {
	a.hub = hub
	a.auth = hub.auth
	a.host.setEmitter(a.emit)
	if err := a.host.start(); err != nil {
		return
	}
}

func (a *App) emit(name string, data any) {
	if a.hub != nil {
		a.hub.Send(name, data)
	}
}

func (a *App) shutdown() {
	a.conductor.Lock()
	if a.conductorCancel != nil {
		a.conductorCancel()
		a.conductorCancel = nil
	}
	a.conductor.Unlock()
	a.host.shutdown()
}

// handleAuth serves the commands that need the raw request: cookie writes and
// pre-session access. Returns handled=false when the command is not an auth one.
func (a *App) handleAuth(w http.ResponseWriter, command string, args map[string]any, user *User, session *Session) (any, bool, error) {
	switch command {
	case "auth_register":
		if !a.allowCreate && a.auth.HasUsers() {
			return nil, true, errors.New("account creation is disabled on this server")
		}
		created, session, err := a.auth.createUser(stringArg(args, "username"), stringArg(args, "password"), RoleMember)
		if err != nil {
			return nil, true, err
		}
		setSessionCookie(w, session)
		return map[string]any{"user": publicUser(created)}, true, nil
	case "auth_login":
		loggedIn, session, err := a.auth.Login(stringArg(args, "username"), stringArg(args, "password"))
		if err != nil {
			return nil, true, err
		}
		setSessionCookie(w, session)
		return map[string]any{"user": publicUser(loggedIn)}, true, nil
	case "auth_guest_request":
		pending, request, err := a.auth.RequestGuest(stringArg(args, "username"))
		if err != nil {
			return nil, true, err
		}
		a.broadcastPendingGuests()
		return map[string]any{"user": publicUser(pending), "requestToken": request.Token}, true, nil
	case "auth_guest_poll":
		polled, session, approved := a.auth.GuestApproved(stringArg(args, "username"), stringArg(args, "requestToken"))
		if polled == nil {
			return nil, true, errors.New("no such guest request")
		}
		if !approved {
			return map[string]any{"approved": false, "declined": false}, true, nil
		}
		setSessionCookie(w, session)
		return map[string]any{"approved": true, "user": publicUser(polled)}, true, nil
	case "auth_logout":
		if session != nil {
			a.auth.Logout(session.Token)
		}
		clearSessionCookie(w)
		return map[string]any{"ok": true}, true, nil
	case "auth_whoami":
		return map[string]any{"user": publicUser(user)}, true, nil
	case "auth_config":
		return map[string]any{"allowCreate": a.allowCreate || !a.auth.HasUsers(), "hasUsers": a.auth.HasUsers()}, true, nil
	}
	return nil, false, nil
}

func (a *App) broadcastPendingGuests() {
	if a.hub == nil {
		return
	}
	a.hub.Send("pending-guests", a.auth.PendingGuests())
}

func (a *App) Invoke(command string, args map[string]any) (any, error) {
	switch command {
	case "vehicles_get":
		if a.hub == nil {
			return nil, errors.New("office connection unavailable")
		}
		return a.hub.vehiclesSnapshot(), nil
	case "vehicle_enter", "vehicle_move", "vehicle_exit":
		return nil, errors.New("vehicle controls require a live WebSocket connection")
	case "auth_pending_guests":
		return a.auth.PendingGuests(), nil
	case "auth_approve_guest":
		approved, err := a.auth.SetApproved(stringArg(args, "username"), true)
		if err != nil {
			return nil, err
		}
		a.broadcastPendingGuests()
		return publicUser(approved), nil
	case "auth_deny_guest":
		a.broadcastPendingGuests()
		if _, err := a.auth.SetApproved(stringArg(args, "username"), false); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	case "log_app_event":
		var event AppLogEvent
		if err := decodeArgValue(args, "event", &event); err != nil {
			return nil, err
		}
		return nil, a.logAppEvent(event)
	case "write_terminal":
		return nil, a.WriteTerminal(stringArg(args, "id"), stringArg(args, "data"))
	case "append_conductor_session_event":
		var event ConductorSessionEvent
		if err := decodeArgValue(args, "event", &event); err != nil {
			return nil, err
		}
		return nil, a.AppendConductorSessionEvent(event, optionalString(args, "workspaceId"), optionalString(args, "workspaceCwd"), optionalString(args, "workspaceName"))
	case "update_app_context":
		var hostContext HostAppContext
		if err := decodeArgValue(args, "context", &hostContext); err != nil {
			return nil, err
		}
		return nil, a.UpdateAppContext(hostContext)
	case "update_terminal_metadata":
		var patch TerminalMetadataPatch
		if err := decodeArgValue(args, "patch", &patch); err != nil {
			return nil, err
		}
		return nil, a.UpdateTerminalMetadata(stringArg(args, "id"), patch)
	case "kill_terminal":
		return nil, a.KillTerminal(stringArg(args, "id"))
	case "remove_terminal":
		return nil, a.RemoveTerminal(stringArg(args, "id"))
	case "write_text_file":
		return nil, a.WriteTextFile(stringArg(args, "path"), stringArg(args, "contents"))
	case "conductor_abort":
		return nil, a.ConductorAbort()
	case "add_provider":
		var entry ProviderEntry
		if err := decodeArgValue(args, "entry", &entry); err != nil {
			return nil, err
		}
		return nil, a.AddProvider(entry)
	case "list_providers":
		return a.ListProviders()
	case "detect_import_sources":
		return a.DetectImportSources()
	case "import_providers":
		return a.ImportProviders(stringArg(args, "sourceId"))
	case "remove_provider":
		return nil, a.RemoveProvider(stringArg(args, "id"))
	case "save_last_workspace":
		return nil, a.SaveLastWorkspace(stringArg(args, "id"))
	case "list_directory":
		return a.ListDirectory(stringArg(args, "path"))
	case "read_text_file":
		return a.ReadTextFile(stringArg(args, "path"))
	case "create_directory_path":
		return nil, a.CreateDirectoryPath(stringArg(args, "path"))
	case "rename_path":
		return nil, a.RenamePath(stringArg(args, "from"), stringArg(args, "to"))
	case "delete_path":
		return nil, a.DeletePath(stringArg(args, "path"))
	case "reveal_path":
		return nil, a.RevealPath(stringArg(args, "path"))
	case "resize_terminal":
		return nil, a.ResizeTerminal(stringArg(args, "id"), int(uint16Arg(args, "cols")), int(uint16Arg(args, "rows")))
	case "app_paths":
		return a.AppPaths()
	case "detect_agent_profiles":
		return a.DetectAgentProfiles()
	case "list_skills":
		return a.ListSkills()
	case "list_agent_files":
		return a.ListAgentFiles()
	case "list_extensions":
		return a.ListExtensions()
	case "read_skill":
		return a.ReadSkill(stringArg(args, "path"))
	case "load_app_state":
		return a.LoadAppState()
	case "list_conductor_sessions":
		return a.ListConductorSessions(optionalString(args, "workspaceId"), optionalString(args, "workspaceCwd"), optionalString(args, "workspaceName"))
	case "openai_codex_oauth_start":
		return a.OpenAICodexOAuthStart()
	case "openai_codex_oauth_complete":
		return a.OpenAICodexOAuthComplete(stringArg(args, "deviceAuthId"), stringArg(args, "userCode"), uint64Arg(args, "intervalSeconds"))
	case "provider_usage":
		return a.ProviderUsage()
	case "load_conductor_session_file":
		return a.LoadConductorSessionFile(stringArg(args, "path"))
	case "open_conductor_session_path":
		return a.OpenConductorSessionPath(stringArg(args, "path"))
	case "list_workspaces":
		return a.ListWorkspaces()
	case "save_workspace":
		var request SaveWorkspaceRequest
		if err := decodeArgValue(args, "request", &request); err != nil {
			return nil, err
		}
		return a.SaveWorkspace(request)
	case "remove_workspace_config":
		return a.RemoveWorkspaceConfig(stringArg(args, "id"))
	case "read_image_attachment":
		return a.ReadImageAttachment(stringArg(args, "path"))
	case "list_terminals":
		return a.ListTerminals(), nil
	case "list_saved_terminal_deck":
		return a.ListSavedTerminalDeck()
	case "restore_terminal_deck":
		return a.RestoreTerminalDeck()
	case "resume_terminal":
		return a.ResumeTerminal(stringArg(args, "id"))
	case "whiteboard_get":
		return a.WhiteboardGet()
	case "office_state_get":
		return a.OfficeStateGet(), nil
	case "office_state_set":
		state, err := a.OfficeStateSet(args)
		if err == nil {
			a.emit("office-state", state)
		}
		return state, err
	case "whiteboard_save":
		var strokes []WhiteboardStroke
		if err := decodeArgValue(args, "strokes", &strokes); err != nil {
			return nil, err
		}
		return nil, a.WhiteboardSave(strokes)
	case "whiteboard_clear":
		return nil, a.WhiteboardClear()
	case "scan_music":
		return a.ScanMusic(stringArg(args, "path"))
	case "workspace_options":
		saved, err := a.ListWorkspaces()
		if err != nil {
			return nil, err
		}
		paths := []string{a.workspace}
		for _, record := range saved {
			paths = append(paths, record.CWD)
		}
		return map[string]any{"default": a.workspace, "recent": paths}, nil
	case "spawn_terminal":
		var request TerminalLaunchRequest
		if err := decodeArgValue(args, "request", &request); err != nil {
			return nil, err
		}
		return a.SpawnTerminal(request)
	case "conductor_chat":
		var request ConductorChatRequest
		if err := decodeValue(args, &request); err != nil {
			return nil, err
		}
		return a.ConductorChatRequest(request)
	case "load_conductor_session":
		return a.LoadConductorSession(optionalString(args, "workspaceId"), optionalString(args, "workspaceCwd"), optionalString(args, "workspaceName"))
	case "new_conductor_session":
		return a.NewConductorSession(optionalString(args, "workspaceId"), optionalString(args, "workspaceCwd"), optionalString(args, "workspaceName"))
	case "open_conductor_session_file":
		return a.OpenConductorSessionFile(optionalString(args, "workspaceId"), optionalString(args, "workspaceCwd"), optionalString(args, "workspaceName"), stringArg(args, "path"))
	case "discover_extension_scaffold":
		return a.DiscoverExtensionScaffold(optionalString(args, "workspaceCwd"))
	case "shutdown_session_host":
		a.host.shutdown()
		return nil, nil
	default:
		return nil, fmt.Errorf("unknown command %q", command)
	}
}

func (a *App) ConductorChatRequest(request ConductorChatRequest) (ConductorChatResult, error) {
	return a.conductorChat(request)
}

func decodeArgValue(args map[string]any, key string, target any) error {
	value, ok := args[key]
	if !ok {
		return fmt.Errorf("missing argument %q", key)
	}
	return decodeValue(value, target)
}

func decodeValue(value any, target any) error {
	bytes, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(bytes, target)
}

func stringArg(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return value
}

func optionalString(args map[string]any, key string) *string {
	value, ok := args[key].(string)
	if !ok || value == "" {
		return nil
	}
	return &value
}

func uint16Arg(args map[string]any, key string) uint16 {
	value, ok := args[key].(float64)
	if !ok || value < 0 {
		return 0
	}
	return uint16(value)
}

func uint64Arg(args map[string]any, key string) *uint64 {
	value, ok := args[key].(float64)
	if !ok {
		return nil
	}
	result := uint64(value)
	return &result
}
