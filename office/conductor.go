package office

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const conductorSystemPrompt = "You are the Conductor of a virtual office. Every AI agent in the office is a worker sitting at a desk, and you coordinate them. Never answer generic coding questions with generic advice when an office action would do; act on the office instead. Available actions: roster, hire <profile-id> [display name], send <worker> <message>, stop <worker>, park <worker>, unpark <worker>, send_home <worker>, shell. File actions available: read_open_file, read_file, edit_open_file with complete replacement content, write_file, apply_patch. When the user asks to hire, spawn, start, or add a worker and a reasonable profile exists, emit a fenced agentoffice-action block instead of telling the user what to type. Example: ```agentoffice-action {\"type\":\"hire\",\"profile\":\"pi-installed\",\"name\":\"Builder\",\"role\":\"Builder\"} ```. Use gh pr view 2 --comments and similar gh commands for risky changes so the user gets a short summary with concrete suggestions. Never claim execution until the office reports the result. Use workspace, file, roster, and profile context when provided."

func (a *App) ConductorAbort() error {
	a.conductor.Lock()
	cancel := a.conductorCancel
	a.conductor.Unlock()
	if cancel != nil {
		cancel()
	}
	return nil
}

func (a *App) conductorChat(request ConductorChatRequest) (ConductorChatResult, error) {
	config, err := loadProviderConfig()
	if err != nil {
		return ConductorChatResult{}, err
	}
	config.Providers = providerEntriesWithExternalAuth(config.Providers)
	providerIndex := -1
	for index := range config.Providers {
		if config.Providers[index].ID == request.ProviderID {
			providerIndex = index
			break
		}
	}
	if providerIndex < 0 {
		return conductorError(fmt.Sprintf("Provider '%s' not found", request.ProviderID)), nil
	}
	provider := config.Providers[providerIndex]
	bearer, refreshError := a.providerBearer(&provider)
	if refreshError != nil {
		return conductorError(refreshError.Error()), nil
	}
	if bearer == "" && provider.API != "opencode-pi-free" {
		return conductorError("Provider has no API key or OAuth access token configured."), nil
	}
	if !supportedConductorAPI(provider.API) {
		return conductorError(fmt.Sprintf("Provider API '%s' is not supported by native chat yet. Select an OpenAI-compatible provider.", provider.API)), nil
	}
	model := "gpt-4o"
	if request.ModelID != nil && strings.TrimSpace(*request.ModelID) != "" {
		model = strings.TrimSpace(*request.ModelID)
	} else if len(provider.Models) > 0 {
		model = provider.Models[0].ID
	}
	if hasImageContent(request.History) && !modelSupportsVision(model) {
		return conductorError(fmt.Sprintf("Selected model '%s' has unknown vision support. Remove image attachments or select a vision-capable model.", model)), nil
	}
	timeout := uint64(180000)
	if request.TimeoutMS != nil {
		timeout = *request.TimeoutMS
	}
	if timeout < 30000 {
		timeout = 30000
	}
	if timeout > 600000 {
		timeout = 600000
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Millisecond)
	a.conductor.Lock()
	a.conductorCancel = cancel
	a.conductor.Unlock()
	defer func() {
		cancel()
		a.conductor.Lock()
		a.conductorCancel = nil
		a.conductor.Unlock()
	}()

	messages := make([]ChatMessage, 0, len(request.History)+1)
	messages = append(messages, ChatMessage{Role: "system", Content: conductorSystemPrompt})
	messages = append(messages, request.History...)
	body, err := conductorRequestBody(provider.API, model, messages, request.History)
	if err != nil {
		return conductorError(err.Error()), nil
	}
	url := conductorURL(provider.API, provider.BaseURL)
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return conductorError(err.Error()), nil
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	if provider.API == "anthropic-messages" {
		if stringCredential(provider.Credential, "access") != "" {
			httpRequest.Header.Set("Authorization", "Bearer "+bearer)
			httpRequest.Header.Set("anthropic-beta", "claude-code-20250219,oauth-2025-04-20")
			httpRequest.Header.Set("User-Agent", "claude-cli/2.1.75")
			httpRequest.Header.Set("x-app", "cli")
		} else {
			httpRequest.Header.Set("x-api-key", bearer)
			httpRequest.Header.Set("anthropic-version", "2023-06-01")
		}
	} else if provider.API != "opencode-pi-free" {
		httpRequest.Header.Set("Authorization", "Bearer "+bearer)
	}
	if accountID := stringCredential(provider.Credential, "accountId"); accountID != "" {
		httpRequest.Header.Set("chatgpt-account-id", accountID)
	}
	if provider.API == "openai-codex-responses" {
		sessionID := randomID()
		httpRequest.Header.Set("OpenAI-Beta", "responses=experimental")
		httpRequest.Header.Set("Accept", "text/event-stream")
		httpRequest.Header.Set("originator", "pi")
		httpRequest.Header.Set("User-Agent", "pi (windows)")
		httpRequest.Header.Set("session-id", sessionID)
		httpRequest.Header.Set("x-client-request-id", sessionID)
		if httpRequest.Header.Get("chatgpt-account-id") == "" {
			if accountID := openAICodexAccountID(bearer); accountID != "" {
				httpRequest.Header.Set("chatgpt-account-id", accountID)
			}
		}
	}
	response, err := http.DefaultClient.Do(httpRequest)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return ConductorChatResult{Cancelled: true}, nil
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return conductorError(fmt.Sprintf("Request timed out (%ds).", timeout/1000)), nil
		}
		return conductorError(requestErrorMessage(err)), nil
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return conductorError("Failed to read response body: " + err.Error()), nil
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return ConductorChatResult{Cancelled: true}, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return conductorError(fmt.Sprintf("%s", providerErrorMessage(response.StatusCode, responseBody))), nil
	}
	text, err := conductorResponseText(provider.API, responseBody)
	if err != nil {
		return conductorError(err.Error()), nil
	}
	return ConductorChatResult{AssistantText: text}, nil
}

