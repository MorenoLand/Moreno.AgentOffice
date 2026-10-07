package office

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func sanitizeSessionComponent(raw string) string {
	var builder strings.Builder
	for _, char := range raw {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || strings.ContainsRune("-_.", char) {
			builder.WriteRune(char)
		} else if char == ' ' || strings.ContainsRune("/\\:*?\"<>|", char) {
			builder.WriteByte('_')
		}
		if builder.Len() >= 80 {
			break
		}
	}
	value := strings.Trim(builder.String(), "_.")
	if value == "" {
		return "workspace"
	}
	return value
}
func legacyWorkspaceSlug(cwd, name *string) string {
	if name != nil && strings.TrimSpace(*name) != "" && *name != "Untitled Workspace" && *name != "AgentOffice" {
		return strings.ReplaceAll(sanitizeSessionComponent(*name), "_", "-")
	}
	if cwd != nil && strings.TrimSpace(*cwd) != "" {
		value := filepath.Base(*cwd)
		slug := strings.ReplaceAll(sanitizeSessionComponent(value), "_", "-")
		if slug != "workspace" {
			return slug
		}
	}
	return "workspace"
}
func shortHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:8]
}
func workspaceSessionSlug(id, cwd, name *string) string {
	if id != nil && strings.TrimSpace(*id) != "" && *id != "draft" {
		value := strings.ReplaceAll(sanitizeSessionComponent(*id), "_", "-")
		if len(value) > 18 {
			value = value[:18]
		}
		return "workspace-" + value
	}
	identity := "workspace"
	if cwd != nil && *cwd != "" {
		identity = *cwd
	} else if name != nil && *name != "" {
		identity = *name
	}
	return legacyWorkspaceSlug(cwd, name) + "-" + shortHash(identity)
}
func conductorSessionsDir(id, cwd, name *string) (string, error) {
	home, err := agentOfficeHomeDir()
	if err != nil {
		return "", err
	}
	path := filepath.Join(home, "sessions", workspaceSessionSlug(id, cwd, name))
	return path, os.MkdirAll(path, 0o755)
}
func conductorSessionPath(id, cwd, name *string) (string, error) {
	dir, err := conductorSessionsDir(id, cwd, name)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "native-conductor.jsonl"), nil
}

func (a *App) AppendConductorSessionEvent(event ConductorSessionEvent, workspaceID, workspaceCWD, workspaceName *string) error {
	path, err := conductorSessionPath(workspaceID, workspaceCWD, workspaceName)
	if err != nil {
		return err
	}
	record := map[string]any{"ts": nowMillis(), "eventType": event.EventType, "role": event.Role, "content": event.Content, "providerId": event.ProviderID, "workspaceId": workspaceID, "workspaceCwd": workspaceCWD, "workspaceName": workspaceName}
	body, err := json.Marshal(record)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(body, '\n'))
	return err
}

func sessionMetaPath(path string) string { return path + ".meta.json" }
func sessionCustomName(path string) string {
	body, err := os.ReadFile(sessionMetaPath(path))
	if err != nil {
		return ""
	}
	var value struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(body, &value) != nil {
		return ""
	}
	return strings.TrimSpace(value.Name)
}

func loadSessionRecords(path string) ([]map[string]any, error) {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return []map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	records := make([]map[string]any, 0)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 32*1024), 2*1024*1024)
	for scanner.Scan() {
		var record map[string]any
		if json.Unmarshal(scanner.Bytes(), &record) == nil {
			records = append(records, record)
		}
	}
	return records, scanner.Err()
}

func (a *App) ListConductorSessions(workspaceID, workspaceCWD, workspaceName *string) ([]ConductorSessionFile, error) {
	dir, err := conductorSessionsDir(workspaceID, workspaceCWD, workspaceName)
	if err != nil {
		return nil, err
	}
	active := filepath.Join(dir, "native-conductor.jsonl")
	if _, err := os.Stat(active); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(active, nil, 0o600); err != nil {
			return nil, err
		}
	}
	items := make([]ConductorSessionFile, 0)
	collectSessionFiles(dir, &items)
	if workspaceID == nil || *workspaceID == "draft" {
		home, _ := agentOfficeHomeDir()
		legacy := filepath.Join(home, "sessions", legacyWorkspaceSlug(workspaceCWD, workspaceName))
		if legacy != dir {
			collectSessionFiles(legacy, &items)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Active != items[j].Active {
			return items[i].Active
		}
		return items[i].UpdatedAt > items[j].UpdatedAt
	})
	seen := map[string]bool{}
	result := items[:0]
	for _, item := range items {
		if !seen[item.Path] {
			result = append(result, item)
			seen[item.Path] = true
		}
	}
	return result, nil
}

