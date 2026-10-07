package office

import "time"

type ProviderModel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type ProviderSelection struct {
	ProviderID string `json:"providerId,omitempty"`
	ModelID    string `json:"modelId,omitempty"`
}
type ProviderEntry struct {
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	API           string          `json:"api"`
	BaseURL       string          `json:"baseUrl"`
	APIKey        string          `json:"apiKey,omitempty"`
	Credential    map[string]any  `json:"credential,omitempty"`
	HasCredential bool            `json:"hasCredential"`
	Source        string          `json:"source,omitempty"`
	Models        []ProviderModel `json:"models"`
	ModelID       string          `json:"-"`
	ModelName     string          `json:"-"`
}
type ProviderConfig struct {
	Providers []ProviderEntry   `json:"providers"`
	Selected  ProviderSelection `json:"selected"`
}
type ImportSource struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}
type ImportResult struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Details  []string `json:"details,omitempty"`
}
type OpenAICodexOAuthStart struct {
	DeviceAuthID    string `json:"deviceAuthId"`
	UserCode        string `json:"userCode"`
	VerificationURI string `json:"verificationUri"`
	IntervalSeconds uint64 `json:"intervalSeconds"`
}
type ConductorSessionEvent struct {
	EventType  string  `json:"eventType"`
	Role       string  `json:"role"`
	Content    string  `json:"content"`
	ProviderID *string `json:"providerId,omitempty"`
}
type ChatMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}
type ConductorChatRequest struct {
	ProviderID string        `json:"providerId"`
	History    []ChatMessage `json:"history"`
	ModelID    *string       `json:"modelId,omitempty"`
	TimeoutMS  *uint64       `json:"timeoutMs,omitempty"`
}
type ConductorChatResult struct {
	AssistantText string  `json:"assistantText"`
	Cancelled     bool    `json:"cancelled"`
	Error         *string `json:"error"`
}
type ConductorSessionFile struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	Active     bool   `json:"active"`
	UpdatedAt  int64  `json:"updatedAt"`
	CustomName string `json:"customName,omitempty"`
}
type ExtensionInfo struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Path   string   `json:"path"`
	Scope  string   `json:"scope"`
	Status string   `json:"status"`
	Entry  string   `json:"entry,omitempty"`
	API    []string `json:"api"`
}
type AppPathsRecord struct {
	DataDir       string `json:"dataDir"`
	RuntimeDir    string `json:"runtimeDir"`
	AgentsDir     string `json:"agentsDir"`
	SkillsDir     string `json:"skillsDir"`
	ExtensionsDir string `json:"extensionsDir"`
	LogsDir       string `json:"logsDir"`
}
type DirectoryEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}
type SkillEntry struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Preview string `json:"preview"`
}
type FileOperationEvent struct {
	ID           string `json:"id"`
	Path         string `json:"path"`
	Source       string `json:"source"`
	Status       string `json:"status"`
	StartLine    int    `json:"startLine"`
	RemovedLines int    `json:"removedLines"`
	AddedLines   int    `json:"addedLines"`
	InsertedText string `json:"insertedText"`
}
type WorkspaceRecord struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	CWD       string   `json:"cwd"`
	Folders   []string `json:"folders,omitempty"`
	CreatedAt string   `json:"createdAt"`
	UpdatedAt string   `json:"updatedAt"`
	IsSaved   bool     `json:"isSaved"`
	Color     string   `json:"color,omitempty"`
}
type AppStateRecord struct {
	LastWorkspaceID *string `json:"lastWorkspaceId,omitempty"`
}
type SaveWorkspaceRequest struct {
	ID      *string  `json:"id,omitempty"`
	Name    string   `json:"name"`
	CWD     string   `json:"cwd"`
	Folders []string `json:"folders"`
	Color   string   `json:"color,omitempty"`
}
type ImageAttachmentPayload struct {
	Name     string `json:"name"`
	MIMEType string `json:"mimeType"`
	Data     string `json:"data"`
}
type AppLogEvent struct {
	Level   string         `json:"level"`
	Target  string         `json:"target"`
	Message string         `json:"message"`
	Fields  map[string]any `json:"fields,omitempty"`
}
type AgentProfile struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Role         string            `json:"role"`
	Command      string            `json:"command"`
	Args         []string          `json:"args"`
	CWD          string            `json:"cwd"`
	Env          map[string]string `json:"env"`
	Accent       string            `json:"accent"`
	Description  string            `json:"description"`
	DetectedPath string            `json:"detectedPath,omitempty"`
}
type HostAppContext struct {
	AppName       string  `json:"appName"`
	WorkspaceName string  `json:"workspaceName"`
	WorkspaceCWD  string  `json:"workspaceCwd"`
	SelectedPath  *string `json:"selectedPath,omitempty"`
	Language      string  `json:"language"`
	IsDirty       bool    `json:"isDirty"`
	Contents      string  `json:"contents"`
	IsTruncated   bool    `json:"isTruncated"`
	UpdatedAt     int64   `json:"updatedAt"`
}
type TerminalInputEvent struct {
	ID   string `json:"id"`
	Data string `json:"data"`
}
type TerminalLaunchRequest struct {
	RequestedID string            `json:"requestedId,omitempty"`
	Label       string            `json:"label"`
	ProfileID   string            `json:"profileId"`
	Command     string            `json:"command"`
	Args        []string          `json:"args"`
	CWD         string            `json:"cwd,omitempty"`
	Env         map[string]string `json:"env"`
	Role        string            `json:"role"`
	Accent      string            `json:"accent"`
	Icon        string            `json:"icon,omitempty"`
	SwarmX      float64           `json:"swarmX"`
	SwarmY      float64           `json:"swarmY"`
	Cols        uint16            `json:"cols"`
	Rows        uint16            `json:"rows"`
}
type TerminalMetadataPatch struct {
	Title  *string  `json:"title,omitempty"`
	Role   *string  `json:"role,omitempty"`
	Accent *string  `json:"accent,omitempty"`
	Icon   *string  `json:"icon,omitempty"`
	CWD    *string  `json:"cwd,omitempty"`
	SwarmX *float64 `json:"swarmX,omitempty"`
	SwarmY *float64 `json:"swarmY,omitempty"`
	State  *string  `json:"state,omitempty"`
}
type TerminalSnapshot struct {
	ID        string            `json:"id"`
	ProfileID string            `json:"profileId"`
	Title     string            `json:"title"`
	Role      string            `json:"role"`
	Accent    string            `json:"accent"`
	Icon      string            `json:"icon,omitempty"`
	CWD       string            `json:"cwd"`
	Command   string            `json:"command"`
	Args      []string          `json:"args"`
	Env       map[string]string `json:"env"`
	SwarmX    float64           `json:"swarmX"`
	SwarmY    float64           `json:"swarmY"`
	State     string            `json:"state"`
	ActivityState string       `json:"activityState,omitempty"`
	Backlog   string            `json:"backlog"`
	Mode      string            `json:"mode,omitempty"`
	Cols      uint16            `json:"cols,omitempty"`
	Rows      uint16            `json:"rows,omitempty"`
}
type TerminalOutputEvent struct {
	ID   string `json:"id"`
	Data string `json:"data"`
}
type TerminalLifecycleEvent struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	State string `json:"state"`
}
type TerminalSessionEvent struct {
	Session TerminalSnapshot `json:"session"`
}
type TerminalReadback struct {
	ID        string `json:"id"`
	ProfileID string `json:"profileId"`
	Title     string `json:"title"`
	Role      string `json:"role"`
	CWD       string `json:"cwd"`
	State     string `json:"state"`
	Text      string `json:"text"`
}
type persistedSessionEvent struct {
	TS         int64   `json:"ts"`
	EventType  string  `json:"eventType"`
	Role       string  `json:"role"`
	Content    string  `json:"content"`
	ProviderID *string `json:"providerId,omitempty"`
}

func nowMillis() int64 { return time.Now().UnixMilli() }
