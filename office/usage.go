package office

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type ProviderUsageWindow struct {
	Available          bool    `json:"available"`
	UsedPercent        float64 `json:"usedPercent"`
	ResetAt            int64   `json:"resetAt"`
	LimitWindowSeconds int64   `json:"limitWindowSeconds"`
}

type ProviderUsage struct {
	ID            string              `json:"id"`
	Name          string              `json:"name"`
	Authenticated bool                `json:"authenticated"`
	AuthMethod    string              `json:"authMethod"`
	Source        string              `json:"source"`
	Status        string              `json:"status"`
	Error         string              `json:"error,omitempty"`
	UpdatedAt     int64               `json:"updatedAt"`
	Primary       ProviderUsageWindow `json:"primary"`
	Secondary     ProviderUsageWindow `json:"secondary"`
	Tertiary      ProviderUsageWindow `json:"tertiary"`
}

type usageProviderSpec struct {
	ID   string
	Name string
}

type usageAuth struct {
	Access    string
	Refresh   string
	APIKey    string
	AccountID string
	Expires   uint64
	Source    string
	External  bool
}

func usageProviderSpecs() []usageProviderSpec {
	return []usageProviderSpec{{ID: "openai", Name: "GPT"}, {ID: "anthropic", Name: "Claude"}, {ID: "glm", Name: "GLM"}}
}

func usageProviderKind(entry ProviderEntry) string {
	haystack := strings.ToLower(strings.Join([]string{entry.ID, entry.Name, entry.API, entry.BaseURL, entry.Source}, " "))
	switch {
	case strings.Contains(haystack, "glm"), strings.Contains(haystack, "z.ai"):
		return "glm"
	case strings.Contains(haystack, "anthropic"), strings.Contains(haystack, "claude"):
		return "anthropic"
	case isCodexProvider(entry.ID), isCodexProvider(entry.Name), isCodexProvider(entry.API), strings.Contains(haystack, "openai"):
		return "openai"
	default:
		return ""
	}
}

func usageProviderEntry(entries []ProviderEntry, kind string) *ProviderEntry {
	for index := range entries {
		if usageProviderKind(entries[index]) == kind {
			return &entries[index]
		}
	}
	return nil
}

func externalCredential(kind string) (map[string]any, bool) {
	value, err := loadLLMUsageTrayCredential(kind)
	if err != nil {
		return nil, false
	}
	return value, true
}

func normalizedExternalOAuthCredential(value map[string]any) map[string]any {
	credential := map[string]any{"type": "oauth", "refreshSupport": "available", "externalSource": "LLMUsageTray"}
	for _, key := range []string{"access", "refresh", "account_id", "accountId", "expires_ms", "expires"} {
		if item, ok := value[key]; ok {
			credential[key] = item
		}
	}
	if _, ok := credential["accountId"]; !ok {
		if accountID, ok := credential["account_id"]; ok {
			credential["accountId"] = accountID
		}
	}
	if _, ok := credential["expires"]; !ok {
		if expires, ok := credential["expires_ms"]; ok {
			credential["expires"] = expires
		}
	}
	return credential
}

func providerEntriesWithExternalAuth(entries []ProviderEntry) []ProviderEntry {
	result := append([]ProviderEntry(nil), entries...)
	for _, spec := range usageProviderSpecs() {
		external, ok := externalCredential(spec.ID)
		if !ok {
			continue
		}
		matched := false
		for index := range result {
			if usageProviderKind(result[index]) != spec.ID {
				continue
			}
			if spec.ID == "glm" {
				if result[index].APIKey == "" {
					result[index].APIKey = stringValue(external["api_key"])
					result[index].HasCredential = result[index].APIKey != ""
					if result[index].Source == "" {
						result[index].Source = "LLMUsageTray"
					}
					matched = result[index].APIKey != ""
				}
			} else if stringCredential(result[index].Credential, "access") != "" || stringCredential(result[index].Credential, "refresh") != "" {
				matched = true
			} else if len(result[index].Credential) == 0 && strings.TrimSpace(result[index].APIKey) == "" {
				result[index].Credential = normalizedExternalOAuthCredential(external)
				result[index].HasCredential = stringCredential(result[index].Credential, "access") != "" || stringCredential(result[index].Credential, "refresh") != ""
				if result[index].Source == "" {
					result[index].Source = "LLMUsageTray"
				}
				matched = result[index].HasCredential
			}
		}
		if matched {
			continue
		}
		if spec.ID == "glm" {
			key := stringValue(external["api_key"])
			if key == "" {
				continue
			}
			result = append(result, ProviderEntry{ID: "llm-usage-glm", Name: "GLM / Z.ai usage", API: "glm-usage", BaseURL: "https://api.z.ai/api/coding/paas/v4", APIKey: key, HasCredential: true, Source: "LLMUsageTray", Models: []ProviderModel{{ID: "glm-5", Name: "GLM-5"}}})
			continue
		}
		credential := normalizedExternalOAuthCredential(external)
		if spec.ID == "openai" {
			result = append(result, ProviderEntry{ID: "llm-usage-openai-codex", Name: "ChatGPT / OpenAI Codex OAuth", API: "openai-codex-responses", BaseURL: "https://chatgpt.com/backend-api", Credential: credential, HasCredential: true, Source: "LLMUsageTray", Models: defaultModels("openai-codex")})
		} else {
			result = append(result, ProviderEntry{ID: "llm-usage-anthropic", Name: "Claude / Anthropic OAuth", API: "anthropic-messages", BaseURL: "https://api.anthropic.com/v1", Credential: credential, HasCredential: true, Source: "LLMUsageTray", Models: defaultModels("anthropic")})
		}
	}
	return result
}

