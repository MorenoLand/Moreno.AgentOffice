package office

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	openAICodexClientID         = "app_EMoamEEZ73f0CkXaXp7hrann"
	openAIDeviceUserCodeURL     = "https://auth.openai.com/api/accounts/deviceauth/usercode"
	openAIDeviceTokenURL        = "https://auth.openai.com/api/accounts/deviceauth/token"
	openAITokenURL              = "https://auth.openai.com/oauth/token"
	openAIDeviceVerificationURI = "https://auth.openai.com/codex/device"
	openAIDeviceRedirectURI     = "https://auth.openai.com/deviceauth/callback"
	openAIAuthorizeURL          = "https://auth.openai.com/oauth/authorize"
	openAIBrowserRedirectURI    = "http://localhost:1455/auth/callback"
	openAIScope                 = "openid profile email offline_access"
	anthropicOAuthClientID      = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	anthropicOAuthAuthorizeURL  = "https://claude.ai/oauth/authorize"
	anthropicOAuthTokenURL      = "https://platform.claude.com/v1/oauth/token"
	anthropicOAuthRedirectURI   = "http://localhost:53692/callback"
	anthropicOAuthScope         = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
)

type piAuthCredential struct {
	Type      string `json:"type"`
	Key       string `json:"key"`
	Access    string `json:"access"`
	Refresh   string `json:"refresh"`
	Expires   uint64 `json:"expires"`
	AccountID string `json:"accountId"`
}
type piModelDef struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	API     string `json:"api"`
	BaseURL string `json:"baseUrl"`
}
type piProviderConfig struct {
	Name    string       `json:"name"`
	BaseURL string       `json:"baseUrl"`
	APIKey  string       `json:"apiKey"`
	API     string       `json:"api"`
	Models  []piModelDef `json:"models"`
}

func loadProviderConfig() (ProviderConfig, error) {
	path, err := providersPath()
	if err != nil {
		return ProviderConfig{}, err
	}
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return ProviderConfig{Providers: []ProviderEntry{}}, nil
	}
	if err != nil {
		return ProviderConfig{}, err
	}
	var config ProviderConfig
	if err := json.Unmarshal(body, &config); err != nil {
		return ProviderConfig{}, err
	}
	config = normalizeProviderConfig(config)
	_ = saveProviderConfig(config)
	return config, nil
}

func saveProviderConfig(config ProviderConfig) error {
	path, err := providersPath()
	if err != nil {
		return err
	}
	home, err := agentOfficeHomeDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		return err
	}
	body, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, body, 0o600)
}

func normalizeProviderConfig(config ProviderConfig) ProviderConfig {
	grouped := make([]ProviderEntry, 0, len(config.Providers))
	for _, entry := range config.Providers {
		if len(entry.Models) == 0 && strings.TrimSpace(entry.ModelID) != "" {
			name := entry.ModelName
			if strings.TrimSpace(name) == "" {
				name = entry.ModelID
			}
			entry.Models = []ProviderModel{{ID: entry.ModelID, Name: name}}
		}
		found := -1
		for index := range grouped {
			if grouped[index].API == entry.API && grouped[index].BaseURL == entry.BaseURL && grouped[index].APIKey == entry.APIKey && grouped[index].Source == entry.Source && grouped[index].Name == entry.Name {
				found = index
				break
			}
		}
		if found < 0 {
			entry.ModelID = ""
			entry.ModelName = ""
			entry.HasCredential = hasProviderCredential(entry)
			grouped = append(grouped, entry)
			continue
		}
		for _, model := range entry.Models {
			if !containsModel(grouped[found].Models, model.ID) {
				grouped[found].Models = append(grouped[found].Models, model)
			}
		}
		if grouped[found].APIKey == "" {
			grouped[found].APIKey = entry.APIKey
		}
		if len(grouped[found].Credential) == 0 {
			grouped[found].Credential = entry.Credential
		}
		grouped[found].HasCredential = hasProviderCredential(grouped[found])
	}
	for index := range grouped {
		sort.Slice(grouped[index].Models, func(i, j int) bool { return grouped[index].Models[i].Name < grouped[index].Models[j].Name })
		grouped[index].HasCredential = hasProviderCredential(grouped[index])
	}
	config.Providers = grouped
	return config
}

