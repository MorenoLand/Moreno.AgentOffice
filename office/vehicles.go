package office

import (
	"encoding/json"
	"errors"
	"math"
	"time"
)

type VehicleState struct {
	ID       int     `json:"id"`
	X        float64 `json:"x"`
	Z        float64 `json:"z"`
	Yaw      float64 `json:"yaw"`
	Speed    float64 `json:"speed"`
	Steer    float64 `json:"steer"`
	Driver   string  `json:"driver"`
	Revision uint64  `json:"revision"`
}

var vehicleMaxSpeeds = [4]float64{15, 21, 17, 13}

func parkedVehicles() [4]VehicleState {
	return [4]VehicleState{{ID: 0, X: -11, Z: -3}, {ID: 1, X: -4, Z: 4}, {ID: 2, X: 4, Z: -3}, {ID: 3, X: 11, Z: 4}}
}

func vehicleID(args map[string]any) (int, error) {
	id, ok := args["id"].(float64)
	if !ok || math.IsNaN(id) || math.IsInf(id, 0) || id < 0 || id >= 4 || id != math.Trunc(id) {
		return 0, errors.New("invalid vehicle id")
	}
	return int(id), nil
}

func vehiclePose(args map[string]any, id int) (VehicleState, error) {
	pose, ok := args["pose"].(map[string]any)
	if !ok {
		return VehicleState{}, errors.New("vehicle pose required")
	}
	state := VehicleState{ID: id}
	for key, target := range map[string]*float64{"x": &state.X, "z": &state.Z, "yaw": &state.Yaw, "speed": &state.Speed, "steer": &state.Steer} {
		value, valid := pose[key].(float64)
		if !valid || math.IsNaN(value) || math.IsInf(value, 0) {
			return VehicleState{}, errors.New("vehicle pose must contain finite numbers")
		}
		*target = value
	}
	if math.Abs(state.X) > 78 || math.Abs(state.Z) > 78 || math.Abs(state.Yaw) > math.Pi+0.000001 || state.Speed < -6 || state.Speed > vehicleMaxSpeeds[id] || math.Abs(state.Steer) > 0.58+0.000001 {
		return VehicleState{}, errors.New("vehicle pose is outside driving limits")
	}
	return state, nil
}

func (h *Hub) vehiclesSnapshot() []VehicleState {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return append([]VehicleState(nil), h.vehicles[:]...)
}

func (h *Hub) sendVehiclesState(c *client) {
	if payload, err := json.Marshal(map[string]any{"type": "event", "name": "vehicle-state", "data": h.vehiclesSnapshot()}); err == nil {
		c.enqueue(payload)
	}
}

func (h *Hub) vehicleCommand(c *client, command string, args map[string]any) (VehicleState, error) {
	if c.user == nil || c.user.Role != RoleOwner && c.user.Role != RoleMember {
		return VehicleState{}, errReadOnly
	}
	id, err := vehicleID(args)
	if err != nil {
		return VehicleState{}, err
	}
	var next VehicleState
	var sequence uint64
	_, finalPose := args["pose"]
	if command == "vehicle_move" || command == "vehicle_exit" && finalPose {
		if next, err = vehiclePose(args, id); err != nil {
			return VehicleState{}, err
		}
	}
	if command == "vehicle_move" {
		seq, valid := args["seq"].(float64)
		if !valid || math.IsNaN(seq) || math.IsInf(seq, 0) || seq < 1 || seq > 9007199254740991 || seq != math.Trunc(seq) {
			return VehicleState{}, errors.New("vehicle move sequence required")
		}
		sequence = uint64(seq)
	}
	now := time.Now()
	h.mu.Lock()
	if h.clients[c.id] != c {
		h.mu.Unlock()
		return VehicleState{}, errors.New("connection is no longer in the office")
	}
	state := h.vehicles[id]
	switch command {
	case "vehicle_enter":
		if state.Driver != "" && state.Driver != c.id {
			h.mu.Unlock()
			return VehicleState{}, errors.New("vehicle is already occupied")
		}
		for _, other := range h.vehicles {
			if other.ID != id && other.Driver == c.id {
				h.mu.Unlock()
				return VehicleState{}, errors.New("already driving another vehicle")
			}
		}
		if state.Driver == c.id {
			h.mu.Unlock()
			return state, nil
		}
		state.Driver, state.Speed, state.Steer = c.id, 0, 0
		if arrival, _ := args["arrival"].(bool); arrival {
			state.X, state.Z, state.Yaw = -54-float64(id)*5, 20.3, math.Pi/2
		}
		h.vehicleSequences[id] = 0
		h.vehicleMovedAt[id] = now
	case "vehicle_move":
		if state.Driver != c.id {
			h.mu.Unlock()
			return VehicleState{}, errors.New("vehicle is not owned by this connection")
		}
		if sequence <= h.vehicleSequences[id] {
			h.mu.Unlock()
			return VehicleState{}, errors.New("vehicle move sequence is stale")
		}
		allowed := vehicleMaxSpeeds[id]*now.Sub(h.vehicleMovedAt[id]).Seconds() + 0.75
		if math.Hypot(next.X-state.X, next.Z-state.Z) > allowed {
			h.mu.Unlock()
			return VehicleState{}, errors.New("vehicle moved faster than its driving limit")
		}
		next.Driver, next.Revision = c.id, state.Revision
		state = next
		h.vehicleSequences[id] = sequence
		h.vehicleMovedAt[id] = now
	case "vehicle_exit":
		if state.Driver != c.id {
			h.mu.Unlock()
			return VehicleState{}, errors.New("vehicle is not owned by this connection")
		}
		if finalPose {
			if math.Hypot(next.X-state.X, next.Z-state.Z) > vehicleMaxSpeeds[id]*now.Sub(h.vehicleMovedAt[id]).Seconds()+0.75 {
				h.mu.Unlock()
				return VehicleState{}, errors.New("vehicle moved faster than its driving limit")
			}
			next.Revision = state.Revision
			state = next
		}
		state.Driver, state.Speed, state.Steer = "", 0, 0
		h.vehicleSequences[id] = 0
	default:
		h.mu.Unlock()
		return VehicleState{}, errors.New("unknown vehicle command")
	}
	state.Revision++
	h.vehicles[id] = state
	h.mu.Unlock()
	h.Send("vehicle-state", h.vehiclesSnapshot())
	return state, nil
}

func (h *Hub) releaseVehiclesLocked(connectionID string) bool {
	changed := false
	for id := range h.vehicles {
		if h.vehicles[id].Driver == connectionID {
			h.vehicles[id].Driver, h.vehicles[id].Speed, h.vehicles[id].Steer = "", 0, 0
			h.vehicles[id].Revision++
			h.vehicleSequences[id] = 0
			changed = true
		}
	}
	return changed
}
