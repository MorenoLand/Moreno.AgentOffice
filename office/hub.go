package office

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

const (
	writeWait  = 10 * time.Second
	pingPeriod = 25 * time.Second
	maxMessage = 1 << 20
)

type Avatar struct {
	ConnectionID string  `json:"connectionId"`
	Username     string  `json:"username"`
	DisplayName  string  `json:"displayName"`
	Color        string  `json:"color"`
	Role         Role    `json:"role"`
	X            float64 `json:"x"`
	Y            float64 `json:"y"`
	Z            float64 `json:"z"`
	Yaw          float64 `json:"yaw"`
	Seated       bool    `json:"seated"`
}

type PropPosition struct {
	ID  string  `json:"id"`
	X   float64 `json:"x"`
	Y   float64 `json:"y"`
	Z   float64 `json:"z"`
	Yaw float64 `json:"yaw"`
}

type Hub struct {
	app              *App
	auth             *AuthStore
	mu               sync.RWMutex
	clients          map[string]*client
	avatars          map[string]*Avatar
	props            map[string]PropPosition
	vehicles         [4]VehicleState
	vehicleSequences [4]uint64
	vehicleMovedAt   [4]time.Time
}

type client struct {
	id     string
	conn   *websocket.Conn
	send   chan []byte
	hub    *Hub
	user   *User
	token  string
	avatar *Avatar
}

func NewHub(app *App, auth *AuthStore) *Hub {
	return &Hub{app: app, auth: auth, clients: map[string]*client{}, avatars: map[string]*Avatar{}, props: map[string]PropPosition{}, vehicles: parkedVehicles()}
}

func (h *Hub) Send(name string, data any) {
	payload, err := json.Marshal(map[string]any{"type": "event", "name": name, "data": data})
	if err != nil {
		return
	}
	h.mu.RLock()
	targets := make([]*client, 0, len(h.clients))
	for _, c := range h.clients {
		targets = append(targets, c)
	}
	h.mu.RUnlock()
	for _, c := range targets {
		c.enqueue(payload)
	}
}

func (c *client) enqueue(payload []byte) {
	select {
	case c.send <- payload:
	default:
		c.conn.Close(websocket.StatusPolicyViolation, "client too slow")
	}
}

func (h *Hub) handleWS(w http.ResponseWriter, r *http.Request) {
	user, session := h.auth.sessionFromRequest(r)
	if user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: false})
	if err != nil {
		return
	}
	conn.SetReadLimit(maxMessage)
	c := &client{id: randomID(), conn: conn, send: make(chan []byte, 256), hub: h, user: user, token: session.Token}
	c.avatar = &Avatar{
		ConnectionID: c.id, Username: user.Username, DisplayName: user.DisplayName,
		Color: user.Color, Role: user.Role,
	}
	h.mu.Lock()
	h.clients[c.id] = c
	h.avatars[c.id] = c.avatar
	h.mu.Unlock()
	if welcome, err := json.Marshal(map[string]any{
		"type": "event", "name": "welcome",
		"data": map[string]any{"connectionId": c.id, "user": publicUser(user)},
	}); err == nil {
		c.enqueue(welcome)
	}
	h.sendPropsState(c)
	h.sendVehiclesState(c)
	h.broadcastPresence()

	go c.writeLoop()
	c.readLoop()
	h.remove(c)
}

func (h *Hub) remove(c *client) {
	h.mu.Lock()
	delete(h.clients, c.id)
	delete(h.avatars, c.id)
	released := h.releaseVehiclesLocked(c.id)
	h.mu.Unlock()
	_ = c.conn.Close(websocket.StatusNormalClosure, "")
	h.broadcastPresence()
	if released {
		h.Send("vehicle-state", h.vehiclesSnapshot())
	}
}

func (c *client) readLoop() {
	defer c.conn.Close(websocket.StatusNormalClosure, "")
	for {
		_, data, err := c.conn.Read(c.hub.app.context())
		if err != nil {
			return
		}
		var msg struct {
			ID      int            `json:"id"`
			Command string         `json:"command"`
			Args    map[string]any `json:"args"`
		}
		if err := json.Unmarshal(data, &msg); err != nil || msg.Command == "" {
			continue
		}
		go c.dispatch(msg.ID, msg.Command, msg.Args)
	}
}

