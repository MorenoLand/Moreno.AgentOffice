package office

import (
	"bufio"
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const maxReadableFileBytes = 8 * 1024 * 1024

func agentOfficeHomeDir() (string, error) {
	if value := strings.TrimSpace(os.Getenv("AGENTOFFICE_HOME")); value != "" {
		return value, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".agentoffice"), nil
}

func runtimeLogDir() (string, error) {
	home, err := agentOfficeHomeDir()
	if err != nil {
		return "", err
	}
	path := filepath.Join(home, "logs")
	return path, os.MkdirAll(path, 0o755)
}

func (a *App) AppPaths() (AppPathsRecord, error) {
	home, err := agentOfficeHomeDir()
	if err != nil {
		return AppPathsRecord{}, err
	}
	agents := filepath.Join(home, "agents")
	skills := filepath.Join(home, "skills")
	extensions := filepath.Join(home, "extensions")
	logs := filepath.Join(home, "logs")
	for _, path := range []string{home, agents, skills, extensions, logs} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			return AppPathsRecord{}, err
		}
	}
	if err := seedDefaults(agents, skills, extensions); err != nil {
		return AppPathsRecord{}, err
	}
	if err := ensureBundledProvider(); err != nil {
		return AppPathsRecord{}, err
	}
	return AppPathsRecord{DataDir: home, RuntimeDir: home, AgentsDir: agents, SkillsDir: skills, ExtensionsDir: extensions, LogsDir: logs}, nil
}

func seedDefaults(agents, skills, extensions string) error {
	defaults := map[string]string{
		"builder.md":  "# Builder\n\nImplement the requested change in the workspace, verify it, and report concrete evidence.\n",
		"reviewer.md": "# Reviewer\n\nInspect the workspace for correctness, regressions, security issues, and missing verification.\n",
		"runner.md":   "# Runner\n\nRun the requested command or test, preserve its output, and report the exact result.\n",
		"scout.md":    "# Scout\n\nTrace the relevant source, configuration, and runtime boundary before proposing a change.\n",
		"sentinel.md": "# Sentinel\n\nWatch the requested process or service and report state changes with timestamps.\n",
	}
	for name, body := range defaults {
		path := filepath.Join(agents, name)
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
				return err
			}
		}
	}
	skillDefaults := map[string]string{
		"code-review.md":  "# Code review\n\nCheck behavior, failure paths, tests, and security boundaries.\n",
		"debugging.md":    "# Debugging\n\nReproduce the reported failure, inspect evidence, and repair the smallest complete path.\n",
		"file-editing.md": "# File editing\n\nKeep changes scoped, preserve existing style, and verify the resulting artifact.\n",
	}
	for name, body := range skillDefaults {
		path := filepath.Join(skills, name)
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
				return err
			}
		}
	}
	path := filepath.Join(extensions, "opencode-pi.ts")
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(path, []byte(bundledOpenCodeExtension), 0o644); err != nil {
			return err
		}
	}
	return migrateLegacyRolePrompts(skills, agents)
}

func migrateLegacyRolePrompts(skills, agents string) error {
	for _, name := range []string{"builder.md", "reviewer.md", "runner.md", "scout.md", "sentinel.md"} {
		from := filepath.Join(skills, name)
		to := filepath.Join(agents, name)
		if _, err := os.Stat(from); err == nil {
			if _, err := os.Stat(to); errors.Is(err, os.ErrNotExist) {
				if err := os.Rename(from, to); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func listMarkdownEntries(dir, fallback string) ([]SkillEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	result := make([]SkillEntry, 0)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if ext != ".md" && ext != ".txt" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		info, err := entry.Info()
		if err != nil {
			continue
		}
		body, _ := os.ReadFile(path)
		preview := strings.TrimSpace(string(body))
		if len(preview) > 320 {
			preview = preview[:320]
		}
		name := strings.TrimSpace(strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())))
		if name == "" {
			name = fallback
		}
		result = append(result, SkillEntry{ID: path, Name: name, Path: path, Size: info.Size(), Preview: preview})
	}
	sort.Slice(result, func(i, j int) bool { return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name) })
	return result, nil
}

func listExtensionEntries(dir string) ([]SkillEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	result := make([]SkillEntry, 0)
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			for _, name := range []string{"index.ts", "index.js"} {
				candidate := filepath.Join(path, name)
				if info, err := os.Stat(candidate); err == nil {
					result = append(result, SkillEntry{ID: candidate, Name: entry.Name(), Path: candidate, Size: info.Size(), Preview: "Extension entrypoint"})
					break
				}
			}
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if ext != ".ts" && ext != ".js" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		result = append(result, SkillEntry{ID: path, Name: strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())), Path: path, Size: info.Size(), Preview: "Extension"})
	}
	sort.Slice(result, func(i, j int) bool { return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name) })
	return result, nil
}

