//go:build windows

package office

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func llmUsageTrayCredentialPath(name string) (string, error) {
	if name == "" || filepath.Base(name) != name || strings.ContainsAny(name, `/\\`) {
		return "", fmt.Errorf("invalid credential name")
	}
	appData := strings.TrimSpace(os.Getenv("APPDATA"))
	if appData == "" {
		return "", fmt.Errorf("APPDATA is unavailable")
	}
	return filepath.Join(appData, "LLMUsageTray", name+".cred"), nil
}

func readLLMUsageTrayCredential(name string) ([]byte, error) {
	path, err := llmUsageTrayCredentialPath(name)
	if err != nil {
		return nil, err
	}
	encrypted, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(encrypted) == 0 {
		return nil, os.ErrNotExist
	}
	input := windows.DataBlob{Size: uint32(len(encrypted)), Data: &encrypted[0]}
	var output windows.DataBlob
	if err := windows.CryptUnprotectData(&input, nil, nil, 0, nil, 0, &output); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(output.Data))))
	if output.Data == nil || output.Size == 0 {
		return nil, os.ErrNotExist
	}
	return append([]byte(nil), unsafe.Slice(output.Data, int(output.Size))...), nil
}

func writeLLMUsageTrayCredential(name string, value []byte) error {
	path, err := llmUsageTrayCredentialPath(name)
	if err != nil {
		return err
	}
	if len(value) == 0 {
		return fmt.Errorf("empty credential")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	input := windows.DataBlob{Size: uint32(len(value)), Data: &value[0]}
	var output windows.DataBlob
	if err := windows.CryptProtectData(&input, nil, nil, 0, nil, 0, &output); err != nil {
		return err
	}
	defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(output.Data))))
	if output.Data == nil || output.Size == 0 {
		return fmt.Errorf("DPAPI returned an empty credential")
	}
	return os.WriteFile(path, unsafe.Slice(output.Data, int(output.Size)), 0o600)
}