func (a *App) providerBearer(provider *ProviderEntry) (string, error) {
	if provider.API != "openai-codex-responses" && provider.API != "anthropic-messages" {
		return provider.APIKey, nil
	}
	access := stringCredential(provider.Credential, "access")
	expires := uint64Credential(provider.Credential, "expires")
	if expires > 0 && expires <= uint64(time.Now().UnixMilli())+60000 {
		refresh := stringCredential(provider.Credential, "refresh")
		if refresh != "" {
			var accessNext, refreshNext string
			var expiresIn uint64
			var err error
			if provider.API == "anthropic-messages" {
				accessNext, refreshNext, expiresIn, err = refreshAnthropicAccessToken(refresh)
			} else {
				accessNext, refreshNext, expiresIn, err = refreshOpenAIAccessToken(refresh)
			}
			if err != nil {
				return "", err
			}
			if accessNext != "" {
				access = accessNext
			}
			if refreshNext != "" {
				provider.Credential["refresh"] = refreshNext
			}
			if expiresIn > 0 {
				provider.Credential["expires"] = uint64(time.Now().UnixMilli()) + expiresIn*1000
			}
			provider.Credential["access"] = access
			if stringCredential(provider.Credential, "externalSource") == "LLMUsageTray" {
				kind := "openai"
				if provider.API == "anthropic-messages" {
					kind = "anthropic"
				}
				if value, err := loadLLMUsageTrayCredential(kind); err == nil {
					value["access"] = access
					value["refresh"] = stringCredential(provider.Credential, "refresh")
					value["expires_ms"] = uint64Credential(provider.Credential, "expires")
					if accountID := stringCredential(provider.Credential, "accountId"); accountID != "" {
						value["account_id"] = accountID
					}
					_ = saveLLMUsageTrayCredential(kind, value)
				}
			} else if config, err := loadProviderConfig(); err == nil {
				for index := range config.Providers {
					if config.Providers[index].ID == provider.ID {
						config.Providers[index] = *provider
					}
				}
				_ = saveProviderConfig(normalizeProviderConfig(config))
			}
		}
	}
	return access, nil
}

func conductorError(message string) ConductorChatResult {
	return ConductorChatResult{Error: &message}
}

func supportedConductorAPI(api string) bool {
	switch api {
	case "openai-completions", "openai-compatible", "openai-chat-completions", "openai-codex-responses", "anthropic-messages", "opencode-pi-free":
		return true
	default:
		return false
	}
}

func conductorURL(api, baseURL string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if api == "openai-codex-responses" {
		if base == "" {
			base = "https://chatgpt.com/backend-api"
		}
		if strings.HasSuffix(base, "/codex/responses") {
			return base
		}
		if strings.HasSuffix(base, "/codex") {
			return base + "/responses"
		}
		return base + "/codex/responses"
	}
	if api == "anthropic-messages" {
		if strings.HasSuffix(base, "/messages") {
			return base
		}
		if base == "" {
			base = "https://api.anthropic.com/v1"
		}
		return base + "/messages"
	}
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	return base + "/chat/completions"
}

func conductorRequestBody(api, model string, messages []ChatMessage, history []ChatMessage) ([]byte, error) {
	if api == "openai-codex-responses" {
		return json.Marshal(map[string]any{"model": model, "store": false, "stream": true, "instructions": conductorSystemPrompt, "input": history, "tools": []any{}, "tool_choice": "auto", "parallel_tool_calls": true})
	}
	if api == "anthropic-messages" {
		return json.Marshal(map[string]any{"model": model, "max_tokens": 4096, "stream": false, "system": conductorSystemPrompt, "messages": history})
	}
	return json.Marshal(map[string]any{"model": model, "messages": messages, "stream": false})
}