func (a *App) ListSkills() ([]SkillEntry, error) {
	home, err := agentOfficeHomeDir()
	if err != nil {
		return nil, err
	}
	if _, err := a.AppPaths(); err != nil {
		return nil, err
	}
	return listMarkdownEntries(filepath.Join(home, "skills"), "Skill")
}
func (a *App) ListAgentFiles() ([]SkillEntry, error) {
	home, err := agentOfficeHomeDir()
	if err != nil {
		return nil, err
	}
	if _, err := a.AppPaths(); err != nil {
		return nil, err
	}
	return listMarkdownEntries(filepath.Join(home, "agents"), "Agent profile")
}
func (a *App) ListExtensions() ([]SkillEntry, error) {
	home, err := agentOfficeHomeDir()
	if err != nil {
		return nil, err
	}
	if _, err := a.AppPaths(); err != nil {
		return nil, err
	}
	return listExtensionEntries(filepath.Join(home, "extensions"))
}

func (a *App) ReadSkill(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Size() > 128*1024 {
		return "", fmt.Errorf("skill is larger than 128 KiB")
	}
	body, err := os.ReadFile(path)
	return string(body), err
}

func appStatePath() (string, error) {
	home, err := agentOfficeHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "app-state.json"), nil
}
func workspaceLogPath() (string, error) {
	home, err := agentOfficeHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "workspaces.jsonl"), nil
}
func providersPath() (string, error) {
	home, err := agentOfficeHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "providers.json"), nil
}

func (a *App) logAppEvent(event AppLogEvent) error {
	dir, err := runtimeLogDir()
	if err != nil {
		return err
	}
	path := filepath.Join(dir, "agentoffice-"+nowUTCDate()+".jsonl")
	record := map[string]any{"ts": nowMillis(), "level": event.Level, "target": event.Target, "message": event.Message, "fields": event.Fields}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(data, '\n'))
	return err
}

func (a *App) LoadAppState() (AppStateRecord, error) {
	path, err := appStatePath()
	if err != nil {
		return AppStateRecord{}, err
	}
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return AppStateRecord{}, nil
	}
	if err != nil {
		return AppStateRecord{}, err
	}
	var state AppStateRecord
	return state, json.Unmarshal(body, &state)
}

func (a *App) SaveLastWorkspace(id string) error {
	path, err := appStatePath()
	if err != nil {
		return err
	}
	if home, homeErr := agentOfficeHomeDir(); homeErr == nil {
		_ = os.MkdirAll(home, 0o755)
	}
	state := AppStateRecord{LastWorkspaceID: &id}
	body, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, body, 0o644)
}

func (a *App) ListWorkspaces() ([]WorkspaceRecord, error) {
	path, err := workspaceLogPath()
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return []WorkspaceRecord{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	latest := map[string]WorkspaceRecord{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var record WorkspaceRecord
		if json.Unmarshal(scanner.Bytes(), &record) == nil && record.ID != "" {
			latest[record.ID] = record
		}
	}
	result := make([]WorkspaceRecord, 0, len(latest))
	for _, record := range latest {
		record.IsSaved = true
		result = append(result, record)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].UpdatedAt > result[j].UpdatedAt })
	return result, scanner.Err()
}

func (a *App) SaveWorkspace(request SaveWorkspaceRequest) (WorkspaceRecord, error) {
	name := strings.TrimSpace(request.Name)
	cwd := strings.TrimSpace(request.CWD)
	if name == "" {
		return WorkspaceRecord{}, errors.New("Workspace name is required")
	}
	if cwd == "" {
		return WorkspaceRecord{}, errors.New("Workspace path is required")
	}
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		if err != nil {
			return WorkspaceRecord{}, err
		}
		return WorkspaceRecord{}, errors.New("Workspace path is not a directory")
	}
	id := ""
	if request.ID != nil {
		id = strings.TrimSpace(*request.ID)
	}
	if id == "" {
		id = randomID()
	}
	now := nowISO()
	created := now
	if records, err := a.ListWorkspaces(); err == nil {
		for _, record := range records {
			if record.ID == id {
				created = record.CreatedAt
				break
			}
		}
	}
	folders := append([]string(nil), request.Folders...)
	if len(folders) == 0 {
		folders = []string{cwd}
	}
	record := WorkspaceRecord{ID: id, Name: name, CWD: cwd, Folders: folders, CreatedAt: created, UpdatedAt: now, IsSaved: true, Color: request.Color}
	path, err := workspaceLogPath()
	if err != nil {
		return WorkspaceRecord{}, err
	}
	home, err := agentOfficeHomeDir()
	if err != nil {
		return WorkspaceRecord{}, err
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		return WorkspaceRecord{}, err
	}
	body, err := json.Marshal(record)
	if err != nil {
		return WorkspaceRecord{}, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return WorkspaceRecord{}, err
	}
	defer file.Close()
	if _, err := file.Write(append(body, '\n')); err != nil {
		return WorkspaceRecord{}, err
	}
	return record, nil
}

