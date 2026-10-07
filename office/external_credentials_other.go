//go:build !windows

package office

import "errors"

func readLLMUsageTrayCredential(string) ([]byte, error) {
	return nil, errors.New("LLMUsageTray credential sharing is only available on Windows")
}

func writeLLMUsageTrayCredential(string, []byte) error {
	return errors.New("LLMUsageTray credential sharing is only available on Windows")
}
