package office

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

type Role string

const (
	RoleOwner  Role = "owner"
	RoleMember Role = "member"
	RoleGuest  Role = "guest"
)

type User struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Color       string `json:"color"`
	Role        Role   `json:"role"`
	Approved    bool   `json:"approved"`
	Banned      bool   `json:"banned,omitempty"`
	Password    string `json:"password,omitempty"`
	Salt        string `json:"salt,omitempty"`
	CreatedAt   int64  `json:"createdAt"`
}

type Session struct {
	Token     string `json:"token"`
	Username  string `json:"username"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

const sessionTTL = 30 * 24 * time.Hour

var avatarColors = []string{"#5b8cff", "#ff8c5b", "#5bffb0", "#c05bff", "#ffd24a", "#ff5b8c", "#4ad4ff", "#8cff5b"}

type AuthStore struct {
	mu       sync.RWMutex
	dir      string
	users    map[string]*User
	sessions map[string]*Session
}

func NewAuthStore(dir string) *AuthStore {
	store := &AuthStore{dir: dir, users: map[string]*User{}, sessions: map[string]*Session{}}
	_ = os.MkdirAll(dir, 0o755)
	store.users = readJSONFile(store.path("users.json"), map[string]*User{})
	store.sessions = readJSONFile(store.path("sessions.json"), map[string]*Session{})
	for token, s := range store.sessions {
		if s.ExpiresAt < time.Now().UnixMilli() {
			delete(store.sessions, token)
		}
	}
	store.saveSessions()
	return store
}

func (s *AuthStore) path(name string) string { return filepath.Join(s.dir, name) }

func readJSONFile[T any](path string, fallback T) T {
	data, err := os.ReadFile(path)
	if err != nil {
		return fallback
	}
	var out T
	if err := json.Unmarshal(data, &out); err != nil {
		return fallback
	}
	return out
}

func writeJSONFile(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func (s *AuthStore) saveUsers()    { _ = writeJSONFile(s.path("users.json"), s.users) }
func (s *AuthStore) saveSessions() { _ = writeJSONFile(s.path("sessions.json"), s.sessions) }

func normalizeUsername(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

func (s *AuthStore) User(name string) *User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.users[normalizeUsername(name)]
}

func (s *AuthStore) HasUsers() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, user := range s.users {
		if user.Password != "" {
			return true
		}
	}
	return false
}

func (s *AuthStore) isFirstUser() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.users) == 1
}

func hashPassword(password string, salt []byte) string {
	key, err := pbkdf2.Key(sha256.New, password, salt, 600_000, 32)
	if err != nil {
		return ""
	}
	return hex.EncodeToString(key)
}

func newSalt() ([]byte, error) {
	salt := make([]byte, 16)
	_, err := rand.Read(salt)
	return salt, err
}

func (s *AuthStore) createUser(username, password string, role Role) (*User, *Session, error) {
	username = normalizeUsername(username)
	if len(username) < 3 || len(username) > 32 || strings.ContainsAny(username, " \t\n/\\") {
		return nil, nil, errors.New("username must be 3-32 characters with no spaces or slashes")
	}
	if role != RoleGuest && len(password) < 8 {
		return nil, nil, errors.New("password must be at least 8 characters")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.users[username]; exists {
		return nil, nil, errors.New("that username is taken")
	}
	if role != RoleGuest {
		firstAccount := true
		for _, existing := range s.users {
			if existing.Password != "" {
				firstAccount = false
				break
			}
		}
		if firstAccount {
			role = RoleOwner
		}
	}
	salt, err := newSalt()
	if err != nil {
		return nil, nil, err
	}
	user := &User{
		Username:    username,
		DisplayName: username,
		Role:        role,
		Approved:    true,
		CreatedAt:   time.Now().UnixMilli(),
		Salt:        hex.EncodeToString(salt),
		Color:       avatarColors[len(s.users)%len(avatarColors)],
	}
	if password != "" {
		user.Password = hashPassword(password, salt)
	}
	if role == RoleGuest {
		user.Approved = false
	}
	s.users[username] = user
	s.saveUsers()
	return user, s.newSession(username), nil
}

func (s *AuthStore) newSession(username string) *Session {
	token := make([]byte, 32)
	_, _ = rand.Read(token)
	now := time.Now().UnixMilli()
	session := &Session{
		Token:     hex.EncodeToString(token),
		Username:  username,
		CreatedAt: now,
		ExpiresAt: now + sessionTTL.Milliseconds(),
	}
	s.sessions[session.Token] = session
	s.saveSessions()
	return session
}

var errBadCredentials = errors.New("incorrect username or password")

func (s *AuthStore) Login(username, password string) (*User, *Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	user := s.users[normalizeUsername(username)]
	if user == nil || user.Password == "" || !user.Approved || user.Banned {
		return nil, nil, errBadCredentials
	}
	salt, err := hex.DecodeString(user.Salt)
	if err != nil {
		return nil, nil, errBadCredentials
	}
	actual := hashPassword(password, salt)
	if subtle.ConstantTimeCompare([]byte(user.Password), []byte(actual)) != 1 {
		return nil, nil, errBadCredentials
	}
	return user, s.newSession(user.Username), nil
}

func (s *AuthStore) RequestGuest(name string) (*User, *Session, error) {
	name = normalizeUsername(name)
	if name == "" {
		return nil, nil, errors.New("enter a name")
	}
	s.mu.RLock()
	if existing, ok := s.users[name]; ok {
		banned, approved := existing.Banned, existing.Approved
		s.mu.RUnlock()
		if banned {
			return nil, nil, errors.New("this account is banned")
		}
		if approved {
			return nil, nil, errors.New("that name is already in the office")
		}
		return nil, nil, errors.New("that name is already waiting")
	}
	s.mu.RUnlock()
	return s.createUser(name, "", RoleGuest)
}

func (s *AuthStore) GuestApproved(name, requestToken string) (*User, *Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	name = normalizeUsername(name)
	user := s.users[name]
	session := s.sessions[requestToken]
	if user == nil || user.Role != RoleGuest || session == nil || session.Username != name || session.ExpiresAt < time.Now().UnixMilli() {
		return nil, nil, false
	}
	if !user.Approved || user.Banned {
		return user, nil, false
	}
	return user, session, true
}

func (s *AuthStore) PendingGuests() []map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]map[string]any, 0)
	for _, user := range s.users {
		if user.Role == RoleGuest && !user.Approved && !user.Banned {
			out = append(out, publicUser(user))
		}
	}
	return out
}

func (s *AuthStore) SetApproved(name string, approved bool) (*User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	user := s.users[normalizeUsername(name)]
	if user == nil {
		return nil, errors.New("no such guest")
	}
	if user.Banned {
		return nil, errors.New("guest is banned")
	}
	if !approved {
		delete(s.users, user.Username)
		s.saveUsers()
		return nil, errors.New("guest declined")
	}
	user.Approved = true
	user.Role = RoleGuest
	s.saveUsers()
	return user, nil
}

func (s *AuthStore) Session(token string) *Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	session := s.sessions[token]
	if session == nil || session.ExpiresAt < time.Now().UnixMilli() {
		return nil
	}
	return session
}

func (s *AuthStore) Logout(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, token)
	s.saveSessions()
}

func (s *AuthStore) Moderate(name, action string) (*User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	user := s.users[normalizeUsername(name)]
	if user == nil {
		return nil, errors.New("no such user")
	}
	if user.Role == RoleOwner {
		return nil, errors.New("owners cannot be moderated")
	}
	switch action {
	case "kick", "ban":
		if action == "ban" {
			user.Banned = true
			s.saveUsers()
		}
		for token, session := range s.sessions {
			if session.Username == user.Username {
				delete(s.sessions, token)
			}
		}
		s.saveSessions()
	case "unban":
		if !user.Banned {
			return nil, errors.New("user is not banned")
		}
		user.Banned = false
		s.saveUsers()
	default:
		return nil, errors.New("unknown moderation action")
	}
	return user, nil
}

func (s *AuthStore) BannedUsers() []map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	users := make([]map[string]any, 0)
	for _, user := range s.users {
		if user.Banned {
			users = append(users, publicUser(user))
		}
	}
	return users
}

func (s *AuthStore) SetNickname(name, nickname string) (*User, error) {
	nickname = strings.TrimSpace(nickname)
	if utf8.RuneCountInString(nickname) > 24 || strings.IndexFunc(nickname, unicode.IsControl) >= 0 {
		return nil, errors.New("nickname must be at most 24 characters without control characters")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	user := s.users[normalizeUsername(name)]
	if user == nil {
		return nil, errors.New("no such user")
	}
	if nickname == "" {
		nickname = user.Username
	}
	previous := user.DisplayName
	user.DisplayName = nickname
	if err := writeJSONFile(s.path("users.json"), s.users); err != nil {
		user.DisplayName = previous
		return nil, err
	}
	return user, nil
}

func sessionCookieName() string { return "agentoffice_session" }

func setSessionCookie(w http.ResponseWriter, session *Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName(),
		Value:    session.Token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.UnixMilli(session.ExpiresAt),
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName(), Value: "", Path: "/", HttpOnly: true, MaxAge: -1})
}

func (s *AuthStore) sessionFromRequest(r *http.Request) (*User, *Session) {
	cookie, err := r.Cookie(sessionCookieName())
	if err != nil {
		return nil, nil
	}
	session := s.Session(cookie.Value)
	if session == nil {
		return nil, nil
	}
	user := s.User(session.Username)
	if user == nil || !user.Approved || user.Banned {
		return nil, nil
	}
	return user, session
}

func publicUser(user *User) map[string]any {
	if user == nil {
		return nil
	}
	return map[string]any{
		"username": user.Username, "displayName": user.DisplayName,
		"color": user.Color, "role": user.Role, "approved": user.Approved,
	}
}