func hasImageContent(messages []ChatMessage) bool {
	for _, message := range messages {
		data, err := json.Marshal(message.Content)
		if err == nil && strings.Contains(string(data), `"type":"image_url"`) {
			return true
		}
	}
	return false
}

func modelSupportsVision(model string) bool {
	model = strings.ToLower(model)
	return strings.Contains(model, "vision") || strings.Contains(model, "gpt-4o") || strings.Contains(model, "gpt-4.1") || strings.Contains(model, "gemini") || strings.Contains(model, "qwen-vl") || strings.Contains(model, "glm-4v") || strings.Contains(model, "vl")
}

func conductorResponseText(api string, body []byte) (string, error) {
	if api == "openai-codex-responses" {
		if text := collectCodexSSEText(string(body)); text != "" {
			return text, nil
		}
		var value any
		if err := json.Unmarshal(body, &value); err != nil {
			return "", fmt.Errorf("Parse error: %w", err)
		}
		if text := extractCodexResponseText(value); text != "" {
			return text, nil
		}
		if message, ok := value.(map[string]any)["message"].(string); ok {
			return message, nil
		}
		return "", nil
	}
	if api == "anthropic-messages" {
		var response struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.Unmarshal(body, &response); err != nil {
			return "", fmt.Errorf("Parse error: %w", err)
		}
		var output strings.Builder
		for _, block := range response.Content {
			output.WriteString(block.Text)
		}
		return output.String(), nil
	}
	var response struct {
		Choices []struct {
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return "", fmt.Errorf("Parse error: %w", err)
	}
	if len(response.Choices) == 0 {
		return "", nil
	}
	return contentText(response.Choices[0].Message.Content), nil
}

func collectCodexSSEText(value string) string {
	var output strings.Builder
	for _, line := range strings.Split(value, "\n") {
		data, ok := strings.CutPrefix(strings.TrimSpace(line), "data:")
		if !ok || strings.TrimSpace(data) == "" || strings.TrimSpace(data) == "[DONE]" {
			continue
		}
		var event any
		if json.Unmarshal([]byte(strings.TrimSpace(data)), &event) != nil {
			continue
		}
		object, ok := event.(map[string]any)
		if !ok {
			continue
		}
		if delta, ok := object["delta"].(string); ok {
			output.WriteString(delta)
		}
		if text, ok := object["text"].(string); ok && strings.Contains(stringValue(object["type"]), "output_text") {
			output.WriteString(text)
		}
		if response, ok := object["response"]; ok {
			if text := extractCodexResponseText(response); text != "" {
				output.Reset()
				output.WriteString(text)
			}
		}
	}
	return output.String()
}

func extractCodexResponseText(value any) string {
	object, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	if text, ok := object["output_text"].(string); ok {
		return text
	}
	items, ok := object["output"].([]any)
	if !ok {
		return ""
	}
	var output strings.Builder
	for _, item := range items {
		itemObject, ok := item.(map[string]any)
		if !ok {
			continue
		}
		parts, ok := itemObject["content"].([]any)
		if !ok {
			continue
		}
		for _, part := range parts {
			partObject, ok := part.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := partObject["text"].(string); ok {
				output.WriteString(text)
			} else if text, ok := partObject["output_text"].(string); ok {
				output.WriteString(text)
			}
		}
	}
	return output.String()
}

func contentText(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	parts, ok := content.([]any)
	if !ok {
		return ""
	}
	var output strings.Builder
	for _, part := range parts {
		object, ok := part.(map[string]any)
		if !ok {
			continue
		}
		if text, ok := object["text"].(string); ok {
			output.WriteString(text)
		}
	}
	return output.String()
}

func providerErrorMessage(status int, body []byte) string {
	var value struct {
		Error   json.RawMessage `json:"error"`
		Message string          `json:"message"`
	}
	if json.Unmarshal(body, &value) == nil {
		var nested struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(value.Error, &nested) == nil && nested.Message != "" {
			return nested.Message
		}
		if value.Message != "" {
			return value.Message
		}
	}
	message := strings.TrimSpace(string(body))
	if len(message) > 500 {
		message = message[:500]
	}
	if message == "" {
		return fmt.Sprintf("HTTP %d", status)
	}
	return message
}

func requestErrorMessage(err error) string {
	message := err.Error()
	if strings.Contains(strings.ToLower(message), "connection") {
		return "Connection failed: " + message
	}
	return "Request error: " + message
}

func stringCredential(values map[string]any, key string) string {
	value, ok := values[key]
	if !ok {
		return ""
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}

func uint64Credential(values map[string]any, key string) uint64 {
	value, ok := values[key]
	if !ok {
		return 0
	}
	switch typed := value.(type) {
	case float64:
		return uint64(typed)
	case uint64:
		return typed
	case int64:
		return uint64(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return uint64(parsed)
	case string:
		var parsed uint64
		_, _ = fmt.Sscan(typed, &parsed)
		return parsed
	default:
		return 0
	}
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}
