package office

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestVehicleOwnershipAndValidation(t *testing.T) {
	h := NewHub(&App{}, nil)
	member := &client{id: "member", user: &User{Role: RoleMember}, send: make(chan []byte, 32)}
	other := &client{id: "other", user: &User{Role: RoleOwner}, send: make(chan []byte, 32)}
	guest := &client{id: "guest", user: &User{Role: RoleGuest}, send: make(chan []byte, 32)}
	h.clients[member.id], h.clients[other.id], h.clients[guest.id] = member, other, guest
	if !commandAllowed("vehicles_get", RoleGuest) || commandAllowed("vehicle_enter", RoleGuest) {
		t.Fatal("incorrect guest vehicle permissions")
	}
	if _, err := h.vehicleCommand(guest, "vehicle_enter", map[string]any{"id": float64(0)}); err == nil {
		t.Fatal("guest took a vehicle")
	}
	state, err := h.vehicleCommand(member, "vehicle_enter", map[string]any{"id": float64(0), "driver": other.id})
	if err != nil || state.Driver != member.id {
		t.Fatalf("claim did not use authenticated connection: %+v %v", state, err)
	}
	if _, err := h.vehicleCommand(other, "vehicle_enter", map[string]any{"id": float64(0)}); err == nil {
		t.Fatal("second driver stole vehicle")
	}
	if _, err := h.vehicleCommand(member, "vehicle_enter", map[string]any{"id": float64(1)}); err == nil {
		t.Fatal("one connection took multiple vehicles")
	}
	pose := map[string]any{"x": -10.8, "z": float64(-3), "yaw": float64(0), "speed": float64(2), "steer": float64(0)}
	if _, err := h.vehicleCommand(other, "vehicle_move", map[string]any{"id": float64(0), "pose": pose, "seq": float64(1)}); err == nil {
		t.Fatal("unowned vehicle moved")
	}
	state, err = h.vehicleCommand(member, "vehicle_move", map[string]any{"id": float64(0), "pose": pose, "seq": float64(1)})
	if err != nil || state.X != -10.8 || state.Revision != 2 {
		t.Fatalf("valid move rejected: %+v %v", state, err)
	}
	if _, err := h.vehicleCommand(member, "vehicle_move", map[string]any{"id": float64(0), "pose": pose, "seq": float64(1)}); err == nil {
		t.Fatal("stale move accepted")
	}
	for _, attempt := range []struct {
		key   string
		value float64
	}{{"x", math.NaN()}, {"z", math.Inf(1)}, {"yaw", 5}, {"speed", 16}, {"steer", 1}, {"x", 79}, {"x", 20}} {
		bad := map[string]any{}
		for key, value := range pose {
			bad[key] = value
		}
		bad[attempt.key] = attempt.value
		if _, err := h.vehicleCommand(member, "vehicle_move", map[string]any{"id": float64(0), "pose": bad, "seq": float64(2)}); err == nil {
			t.Fatalf("invalid %s=%v accepted", attempt.key, attempt.value)
		}
	}
	if _, err := h.vehicleCommand(other, "vehicle_exit", map[string]any{"id": float64(0)}); err == nil {
		t.Fatal("other connection released vehicle")
	}
	pose["x"] = -10.6
	state, err = h.vehicleCommand(member, "vehicle_exit", map[string]any{"id": float64(0), "pose": pose})
	if err != nil || state.Driver != "" || state.Speed != 0 || state.X != -10.6 {
		t.Fatalf("final exit pose not retained: %+v %v", state, err)
	}
	state, err = h.vehicleCommand(other, "vehicle_enter", map[string]any{"id": float64(0), "arrival": true})
	if err != nil || state.X != -54 || state.Z != 20.3 {
		t.Fatalf("arrival claim failed: %+v %v", state, err)
	}
	h.mu.Lock()
	delete(h.clients, other.id)
	released := h.releaseVehiclesLocked(other.id)
	h.mu.Unlock()
	if !released || h.vehiclesSnapshot()[0].Driver != "" {
		t.Fatal("disconnect did not release claim")
	}
	if _, err := h.vehicleCommand(other, "vehicle_enter", map[string]any{"id": float64(0)}); err == nil {
		t.Fatal("removed connection reclaimed vehicle")
	}
}