func hasProviderCredential(entry ProviderEntry) bool {
	return strings.TrimSpace(entry.APIKey) != "" || len(entry.Credential) > 0
}
func containsModel(models []ProviderModel, id string) bool {
	for _, model := range models {
		if model.ID == id {
			return true
		}
	}
	return false
}

func publicProvider(entry ProviderEntry) ProviderEntry {
	entry.APIKey = ""
	entry.Credential = nil
	return entry
}

func opencodeFreeModels() []ProviderModel {
	ids := []string{"big-pickle", "deepseek-v4-flash-free", "minimax-m2.5-free", "nemotron-3-super-free", "ring-2.6-1t-free"}
	result := make([]ProviderModel, 0, len(ids))
	for _, id := range ids {
		result = append(result, ProviderModel{ID: id, Name: id})
	}
	return result
}
func bundledOpenCodeProvider() ProviderEntry {
	return ProviderEntry{ID: "opencode-pi-free", Name: "OpenCode Zen Free", API: "opencode-pi-free", BaseURL: "https://opencode.ai/zen/v1", APIKey: "sk-noop", HasCredential: true, Source: "bundled-extension:opencode-pi", Models: opencodeFreeModels()}
}

func ensureBundledProvider() error {
	config, err := loadProviderConfig()
	if err != nil {
		return err
	}
	for _, entry := range config.Providers {
		if entry.ID == "opencode-pi-free" {
			return nil
		}
	}
	config.Providers = append(config.Providers, bundledOpenCodeProvider())
	return saveProviderConfig(normalizeProviderConfig(config))
}

func (a *App) ListProviders() ([]ProviderEntry, error) {
	if err := ensureBundledProvider(); err != nil {
		return nil, err
	}
	config, err := loadProviderConfig()
	if err != nil {
		return nil, err
	}
	config.Providers = providerEntriesWithExternalAuth(config.Providers)
	result := make([]ProviderEntry, 0, len(config.Providers))
	for _, entry := range config.Providers {
		result = append(result, publicProvider(entry))
	}
	return result, nil
}

func (a *App) AddProvider(entry ProviderEntry) error {
	config, err := loadProviderConfig()
	if err != nil {
		return err
	}
	filtered := config.Providers[:0]
	for _, existing := range config.Providers {
		if existing.ID != entry.ID {
			filtered = append(filtered, existing)
		}
	}
	config.Providers = filtered
	config.Providers = append(config.Providers, entry)
	config = normalizeProviderConfig(config)
	return saveProviderConfig(config)
}

func (a *App) RemoveProvider(id string) error {
	config, err := loadProviderConfig()
	if err != nil {
		return err
	}
	result := config.Providers[:0]
	for _, entry := range config.Providers {
		if entry.ID != id {
			result = append(result, entry)
		}
	}
	config.Providers = result
	return saveProviderConfig(config)
}

func (a *App) DetectImportSources() ([]ImportSource, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	piDir := filepath.Join(home, ".pi", "agent")
	piAvailable := exists(filepath.Join(piDir, "auth.json")) || exists(filepath.Join(piDir, "models.json"))
	if local := strings.TrimSpace(os.Getenv("AGENTOFFICE_PI_MONO_DIR")); local != "" {
		piAvailable = piAvailable || exists(filepath.Join(local, "packages", "coding-agent", "package.json"))
	}
	codexAvailable := os.Getenv("OPENAI_API_KEY") != "" || exists(filepath.Join(home, ".codex", "config.json"))
	claudeAvailable := os.Getenv("ANTHROPIC_API_KEY") != "" || exists(filepath.Join(home, ".claude", "settings.json"))
	return []ImportSource{{ID: "pi-mono", Name: "Pi Mono", Available: piAvailable, Reason: availabilityReason(piAvailable, "No Pi Mono config found.")}, {ID: "openai", Name: "Codex / OpenAI", Available: codexAvailable, Reason: availabilityReason(codexAvailable, "No OPENAI_API_KEY or Codex config found.")}, {ID: "anthropic", Name: "Claude / Anthropic", Available: claudeAvailable, Reason: availabilityReason(claudeAvailable, "No ANTHROPIC_API_KEY or Claude config found.")}}, nil
}