func (a *App) RemoveWorkspaceConfig(id string) ([]WorkspaceRecord, error) {
	records, err := a.ListWorkspaces()
	if err != nil {
		return nil, err
	}
	path, err := workspaceLogPath()
	if err != nil {
		return nil, err
	}
	remaining := make([]WorkspaceRecord, 0, len(records))
	for _, record := range records {
		if record.ID != id {
			remaining = append(remaining, record)
		}
	}
	home, err := agentOfficeHomeDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		return nil, err
	}
	file, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	for _, record := range remaining {
		body, _ := json.Marshal(record)
		_, _ = file.Write(append(body, '\n'))
	}
	_ = file.Close()
	return remaining, nil
}

func (a *App) ListDirectory(path string) ([]DirectoryEntry, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	result := make([]DirectoryEntry, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		result = append(result, DirectoryEntry{Name: entry.Name(), Path: filepath.Join(path, entry.Name()), IsDir: entry.IsDir(), Size: info.Size()})
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})
	return result, nil
}

func (a *App) ReadImageAttachment(path string) (ImageAttachmentPayload, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return ImageAttachmentPayload{}, err
	}
	if len(data) > 20*1024*1024 {
		return ImageAttachmentPayload{}, errors.New("image attachment is larger than 20 MiB")
	}
	mimeType := mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return ImageAttachmentPayload{Name: filepath.Base(path), MIMEType: mimeType, Data: base64.StdEncoding.EncodeToString(data)}, nil
}

func (a *App) ReadTextFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Size() > maxReadableFileBytes {
		return "", fmt.Errorf("file is larger than %d bytes", maxReadableFileBytes)
	}
	body, err := os.ReadFile(path)
	return string(body), err
}

func (a *App) WriteTextFile(path, contents string) error {
	previous, _ := os.ReadFile(path)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		return err
	}
	a.emit("file_operation", fileOperation(path, string(previous), contents, "File Studio"))
	return nil
}

func (a *App) CreateDirectoryPath(path string) error { return os.MkdirAll(path, 0o755) }
func (a *App) RenamePath(from, to string) error      { return os.Rename(from, to) }
func (a *App) DeletePath(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return os.RemoveAll(path)
	}
	return os.Remove(path)
}

func (a *App) RevealPath(path string) error {
	target := path
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		target = path
	}
	switch runtime.GOOS {
	case "windows":
		if _, err := exec.LookPath("explorer.exe"); err != nil {
			return err
		}
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return exec.Command("explorer.exe", "/select,", target).Start()
		}
		return exec.Command("explorer.exe", target).Start()
	case "darwin":
		return exec.Command("open", target).Start()
	default:
		return exec.Command("xdg-open", target).Start()
	}
}

func fileOperation(path, before, after, source string) FileOperationEvent {
	oldLines := strings.Split(strings.ReplaceAll(before, "\r\n", "\n"), "\n")
	newLines := strings.Split(strings.ReplaceAll(after, "\r\n", "\n"), "\n")
	prefix := 0
	for prefix < len(oldLines) && prefix < len(newLines) && oldLines[prefix] == newLines[prefix] {
		prefix++
	}
	oldSuffix, newSuffix := len(oldLines)-1, len(newLines)-1
	for oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] == newLines[newSuffix] {
		oldSuffix--
		newSuffix--
	}
	return FileOperationEvent{ID: randomID(), Path: path, Source: source, Status: "applied", StartLine: prefix + 1, RemovedLines: maxInt(0, oldSuffix-prefix+1), AddedLines: maxInt(0, newSuffix-prefix+1)}
}

func randomID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return fmt.Sprintf("%d", nowMillis())
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:])
}
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
func nowISO() string     { return timeNow().Format("2006-01-02T15:04:05.000Z07:00") }
func nowUTCDate() string { return timeNow().UTC().Format("2006-01-02") }
func timeNow() time.Time { return time.Now() }

//go:embed assets/opencode-pi.ts
var bundledOpenCodeExtension string
