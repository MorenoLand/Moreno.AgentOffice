package office

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func (a *App) DetectAgentProfiles() ([]AgentProfile, error) {
	root := a.workspace
	if root == "" {
		var err error
		if root, err = os.Getwd(); err != nil {
			return nil, err
		}
	}
	profiles := make([]AgentProfile, 0)
	add := func(profile AgentProfile) {
		profile.CWD = root
		if profile.Env == nil {
			profile.Env = map[string]string{}
		}
		profiles = append(profiles, profile)
	}
	if local := strings.TrimSpace(os.Getenv("AGENTOFFICE_PI_MONO_DIR")); local != "" && exists(filepath.Join(local, "packages", "coding-agent", "package.json")) {
		if npm, err := exec.LookPath("npm"); err == nil {
			add(AgentProfile{ID: "pi-mono-local", Name: "Pi Mono", Role: "Builder", Command: npm, Args: []string{"--prefix", local, "exec", "pi", "--"}, Accent: "#a178ff", Description: "Local Pi Mono coding agent.", DetectedPath: npm})
		}
	}
	if pi, err := exec.LookPath("pi"); err == nil {
		add(AgentProfile{ID: "pi-installed", Name: "Pi", Role: "Builder", Command: pi, Accent: "#a178ff", Description: "Detected Pi CLI.", DetectedPath: pi})
	}
	candidates := []struct{ id, name, role, command, accent, description string }{{"codex", "Codex", "Builder", "codex", "#71b7ff", "Detected Codex CLI."}, {"claude", "Claude", "Builder", "claude", "#d49a6a", "Detected Claude CLI."}, {"opencode", "OpenCode", "Builder", "opencode", "#72d6c9", "Detected OpenCode CLI."}}
	for _, candidate := range candidates {
		if path, err := exec.LookPath(candidate.command); err == nil {
			profile := AgentProfile{ID: candidate.id, Name: candidate.name, Role: candidate.role, Command: path, Accent: candidate.accent, Description: candidate.description, DetectedPath: path}
			if candidate.id == "codex" { profile.Args = []string{"resume", "--all"} }
			add(profile)
		}
	}
	if runtime.GOOS == "windows" {
		if powershell, err := exec.LookPath("pwsh"); err == nil {
			add(AgentProfile{ID: "system-shell", Name: "PowerShell", Role: "Runner", Command: powershell, Args: []string{"-NoLogo", "-NoExit"}, Accent: "#4da6ff", Description: "PowerShell session.", DetectedPath: powershell})
		} else if powershell, err := exec.LookPath("powershell.exe"); err == nil {
			add(AgentProfile{ID: "system-shell", Name: "PowerShell", Role: "Runner", Command: powershell, Args: []string{"-NoLogo", "-NoExit"}, Accent: "#4da6ff", Description: "PowerShell session.", DetectedPath: powershell})
		}
		if command, err := exec.LookPath("cmd.exe"); err == nil {
			add(AgentProfile{ID: "windows-cmd", Name: "Command Prompt", Role: "Runner", Command: command, Args: []string{"/d"}, Accent: "#e7793f", Description: "Windows command prompt session.", DetectedPath: command})
		}
	} else {
		for _, candidate := range []struct{ id, name, command, accent string }{{"bash", "Bash", "bash", "#8ccf7e"}, {"zsh", "Zsh", "zsh", "#77a7ff"}, {"fish", "Fish", "fish", "#72d6c9"}, {"sh", "POSIX Shell", "sh", "#e7793f"}} {
			if path, err := exec.LookPath(candidate.command); err == nil {
				add(AgentProfile{ID: candidate.id, Name: candidate.name, Role: "Runner", Command: path, Accent: candidate.accent, Description: candidate.name + " session.", DetectedPath: path})
			}
		}
	}
	return profiles, nil
}