func availabilityReason(ok bool, reason string) string {
	if ok {
		return ""
	}
	return reason
}
func exists(path string) bool { _, err := os.Stat(path); return err == nil }

func (a *App) ImportProviders(sourceID string) (ImportResult, error) {
	if sourceID == "openai" {
		return a.importEnvironmentProvider("openai", "OpenAI", "openai-completions", os.Getenv("OPENAI_API_KEY"), "https://api.openai.com/v1", []ProviderModel{{ID: "gpt-4o", Name: "GPT-4o"}})
	}
	if sourceID == "anthropic" {
		return a.importEnvironmentProvider("anthropic", "Anthropic", "anthropic-messages", os.Getenv("ANTHROPIC_API_KEY"), "https://api.anthropic.com/v1", nil)
	}
	if sourceID != "pi-mono" {
		return ImportResult{Details: []string{fmt.Sprintf("Import from '%s' is not yet implemented.", sourceID)}}, nil
	}
	return a.importPiMono()
}

func (a *App) importEnvironmentProvider(id, name, api, key, base string, models []ProviderModel) (ImportResult, error) {
	if strings.TrimSpace(key) == "" {
		return ImportResult{Skipped: 1, Details: []string{"Environment credential is not configured."}}, nil
	}
	config, err := loadProviderConfig()
	if err != nil {
		return ImportResult{}, err
	}
	config.Providers = append(config.Providers, ProviderEntry{ID: id, Name: name, API: api, APIKey: key, BaseURL: base, Source: "environment", Models: models, HasCredential: true})
	config = normalizeProviderConfig(config)
	if err := saveProviderConfig(config); err != nil {
		return ImportResult{}, err
	}
	return ImportResult{Imported: 1, Details: []string{fmt.Sprintf("Imported %s environment credentials.", name)}}, nil
}