func collectSessionFiles(dir string, items *[]ConductorSessionFile) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "native-conductor") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		info, _ := entry.Info()
		updated := int64(0)
		if info != nil {
			updated = info.ModTime().UnixMilli()
		}
		path := filepath.Join(dir, name)
		*items = append(*items, ConductorSessionFile{Path: path, Name: name, Active: name == "native-conductor.jsonl", UpdatedAt: updated, CustomName: sessionCustomName(path)})
	}
}
func (a *App) LoadConductorSessionFile(path string) ([]map[string]any, error) {
	return loadSessionRecords(path)
}
func (a *App) LoadConductorSession(workspaceID, workspaceCWD, workspaceName *string) ([]map[string]any, error) {
	path, err := conductorSessionPath(workspaceID, workspaceCWD, workspaceName)
	if err != nil {
		return nil, err
	}
	if records, err := loadSessionRecords(path); err == nil && len(records) > 0 {
		return records, nil
	}
	return loadSessionRecords(path)
}
func (a *App) NewConductorSession(workspaceID, workspaceCWD, workspaceName *string) (string, error) {
	path, err := conductorSessionPath(workspaceID, workspaceCWD, workspaceName)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(path); err == nil {
		archive := filepath.Join(filepath.Dir(path), "native-conductor-"+fmtMillis()+".jsonl")
		if err := os.Rename(path, archive); err != nil {
			return "", err
		}
		if _, err := os.Stat(sessionMetaPath(path)); err == nil {
			_ = os.Rename(sessionMetaPath(path), sessionMetaPath(archive))
		}
	}
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		return "", err
	}
	return path, nil
}
func (a *App) OpenConductorSessionPath(path string) (string, error) {
	if a.browser != nil {
		if err := a.browser.OpenFile(path); err != nil {
			return "", err
		}
	}
	return path, nil
}
func (a *App) OpenConductorSessionFile(workspaceID, workspaceCWD, workspaceName *string, requestedPath string) (string, error) {
	path := requestedPath
	if path == "" {
		var err error
		path, err = conductorSessionPath(workspaceID, workspaceCWD, workspaceName)
		if err != nil {
			return "", err
		}
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			if err := os.WriteFile(path, nil, 0o600); err != nil {
				return "", err
			}
		}
	}
	return a.OpenConductorSessionPath(path)
}
func fmtMillis() string { return fmt.Sprintf("%d", nowMillis()) }

func (a *App) DiscoverExtensionScaffold(workspaceCWD *string) ([]ExtensionInfo, error) {
	roots := make([]struct{ scope, path string }, 0, 2)
	home, err := agentOfficeHomeDir()
	if err != nil {
		return nil, err
	}
	roots = append(roots, struct{ scope, path string }{"user", filepath.Join(home, "extensions")})
	if workspaceCWD != nil && strings.TrimSpace(*workspaceCWD) != "" {
		roots = append(roots, struct{ scope, path string }{"project", filepath.Join(*workspaceCWD, ".agentoffice", "extensions")})
	}
	result := make([]ExtensionInfo, 0)
	for _, root := range roots {
		entries, readErr := os.ReadDir(root.path)
		if readErr != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			path := filepath.Join(root.path, entry.Name())
			name := entry.Name()
			entryFile := findExtensionEntry(path)
			if body, readErr := os.ReadFile(filepath.Join(path, "package.json")); readErr == nil {
				var packageJSON struct {
					Name string `json:"name"`
					Main string `json:"main"`
				}
				if json.Unmarshal(body, &packageJSON) == nil {
					name = first(packageJSON.Name, name)
					if packageJSON.Main != "" && exists(filepath.Join(path, packageJSON.Main)) {
						entryFile = filepath.Join(path, packageJSON.Main)
					}
				}
			}
			status := "missing-entry"
			if entryFile != "" {
				status = "discovered"
			}
			result = append(result, ExtensionInfo{ID: root.scope + ":" + entry.Name(), Name: name, Path: path, Scope: root.scope, Status: status, Entry: entryFile, API: []string{"export default function(api)", "api.registerTool", "api.registerCommand", "api.registerProviderAdapter", "api.registerFileEditHook", "api.registerAgentLifecycleHook"}})
		}
	}
	return result, nil
}
func findExtensionEntry(path string) string {
	for _, name := range []string{"index.ts", "index.js", "extension.ts", "extension.js", "main.ts", "main.js"} {
		candidate := filepath.Join(path, name)
		if exists(candidate) {
			return candidate
		}
	}
	return ""
}
