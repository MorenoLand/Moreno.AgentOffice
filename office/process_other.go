//go:build !windows

package office

import "os/exec"

func isPtyClosed(err error) bool { return false }
func hidePtyWindow(cmd *exec.Cmd) {}