func (c *client) dispatch(id int, command string, args map[string]any) {
	if c.hub.auth.Session(c.token) == nil {
		_ = c.conn.Close(websocket.StatusPolicyViolation, "session expired")
		return
	}
	if isPublicCommand(command) {
		c.reply(id, nil, errAuthOverHTTP)
		return
	}
	if !commandAllowed(command, c.user.Role) {
		c.reply(id, nil, commandDenied(command))
		return
	}
	if command == "presence_move" {
		c.hub.moveAvatar(c, args)
		return
	}
	if command == "vehicle_enter" || command == "vehicle_move" || command == "vehicle_exit" {
		result, err := c.hub.vehicleCommand(c, command, args)
		c.reply(id, result, err)
		return
	}
	if command == "chat_send" {
		c.reply(id, nil, c.hub.sendChat(c, args))
		return
	}
	if command == "prop_move" {
		c.reply(id, nil, c.hub.moveProp(args))
		return
	}
	if command == "props_reset" {
		c.hub.resetProps()
		c.reply(id, nil, nil)
		return
	}
	if command == "dog_pet" {
		c.hub.Send("dog-pet", map[string]any{"connectionId": c.id})
		c.reply(id, nil, nil)
		return
	}
	var result any
	var err error
	if moderationCommands[command] {
		result, err = c.hub.moderate(c.user, command, args)
	} else {
		result, err = c.hub.app.Invoke(command, args)
	}
	c.reply(id, result, err)
}

func commandDenied(command string) error {
	if moderationCommands[command] {
		return errOwnerOnly
	}
	return errReadOnly
}

func (h *Hub) sendPropsState(c *client) {
	h.mu.RLock()
	props := make([]PropPosition, 0, len(h.props))
	for _, prop := range h.props {
		props = append(props, prop)
	}
	h.mu.RUnlock()
	if payload, err := json.Marshal(map[string]any{"type": "event", "name": "props-state", "data": props}); err == nil {
		c.enqueue(payload)
	}
}

func (h *Hub) moveProp(args map[string]any) error {
	prop, ok := args["prop"].(map[string]any)
	if !ok {
		return errors.New("prop position is required")
	}
	id, ok := prop["id"].(string)
	if !ok || !strings.HasPrefix(id, "prop-") || len(id) > 16 {
		return errors.New("invalid prop id")
	}
	read := func(key string) (float64, bool) { value, ok := prop[key].(float64); return value, ok }
	x, xOK := read("x")
	y, yOK := read("y")
	z, zOK := read("z")
	yaw, yawOK := read("yaw")
	if !xOK || !yOK || !zOK || !yawOK || math.IsNaN(x) || math.IsNaN(y) || math.IsNaN(z) || math.IsNaN(yaw) || math.IsInf(x, 0) || math.IsInf(y, 0) || math.IsInf(z, 0) || math.IsInf(yaw, 0) || x < -14 || x > 14 || y < 0 || y > 2 || z < -10 || z > 10 || yaw < -7 || yaw > 7 {
		return errors.New("prop position is outside the room")
	}
	position := PropPosition{ID: id, X: x, Y: y, Z: z, Yaw: yaw}
	h.mu.Lock()
	if len(h.props) >= 40 {
		if _, exists := h.props[id]; !exists {
			h.mu.Unlock()
			return errors.New("too many moved props")
		}
	}
	h.props[id] = position
	h.mu.Unlock()
	h.Send("prop-update", position)
	return nil
}

func (h *Hub) resetProps() {
	h.mu.Lock()
	h.props = map[string]PropPosition{}
	h.mu.Unlock()
	h.Send("props-reset", nil)
}

func (h *Hub) moderate(actor *User, command string, args map[string]any) (any, error) {
	if actor == nil || actor.Role != RoleOwner {
		return nil, errOwnerOnly
	}
	if command == "scan_music" {
		return h.app.ScanMusic(stringArg(args, "path"))
	}
	if command == "auth_banned_users" {
		return h.auth.BannedUsers(), nil
	}
	if command == "auth_set_nickname" {
		user, err := h.auth.SetNickname(stringArg(args, "username"), stringArg(args, "nickname"))
		if err != nil {
			return nil, err
		}
		h.mu.Lock()
		for _, avatar := range h.avatars {
			if avatar.Username == user.Username {
				avatar.DisplayName = user.DisplayName
			}
		}
		h.mu.Unlock()
		h.broadcastPresence()
		return publicUser(user), nil
	}
	action := map[string]string{"auth_kick_user": "kick", "auth_ban_user": "ban", "auth_unban_user": "unban"}[command]
	if action == "" {
		return nil, errOwnerOnly
	}
	user, err := h.auth.Moderate(stringArg(args, "username"), action)
	if err != nil {
		return nil, err
	}
	if action != "unban" {
		h.disconnectUser(user.Username, action)
	}
	return publicUser(user), nil
}