func usageAuthFor(kind string, entry *ProviderEntry) usageAuth {
	if entry != nil {
		access := stringCredential(entry.Credential, "access")
		refresh := stringCredential(entry.Credential, "refresh")
		if access != "" || refresh != "" {
			external := stringCredential(entry.Credential, "externalSource") == "LLMUsageTray"
			source := "AgentOffice"
			if external {
				source = "LLMUsageTray"
			}
			return usageAuth{Access: access, Refresh: refresh, AccountID: first(stringCredential(entry.Credential, "accountId"), stringCredential(entry.Credential, "account_id")), Expires: firstUint64(uint64Credential(entry.Credential, "expires"), uint64Credential(entry.Credential, "expires_ms")), Source: source, External: external}
		}
		if strings.TrimSpace(entry.APIKey) != "" {
			return usageAuth{APIKey: strings.TrimSpace(entry.APIKey), Source: "AgentOffice", External: false}
		}
	}
	if value, ok := externalCredential(kind); ok {
		if kind == "glm" {
			if key := strings.TrimSpace(stringValue(value["api_key"])); key != "" {
				return usageAuth{APIKey: key, Source: "LLMUsageTray", External: true}
			}
		} else {
			return usageAuth{Access: stringValue(value["access"]), Refresh: stringValue(value["refresh"]), AccountID: first(stringValue(value["account_id"]), stringValue(value["accountId"])), Expires: firstUint64(uint64Value(value["expires"]), uint64Value(value["expires_ms"])), Source: "LLMUsageTray", External: true}
		}
	}
	if kind == "glm" {
		return usageAuth{APIKey: strings.TrimSpace(os.Getenv("GLM_API_KEY")), Source: "GLM_API_KEY"}
	}
	if kind == "openai" {
		return usageAuth{APIKey: strings.TrimSpace(os.Getenv("OPENAI_API_KEY")), Source: "OPENAI_API_KEY"}
	}
	return usageAuth{APIKey: strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY")), Source: "ANTHROPIC_API_KEY"}
}

func firstUint64(values ...uint64) uint64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func uint64Value(value any) uint64 {
	switch typed := value.(type) {
	case float64:
		return uint64(typed)
	case json.Number:
		parsed, _ := strconv.ParseUint(string(typed), 10, 64)
		return parsed
	case string:
		parsed, _ := strconv.ParseUint(strings.TrimSpace(typed), 10, 64)
		return parsed
	default:
		return 0
	}
}

func (a *App) ProviderUsage() ([]ProviderUsage, error) {
	config, err := loadProviderConfig()
	if err != nil {
		return nil, err
	}
	config.Providers = providerEntriesWithExternalAuth(config.Providers)
	result := make([]ProviderUsage, 0, 3)
	for _, spec := range usageProviderSpecs() {
		entry := usageProviderEntry(config.Providers, spec.ID)
		auth := usageAuthFor(spec.ID, entry)
		row := ProviderUsage{ID: spec.ID, Name: spec.Name, Source: auth.Source, UpdatedAt: time.Now().UnixMilli()}
		row.Authenticated = auth.Access != "" || auth.Refresh != "" || auth.APIKey != ""
		switch {
		case auth.Access != "" || auth.Refresh != "":
			row.AuthMethod = "OAuth"
		case auth.APIKey != "":
			row.AuthMethod = "API key"
		default:
			row.AuthMethod = "Not connected"
		}
		if !row.Authenticated {
			row.Status = "not_connected"
			result = append(result, row)
			continue
		}
		if spec.ID != "glm" && row.AuthMethod != "OAuth" {
			row.Status = "oauth_required"
			row.Error = "Usage data requires the provider OAuth credential."
			result = append(result, row)
			continue
		}
		if err := refreshUsageAuth(spec.ID, &auth, entry); err != nil {
			row.Status = "error"
			row.Error = err.Error()
			result = append(result, row)
			continue
		}
		var fetchErr error
		switch spec.ID {
		case "openai":
			row.Primary, row.Secondary, fetchErr = fetchOpenAIUsage(auth)
		case "anthropic":
			row.Primary, row.Secondary, fetchErr = fetchAnthropicUsage(auth)
		case "glm":
			row.Primary, row.Secondary, row.Tertiary, fetchErr = fetchGLMUsage(auth)
		}
		if fetchErr != nil {
			row.Status = "error"
			row.Error = fetchErr.Error()
		} else {
			row.Status = "ready"
			row.UpdatedAt = time.Now().UnixMilli()
		}
		result = append(result, row)
	}
	return result, nil
}

func refreshUsageAuth(kind string, auth *usageAuth, entry *ProviderEntry) error {
	if auth.Access == "" && auth.Refresh == "" {
		return nil
	}
	if auth.Expires == 0 || auth.Expires > uint64(time.Now().UnixMilli())+60000 {
		return nil
	}
	if auth.Refresh == "" {
		return fmt.Errorf("%s OAuth credential expired; sign in again", kind)
	}
	var access, refresh string
	var expiresIn uint64
	var err error
	if kind == "anthropic" {
		access, refresh, expiresIn, err = refreshAnthropicAccessToken(auth.Refresh)
	} else {
		access, refresh, expiresIn, err = refreshOpenAIAccessToken(auth.Refresh)
	}
	if err != nil {
		return err
	}
	if access != "" {
		auth.Access = access
	}
	if refresh != "" {
		auth.Refresh = refresh
	}
	if expiresIn > 0 {
		auth.Expires = uint64(time.Now().UnixMilli()) + expiresIn*1000
	}
	if auth.External {
		value, err := loadLLMUsageTrayCredential(kind)
		if err != nil {
			value = map[string]any{}
		}
		value["access"] = auth.Access
		value["refresh"] = auth.Refresh
		value["expires_ms"] = auth.Expires
		value["account_id"] = auth.AccountID
		return saveLLMUsageTrayCredential(kind, value)
	}
	if entry == nil {
		return nil
	}
	if entry.Credential == nil {
		entry.Credential = map[string]any{}
	}
	entry.Credential["access"] = auth.Access
	entry.Credential["refresh"] = auth.Refresh
	entry.Credential["expires"] = auth.Expires
	if auth.AccountID != "" {
		entry.Credential["accountId"] = auth.AccountID
	}
	config, err := loadProviderConfig()
	if err != nil {
		return err
	}
	for index := range config.Providers {
		if config.Providers[index].ID == entry.ID {
			config.Providers[index] = *entry
			return saveProviderConfig(normalizeProviderConfig(config))
		}
	}
	return nil
}

func usageRequest(ctx context.Context, method, endpoint string, headers map[string]string) ([]byte, int, error) {
	request, err := http.NewRequestWithContext(ctx, method, endpoint, nil)
	if err != nil {
		return nil, 0, err
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := (&http.Client{Timeout: 20 * time.Second}).Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, response.StatusCode, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return body, response.StatusCode, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	return body, response.StatusCode, nil
}

func decodeUsageJSON(body []byte) (any, error) {
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

func usageObject(value any) map[string]any {
	object, _ := value.(map[string]any)
	return object
}

func usageNumber(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case json.Number:
		parsed, _ := typed.Float64()
		return parsed
	case string:
		parsed, _ := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed
	default:
		return 0
	}
}

func usageTimestamp(value any) int64 {
	if value == nil {
		return 0
	}
	if number := usageNumber(value); number > 0 {
		if number > 100000000000 {
			return int64(number / 1000)
		}
		return int64(number)
	}
	text := strings.TrimSpace(stringValue(value))
	if text == "" {
		return 0
	}
	if parsed, err := time.Parse(time.RFC3339Nano, text); err == nil {
		return parsed.Unix()
	}
	return 0
}

func usageWindowFromMap(value map[string]any, percentageKey string) ProviderUsageWindow {
	if value == nil {
		return ProviderUsageWindow{}
	}
	window := ProviderUsageWindow{Available: true, UsedPercent: usageNumber(value[percentageKey])}
	if window.UsedPercent < 0 {
		window.UsedPercent = 0
	}
	if window.UsedPercent > 100 {
		window.UsedPercent = 100
	}
	window.ResetAt = usageTimestamp(value["reset_at"])
	if window.ResetAt == 0 {
		window.ResetAt = usageTimestamp(value["resets_at"])
	}
	window.LimitWindowSeconds = int64(usageNumber(value["limit_window_seconds"]))
	if window.LimitWindowSeconds == 0 {
		window.LimitWindowSeconds = int64(usageNumber(value["window_minutes"]) * 60)
	}
	return window
}

func firstUsageMap(parent map[string]any, keys ...string) map[string]any {
	for _, key := range keys {
		if value := usageObject(parent[key]); value != nil {
			return value
		}
	}
	return nil
}

func fetchOpenAIUsage(auth usageAuth) (ProviderUsageWindow, ProviderUsageWindow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	headers := map[string]string{"Authorization": "Bearer " + auth.Access, "Accept": "application/json"}
	if auth.AccountID != "" {
		headers["ChatGPT-Account-Id"] = auth.AccountID
	}
	body, _, err := usageRequest(ctx, http.MethodGet, "https://chatgpt.com/backend-api/wham/usage", headers)
	if err != nil {
		return ProviderUsageWindow{}, ProviderUsageWindow{}, err
	}
	value, err := decodeUsageJSON(body)
	if err != nil {
		return ProviderUsageWindow{}, ProviderUsageWindow{}, err
	}
	root := usageObject(value)
	rateLimit := usageObject(root["rate_limit"])
	if rateLimit == nil {
		return ProviderUsageWindow{}, ProviderUsageWindow{}, fmt.Errorf("usage response did not include rate_limit")
	}
	return usageWindowFromMap(firstUsageMap(rateLimit, "primary_window", "primary"), "used_percent"), usageWindowFromMap(firstUsageMap(rateLimit, "secondary_window", "secondary"), "used_percent"), nil
}

func fetchAnthropicUsage(auth usageAuth) (ProviderUsageWindow, ProviderUsageWindow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	body, _, err := usageRequest(ctx, http.MethodGet, "https://api.anthropic.com/api/oauth/usage", map[string]string{"Authorization": "Bearer " + auth.Access, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude/1.0"})
	if err != nil {
		return ProviderUsageWindow{}, ProviderUsageWindow{}, err
	}
	value, err := decodeUsageJSON(body)
	if err != nil {
		return ProviderUsageWindow{}, ProviderUsageWindow{}, err
	}
	root := usageObject(value)
	return usageWindowFromMap(usageObject(root["five_hour"]), "utilization"), usageWindowFromMap(usageObject(root["seven_day"]), "utilization"), nil
}

func findGLMWindow(value any, typeName string, unit int) ProviderUsageWindow {
	switch typed := value.(type) {
	case map[string]any:
		if stringValue(typed["type"]) == typeName && (unit == 0 || int(usageNumber(typed["unit"])) == unit) {
			window := usageWindowFromMap(typed, "percentage")
			window.ResetAt = usageTimestamp(typed["nextResetTime"])
			return window
		}
		for _, child := range typed {
			if result := findGLMWindow(child, typeName, unit); result.Available {
				return result
			}
		}
	case []any:
		for _, child := range typed {
			if result := findGLMWindow(child, typeName, unit); result.Available {
				return result
			}
		}
	}
	return ProviderUsageWindow{}
}

func fetchGLMUsage(auth usageAuth) (ProviderUsageWindow, ProviderUsageWindow, ProviderUsageWindow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	body, _, err := usageRequest(ctx, http.MethodGet, "https://api.z.ai/api/monitor/usage/quota/limit", map[string]string{"Authorization": auth.APIKey, "Accept-Language": "en-US", "Content-Type": "application/json"})
	if err != nil {
		return ProviderUsageWindow{}, ProviderUsageWindow{}, ProviderUsageWindow{}, err
	}
	value, err := decodeUsageJSON(body)
	if err != nil {
		return ProviderUsageWindow{}, ProviderUsageWindow{}, ProviderUsageWindow{}, err
	}
	root := usageObject(value)
	if code := int(usageNumber(root["code"])); code != 0 && code != 200 {
		return ProviderUsageWindow{}, ProviderUsageWindow{}, ProviderUsageWindow{}, fmt.Errorf("GLM quota API returned code %d", code)
	}
	return findGLMWindow(value, "TOKENS_LIMIT", 3), findGLMWindow(value, "TOKENS_LIMIT", 6), findGLMWindow(value, "TIME_LIMIT", 0), nil
}
