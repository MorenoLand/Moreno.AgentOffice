package office

import (
	"encoding/json"
	"fmt"
)

func loadLLMUsageTrayCredential(name string) (map[string]any, error) {
	raw, err := readLLMUsageTrayCredential(name)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("invalid LLMUsageTray credential: %w", err)
	}
	return value, nil
}

func saveLLMUsageTrayCredential(name string, value map[string]any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writeLLMUsageTrayCredential(name, raw)
}