func (a *App) importPiMono() (ImportResult, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return ImportResult{}, err
	}
	piDir := filepath.Join(home, ".pi", "agent")
	auth := map[string]piAuthCredential{}
	if body, readErr := os.ReadFile(filepath.Join(piDir, "auth.json")); readErr == nil {
		_ = json.Unmarshal(body, &auth)
	}
	models := map[string]piProviderConfig{}
	details := []string{}
	if body, readErr := os.ReadFile(filepath.Join(piDir, "models.json")); readErr == nil {
		var payload struct {
			Providers map[string]piProviderConfig `json:"providers"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			details = append(details, "models.json parse warning: "+err.Error())
		} else {
			models = payload.Providers
		}
	}
	config, err := loadProviderConfig()
	if err != nil {
		return ImportResult{}, err
	}
	seen := map[string]bool{}
	for _, entry := range config.Providers {
		seen[entry.ID] = true
	}
	imported, skipped := 0, 0
	for providerName, providerConfig := range models {
		api := providerConfig.API
		if api == "" {
			api = "openai-completions"
		}
		base := providerConfig.BaseURL
		key := resolveKeyReference(providerConfig.APIKey)
		credential := piCredential(auth[providerName])
		if key == "" {
			key = resolveKeyReference(auth[providerName].Key)
		}
		if len(providerConfig.Models) == 0 {
			id := "pi-" + providerName
			if seen[id] {
				skipped++
				continue
			}
			config.Providers = append(config.Providers, ProviderEntry{ID: id, Name: first(providerConfig.Name, providerName), API: api, BaseURL: base, APIKey: key, Credential: credential, HasCredential: key != "" || len(credential) > 0, Source: "pi-mono"})
			seen[id] = true
			imported++
			continue
		}
		id := "pi-" + providerName
		entryIndex := -1
		for index := range config.Providers {
			if config.Providers[index].ID == id {
				entryIndex = index
				break
			}
		}
		if entryIndex < 0 {
			config.Providers = append(config.Providers, ProviderEntry{ID: id, Name: first(providerConfig.Name, providerName), API: api, BaseURL: base, APIKey: key, Credential: credential, Source: "pi-mono", HasCredential: key != "" || len(credential) > 0})
			entryIndex = len(config.Providers) - 1
			imported++
		}
		for _, model := range providerConfig.Models {
			if !containsModel(config.Providers[entryIndex].Models, model.ID) {
				config.Providers[entryIndex].Models = append(config.Providers[entryIndex].Models, ProviderModel{ID: model.ID, Name: first(model.Name, model.ID)})
			} else {
				skipped++
			}
		}
	}
	for providerName, credential := range auth {
		id := "pi-auth-" + providerName
		if seen[id] {
			continue
		}
		key := resolveKeyReference(credential.Key)
		value := piCredential(credential)
		if key == "" && len(value) == 0 {
			skipped++
			continue
		}
		api := guessAPI(providerName)
		entry := ProviderEntry{ID: id, Name: providerName, API: api, BaseURL: defaultBaseURL(providerName), APIKey: key, Credential: value, HasCredential: key != "" || len(value) > 0, Source: "pi-mono", Models: defaultModels(providerName)}
		if isCodexProvider(providerName) {
			entry.Name = "ChatGPT / OpenAI Codex OAuth"
			details = append(details, "Imported ChatGPT/OpenAI OAuth credential from Pi Mono for Codex Responses.")
		}
		config.Providers = append(config.Providers, entry)
		seen[id] = true
		imported++
	}
	config = normalizeProviderConfig(config)
	if err := saveProviderConfig(config); err != nil {
		return ImportResult{}, err
	}
	details = append([]string{fmt.Sprintf("Imported %d providers, skipped %d.", imported, skipped)}, details...)
	return ImportResult{Imported: imported, Skipped: skipped, Details: details}, nil
}

func first(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}
func resolveKeyReference(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "$") {
		name := strings.Trim(raw[1:], "{}")
		return os.Getenv(name)
	}
	if raw == "" || strings.HasPrefix(raw, "!") {
		return ""
	}
	return raw
}
func isCodexProvider(provider string) bool {
	lower := strings.ToLower(provider)
	return strings.Contains(lower, "openai-codex") || strings.Contains(lower, "chatgpt") || lower == "codex"
}
func guessAPI(provider string) string {
	lower := strings.ToLower(provider)
	switch {
	case strings.Contains(lower, "anthropic"):
		return "anthropic-messages"
	case isCodexProvider(provider):
		return "openai-codex-responses"
	case strings.Contains(lower, "openai"):
		return "openai-responses"
	case strings.Contains(lower, "google"), strings.Contains(lower, "gemini"):
		return "google-generative-ai"
	default:
		return "openai-completions"
	}
}
func defaultBaseURL(provider string) string {
	if isCodexProvider(provider) {
		return "https://chatgpt.com/backend-api"
	}
	return ""
}
func defaultModels(provider string) []ProviderModel {
	provider = strings.ToLower(provider)
	if isCodexProvider(provider) {
		return []ProviderModel{{ID: "gpt-5.1-codex", Name: "GPT 5.1 Codex"}, {ID: "gpt-5.1-codex-mini", Name: "GPT 5.1 Codex Mini"}, {ID: "gpt-5.2-codex", Name: "GPT 5.2 Codex"}, {ID: "gpt-5.3-codex", Name: "GPT 5.3 Codex"}, {ID: "gpt-5.3-codex-spark", Name: "GPT 5.3 Codex Spark"}, {ID: "gpt-5.5", Name: "GPT 5.5"}}
	}
	if strings.Contains(provider, "anthropic") || strings.Contains(provider, "claude") {
		return []ProviderModel{{ID: "claude-sonnet-4-6", Name: "Claude Sonnet 4.6"}, {ID: "claude-haiku-4-5-20251001", Name: "Claude Haiku 4.5"}}
	}
	return nil
}
func piCredential(credential piAuthCredential) map[string]any {
	if strings.ToLower(first(credential.Type, "oauth")) != "oauth" || (credential.Access == "" && credential.Refresh == "") {
		return nil
	}
	accountID := credential.AccountID
	if accountID == "" {
		accountID = openAICodexAccountID(credential.Access)
	}
	return map[string]any{"type": "oauth", "access": credential.Access, "refresh": credential.Refresh, "expires": credential.Expires, "accountId": accountID, "refreshSupport": "openai-codex"}
}

func (a *App) OpenAICodexOAuthStart() (OpenAICodexOAuthStart, error) {
	body, err := json.Marshal(map[string]string{"client_id": openAICodexClientID})
	if err != nil {
		return OpenAICodexOAuthStart{}, err
	}
	request, err := http.NewRequest(http.MethodPost, openAIDeviceUserCodeURL, bytes.NewReader(body))
	if err != nil {
		return OpenAICodexOAuthStart{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return OpenAICodexOAuthStart{}, fmt.Errorf("OpenAI Codex device code request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		return OpenAICodexOAuthStart{}, fmt.Errorf("OpenAI Codex device code request failed: HTTP %d", response.StatusCode)
	}
	var payload struct {
		DeviceAuthID string `json:"device_auth_id"`
		UserCode     string `json:"user_code"`
		Interval     any    `json:"interval"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return OpenAICodexOAuthStart{}, err
	}
	interval := parseInterval(payload.Interval)
	if payload.DeviceAuthID == "" || payload.UserCode == "" {
		return OpenAICodexOAuthStart{}, errors.New("OpenAI Codex device code response missing fields")
	}
	return OpenAICodexOAuthStart{DeviceAuthID: payload.DeviceAuthID, UserCode: payload.UserCode, VerificationURI: openAIDeviceVerificationURI, IntervalSeconds: interval}, nil
}

