//go:build windows

package office

import (
	"errors"
	"os/exec"
	"syscall"
)

func isPtyClosed(err error) bool { return errors.Is(err, syscall.ERROR_BROKEN_PIPE) }
func hidePtyWindow(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