func TestVehicleWebSocketStateAndDisconnect(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	app := &App{ctx: ctx}
	auth := &AuthStore{users: map[string]*User{"first": {Username: "first", Role: RoleMember, Approved: true}, "second": {Username: "second", Role: RoleOwner, Approved: true}}, sessions: map[string]*Session{"first": {Token: "first", Username: "first", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}, "second": {Token: "second", Username: "second", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}}}
	h := NewHub(app, auth)
	app.hub = h
	server := httptest.NewServer(http.HandlerFunc(h.handleWS))
	defer server.Close()
	connect := func(token string) *websocket.Conn {
		t.Helper()
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {sessionCookieName() + "=" + token}}})
		if err != nil {
			t.Fatal(err)
		}
		return conn
	}
	first, second := connect("first"), connect("second")
	defer first.CloseNow()
	defer second.CloseNow()
	read := func(conn *websocket.Conn, match func(map[string]json.RawMessage) bool) map[string]json.RawMessage {
		t.Helper()
		for {
			_, payload, err := conn.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var message map[string]json.RawMessage
			if err := json.Unmarshal(payload, &message); err != nil {
				t.Fatal(err)
			}
			if match(message) {
				return message
			}
		}
	}
	stateEvent := func(message map[string]json.RawMessage) bool { return string(message["name"]) == `"vehicle-state"` }
	initial := read(second, stateEvent)
	var states []VehicleState
	if err := json.Unmarshal(initial["data"], &states); err != nil || len(states) != 4 {
		t.Fatalf("initial vehicle snapshot missing: %v", err)
	}
	request := func(conn *websocket.Conn, id int, command string, args any) {
		t.Helper()
		payload, _ := json.Marshal(map[string]any{"id": id, "command": command, "args": args})
		if err := conn.Write(ctx, websocket.MessageText, payload); err != nil {
			t.Fatal(err)
		}
	}
	request(first, 1, "vehicle_enter", map[string]any{"id": 0})
	reply := read(first, func(message map[string]json.RawMessage) bool { return string(message["id"]) == "1" })
	if string(reply["ok"]) != "true" {
		t.Fatalf("claim failed: %s", reply["error"])
	}
	claimed := read(second, func(message map[string]json.RawMessage) bool {
		if !stateEvent(message) {
			return false
		}
		_ = json.Unmarshal(message["data"], &states)
		return states[0].Driver != ""
	})
	if claimed == nil {
		t.Fatal("other browser did not receive claim")
	}
	request(second, 2, "vehicle_enter", map[string]any{"id": 0})
	reply = read(second, func(message map[string]json.RawMessage) bool { return string(message["id"]) == "2" })
	if string(reply["ok"]) != "false" {
		t.Fatal("second browser stole car")
	}
	request(first, 3, "vehicle_move", map[string]any{"id": 0, "seq": 1, "pose": map[string]any{"x": -10.8, "z": -3, "yaw": 0, "speed": 2, "steer": 0}})
	read(second, func(message map[string]json.RawMessage) bool {
		if !stateEvent(message) {
			return false
		}
		_ = json.Unmarshal(message["data"], &states)
		return states[0].X == -10.8
	})
	first.CloseNow()
	read(second, func(message map[string]json.RawMessage) bool {
		if !stateEvent(message) {
			return false
		}
		_ = json.Unmarshal(message["data"], &states)
		return states[0].Driver == "" && states[0].Revision >= 3
	})
	if states[0].Speed != 0 {
		t.Fatal("disconnected vehicle continued driving")
	}
}