func (a *App) OpenAICodexOAuthComplete(deviceAuthID, userCode string, interval *uint64) (ImportResult, error) {
	delay := uint64(5)
	if interval != nil && *interval > 0 {
		delay = *interval
	}
	if delay > 20 {
		delay = 20
	}
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		body, _ := json.Marshal(map[string]string{"device_auth_id": deviceAuthID, "user_code": userCode})
		request, err := http.NewRequest(http.MethodPost, openAIDeviceTokenURL, bytes.NewReader(body))
		if err != nil {
			return ImportResult{}, err
		}
		request.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return ImportResult{}, err
		}
		raw, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if response.StatusCode/100 == 2 {
			var token struct {
				AuthorizationCode string `json:"authorization_code"`
				CodeVerifier      string `json:"code_verifier"`
			}
			if json.Unmarshal(raw, &token) == nil && token.AuthorizationCode != "" {
				return a.exchangeOpenAICode(token.AuthorizationCode, token.CodeVerifier, openAIDeviceRedirectURI)
			}
		}
		time.Sleep(time.Duration(delay) * time.Second)
	}
	return ImportResult{}, errors.New("OpenAI Codex device login timed out")
}

func (a *App) exchangeOpenAICode(code, verifier, redirectURI string) (ImportResult, error) {
	if redirectURI == "" {
		redirectURI = openAIDeviceRedirectURI
	}
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {openAICodexClientID}, "code": {code}, "code_verifier": {verifier}, "redirect_uri": {redirectURI}}
	request, err := http.NewRequest(http.MethodPost, openAITokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return ImportResult{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return ImportResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		return ImportResult{}, fmt.Errorf("OpenAI Codex token exchange failed: HTTP %d", response.StatusCode)
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    uint64 `json:"expires_in"`
	}
	if err := json.NewDecoder(response.Body).Decode(&token); err != nil {
		return ImportResult{}, err
	}
	if token.AccessToken == "" || token.RefreshToken == "" {
		return ImportResult{}, errors.New("OpenAI Codex token response missing access or refresh token")
	}
	return a.saveOpenAIOAuth(token.AccessToken, token.RefreshToken, token.ExpiresIn)
}