func (h *Hub) sendChat(c *client, args map[string]any) error {
	message := strings.TrimSpace(stringArg(args, "text"))
	if message == "" || utf8.RuneCountInString(message) > 280 {
		return errors.New("message must be 1-280 characters")
	}
	h.mu.RLock()
	avatar := h.avatars[c.id]
	if avatar == nil {
		h.mu.RUnlock()
		return errors.New("user is no longer in the office")
	}
	identity := *avatar
	h.mu.RUnlock()
	h.Send("chat-message", map[string]any{
		"connectionId": identity.ConnectionID, "username": identity.Username,
		"displayName": identity.DisplayName, "color": identity.Color,
		"text": message, "sentAt": time.Now().UnixMilli(),
	})
	return nil
}

func (h *Hub) disconnectUser(username, reason string) {
	h.mu.RLock()
	clients := make([]*client, 0)
	for _, c := range h.clients {
		if c.user.Username == username {
			clients = append(clients, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range clients {
		_ = c.conn.CloseNow()
	}
}

func (c *client) reply(id int, result any, err error) {
	if id == 0 {
		return
	}
	payload, marshalErr := json.Marshal(map[string]any{"id": id, "ok": err == nil, "data": result, "error": errorText(err)})
	if marshalErr != nil {
		return
	}
	c.enqueue(payload)
}

func errorText(err error) any {
	if err == nil {
		return nil
	}
	return err.Error()
}

func (h *Hub) moveAvatar(c *client, args map[string]any) {
	h.mu.Lock()
	avatar := h.avatars[c.id]
	if avatar == nil {
		h.mu.Unlock()
		return
	}
	if v, ok := args["x"].(float64); ok {
		avatar.X = v
	}
	if v, ok := args["y"].(float64); ok {
		avatar.Y = v
	}
	if v, ok := args["z"].(float64); ok {
		avatar.Z = v
	}
	if v, ok := args["yaw"].(float64); ok {
		avatar.Yaw = v
	}
	if v, ok := args["seated"].(bool); ok {
		avatar.Seated = v
	}
	snapshot := *avatar
	h.mu.Unlock()
	payload, err := json.Marshal(map[string]any{"type": "event", "name": "presence_move", "data": snapshot})
	if err != nil {
		return
	}
	h.mu.RLock()
	others := make([]*client, 0, len(h.clients))
	for id, other := range h.clients {
		if id != c.id {
			others = append(others, other)
		}
	}
	h.mu.RUnlock()
	for _, other := range others {
		other.enqueue(payload)
	}
}

func (h *Hub) broadcastPresence() {
	h.mu.RLock()
	list := make([]Avatar, 0, len(h.avatars))
	for _, avatar := range h.avatars {
		list = append(list, *avatar)
	}
	h.mu.RUnlock()
	h.Send("presence", list)
}

func (c *client) writeLoop() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close(websocket.StatusNormalClosure, "")
	}()
	for {
		select {
		case payload, ok := <-c.send:
			ctx, cancel := context.WithTimeout(c.hub.app.context(), writeWait)
			err := c.conn.Write(ctx, websocket.MessageText, payload)
			cancel()
			if !ok || err != nil {
				return
			}
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(c.hub.app.context(), writeWait)
			err := c.conn.Ping(ctx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

type rpcRequest struct {
	Command string         `json:"command"`
	Args    map[string]any `json:"args"`
}

func (h *Hub) handleRPC(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		http.Error(w, "application/json required", http.StatusUnsupportedMediaType)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host != r.Host {
			http.Error(w, "cross-origin request denied", http.StatusForbidden)
			return
		}
	}
	var req rpcRequest
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 5<<20))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := json.Unmarshal(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &req); err != nil || req.Command == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	user, session := h.auth.sessionFromRequest(r)
	if isPublicCommand(req.Command) {
		h.rpcAuth(w, r, req.Command, req.Args, user, session)
		return
	}
	if user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !commandAllowed(req.Command, user.Role) {
		http.Error(w, commandDenied(req.Command).Error(), http.StatusForbidden)
		return
	}
	h.rpcAuth(w, r, req.Command, req.Args, user, session)
}

func (h *Hub) rpcAuth(w http.ResponseWriter, r *http.Request, command string, args map[string]any, user *User, session *Session) {
	var result any
	var err error
	if moderationCommands[command] {
		result, err = h.moderate(user, command, args)
	} else {
		var handled bool
		result, handled, err = h.app.handleAuth(w, command, args, user, session)
		if !handled {
			result, err = h.app.Invoke(command, args)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": result})
}

func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.clients {
		close(c.send)
	}
	h.clients = map[string]*client{}
	h.avatars = map[string]*Avatar{}
	h.vehicles = parkedVehicles()
	h.vehicleSequences = [4]uint64{}
	h.vehicleMovedAt = [4]time.Time{}
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if r.URL.Path != "/ws" {
			log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}