func (a *App) openAICodexBrowser() (ImportResult, error) {
	verifierBytes := make([]byte, 32)
	if _, err := rand.Read(verifierBytes); err != nil {
		return ImportResult{}, err
	}
	verifier := base64.RawURLEncoding.EncodeToString(verifierBytes)
	challengeBytes := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeBytes[:])
	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		return ImportResult{}, err
	}
	state := base64.RawURLEncoding.EncodeToString(stateBytes)
	listener, err := net.Listen("tcp", "127.0.0.1:1455")
	if err != nil {
		return ImportResult{}, fmt.Errorf("OAuth callback listener failed: %w", err)
	}
	defer listener.Close()
	_ = listener.(*net.TCPListener).SetDeadline(time.Now().Add(10 * time.Minute))
	query := url.Values{"client_id": {openAICodexClientID}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}, "redirect_uri": {openAIBrowserRedirectURI}, "response_type": {"code"}, "scope": {openAIScope}, "state": {state}, "id_token_add_organizations": {"true"}, "codex_cli_simplified_flow": {"true"}, "originator": {"codex-usage-tray"}}
	if err := a.browser.OpenURL(openAIAuthorizeURL + "?" + query.Encode()); err != nil {
		return ImportResult{}, err
	}
	for {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return ImportResult{}, errors.New("OAuth login timed out")
		}
		request := make([]byte, 16*1024)
		count, _ := connection.Read(request)
		text := string(request[:count])
		requestURL := ""
		if lineEnd := strings.Index(text, "\r\n"); lineEnd >= 0 {
			fields := strings.Fields(text[:lineEnd])
			if len(fields) > 1 {
				requestURL = fields[1]
			}
		}
		parsed, parseErr := url.Parse(requestURL)
		if parseErr != nil || parsed.Path != "/auth/callback" || parsed.Query().Get("state") != state {
			writeOAuthCallbackResponse(connection, "400 Bad Request", "OAuth validation failed.")
			_ = connection.Close()
			continue
		}
		code := parsed.Query().Get("code")
		writeOAuthCallbackResponse(connection, "200 OK", "You may close this window and return to the office.")
		_ = connection.Close()
		if code == "" {
			return ImportResult{}, errors.New("OAuth callback did not include an authorization code")
		}
		return a.exchangeBrowserCode(code, verifier)
	}
}

func (a *App) exchangeBrowserCode(code, verifier string) (ImportResult, error) {
	return a.exchangeOpenAICode(code, verifier, openAIBrowserRedirectURI)
}

func (a *App) openClaudeOAuthBrowser() (ImportResult, error) {
	verifierBytes := make([]byte, 32)
	if _, err := rand.Read(verifierBytes); err != nil {
		return ImportResult{}, err
	}
	verifier := base64.RawURLEncoding.EncodeToString(verifierBytes)
	challengeBytes := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeBytes[:])
	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		return ImportResult{}, err
	}
	state := base64.RawURLEncoding.EncodeToString(stateBytes)
	listener, err := net.Listen("tcp", "127.0.0.1:53692")
	if err != nil {
		return ImportResult{}, fmt.Errorf("Claude OAuth callback listener failed: %w", err)
	}
	defer listener.Close()
	_ = listener.(*net.TCPListener).SetDeadline(time.Now().Add(10 * time.Minute))
	query := url.Values{"client_id": {anthropicOAuthClientID}, "code": {"true"}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}, "redirect_uri": {anthropicOAuthRedirectURI}, "response_type": {"code"}, "scope": {anthropicOAuthScope}, "state": {state}}
	if err := a.browser.OpenURL(anthropicOAuthAuthorizeURL + "?" + query.Encode()); err != nil {
		return ImportResult{}, err
	}
	for {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return ImportResult{}, errors.New("Claude OAuth login timed out")
		}
		request := make([]byte, 16*1024)
		count, _ := connection.Read(request)
		text := string(request[:count])
		requestURL := ""
		if lineEnd := strings.Index(text, "\r\n"); lineEnd >= 0 {
			fields := strings.Fields(text[:lineEnd])
			if len(fields) > 1 {
				requestURL = fields[1]
			}
		}
		parsed, parseErr := url.Parse(requestURL)
		if parseErr != nil || parsed.Path != "/callback" || parsed.Query().Get("state") != state {
			writeOAuthCallbackResponse(connection, "400 Bad Request", "OAuth validation failed.")
			_ = connection.Close()
			continue
		}
		if callbackError := parsed.Query().Get("error"); callbackError != "" {
			writeOAuthCallbackResponse(connection, "400 Bad Request", "OAuth login was denied.")
			_ = connection.Close()
			return ImportResult{}, fmt.Errorf("Claude OAuth login denied: %s", callbackError)
		}
		code := parsed.Query().Get("code")
		writeOAuthCallbackResponse(connection, "200 OK", "You may close this window and return to the office.")
		_ = connection.Close()
		if code == "" {
			return ImportResult{}, errors.New("Claude OAuth callback did not include an authorization code")
		}
		return a.exchangeAnthropicCode(code, verifier)
	}
}

func writeOAuthCallbackResponse(connection net.Conn, status, body string) {
	_, _ = fmt.Fprintf(connection, "HTTP/1.1 %s\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", status, len(body), body)
}

func (a *App) exchangeAnthropicCode(code, verifier string) (ImportResult, error) {
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {anthropicOAuthClientID}, "code": {code}, "code_verifier": {verifier}, "redirect_uri": {anthropicOAuthRedirectURI}}
	request, err := http.NewRequest(http.MethodPost, anthropicOAuthTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return ImportResult{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return ImportResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		return ImportResult{}, fmt.Errorf("Claude OAuth token exchange failed: HTTP %d", response.StatusCode)
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    uint64 `json:"expires_in"`
	}
	if err := json.NewDecoder(response.Body).Decode(&token); err != nil {
		return ImportResult{}, err
	}
	if token.AccessToken == "" || token.RefreshToken == "" {
		return ImportResult{}, errors.New("Claude OAuth token response missing access or refresh token")
	}
	return a.saveAnthropicOAuth(token.AccessToken, token.RefreshToken, token.ExpiresIn)
}

func refreshAnthropicAccessToken(refresh string) (string, string, uint64, error) {
	if refresh == "" {
		return "", "", 0, errors.New("Claude OAuth refresh token is missing")
	}
	form := url.Values{"grant_type": {"refresh_token"}, "client_id": {anthropicOAuthClientID}, "refresh_token": {refresh}}
	request, err := http.NewRequest(http.MethodPost, anthropicOAuthTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", "", 0, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", "", 0, err
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		return "", "", 0, fmt.Errorf("Claude OAuth refresh failed: HTTP %d", response.StatusCode)
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    uint64 `json:"expires_in"`
	}
	if err := json.NewDecoder(response.Body).Decode(&token); err != nil {
		return "", "", 0, err
	}
	if token.AccessToken == "" {
		return "", "", 0, errors.New("Claude OAuth refresh response missing access token")
	}
	return token.AccessToken, token.RefreshToken, token.ExpiresIn, nil
}

func (a *App) saveAnthropicOAuth(access, refresh string, expiresIn uint64) (ImportResult, error) {
	config, err := loadProviderConfig()
	if err != nil {
		return ImportResult{}, err
	}
	expires := uint64(time.Now().UnixMilli()) + expiresIn*1000
	entry := ProviderEntry{ID: "pi-auth-anthropic", Name: "Claude / Anthropic OAuth", API: "anthropic-messages", BaseURL: "https://api.anthropic.com/v1", Credential: map[string]any{"type": "oauth", "access": access, "refresh": refresh, "expires": expires, "refreshSupport": "anthropic"}, HasCredential: true, Source: "anthropic-oauth", Models: defaultModels("anthropic")}
	result := config.Providers[:0]
	for _, item := range config.Providers {
		if item.ID != entry.ID {
			result = append(result, item)
		}
	}
	config.Providers = append(result, entry)
	config.Selected.ProviderID = entry.ID
	config.Selected.ModelID = "claude-sonnet-4-6"
	if err := saveProviderConfig(normalizeProviderConfig(config)); err != nil {
		return ImportResult{}, err
	}
	return ImportResult{Imported: 1, Details: []string{"Claude/Anthropic OAuth credential configured for native messages."}}, nil
}
func (a *App) saveOpenAIOAuth(access, refresh string, expiresIn uint64) (ImportResult, error) {
	config, err := loadProviderConfig()
	if err != nil {
		return ImportResult{}, err
	}
	expires := uint64(time.Now().UnixMilli()) + expiresIn*1000
	entry := ProviderEntry{ID: "pi-auth-openai-codex", Name: "ChatGPT / OpenAI Codex OAuth", API: "openai-codex-responses", BaseURL: "https://chatgpt.com/backend-api", Credential: map[string]any{"type": "oauth", "access": access, "refresh": refresh, "expires": expires, "accountId": openAICodexAccountID(access), "refreshSupport": "available"}, HasCredential: true, Source: "openai-codex-oauth", Models: defaultModels("openai-codex")}
	result := config.Providers[:0]
	for _, item := range config.Providers {
		if item.ID != entry.ID {
			result = append(result, item)
		}
	}
	config.Providers = append(result, entry)
	config.Selected.ProviderID = entry.ID
	config.Selected.ModelID = "gpt-5.5"
	if err := saveProviderConfig(normalizeProviderConfig(config)); err != nil {
		return ImportResult{}, err
	}
	return ImportResult{Imported: 1, Details: []string{"ChatGPT/OpenAI OAuth credential configured for Codex Responses."}}, nil
}

func openAICodexAccountID(access string) string {
	parts := strings.Split(access, ".")
	if len(parts) < 2 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var value map[string]any
	if json.Unmarshal(payload, &value) != nil {
		return ""
	}
	if result, _ := value["chatgpt_account_id"].(string); result != "" {
		return result
	}
	auth, _ := value["https://api.openai.com/auth"].(map[string]any)
	result, _ := auth["chatgpt_account_id"].(string)
	return result
}
func parseInterval(value any) uint64 {
	switch v := value.(type) {
	case float64:
		if v > 0 {
			return uint64(v)
		}
	case string:
		if parsed, err := time.ParseDuration(v + "s"); err == nil {
			return uint64(parsed.Seconds())
		}
	}
	return 5
}

func refreshOpenAIAccessToken(refresh string) (string, string, uint64, error) {
	form := url.Values{"grant_type": {"refresh_token"}, "client_id": {openAICodexClientID}, "refresh_token": {refresh}}
	request, err := http.NewRequest(http.MethodPost, openAITokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", "", 0, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", "", 0, err
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		return "", "", 0, fmt.Errorf("OpenAI Codex token refresh failed: HTTP %d", response.StatusCode)
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    uint64 `json:"expires_in"`
	}
	if err := json.NewDecoder(response.Body).Decode(&token); err != nil {
		return "", "", 0, err
	}
	return token.AccessToken, token.RefreshToken, token.ExpiresIn, nil
}

var _ = context.Background
