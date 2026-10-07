package office

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type OfficeState struct {
	LightsOn     bool               `json:"lightsOn"`
	LightRows    [3]bool            `json:"lightRows"`
	StickyNotes  [13]string         `json:"stickyNotes"`
	BreakroomOn  bool               `json:"breakroomOn"`
	BlindStage   int                `json:"blindStage"`
	BlindStages  map[string]int     `json:"blindStages"`
	Season       string             `json:"season"`
	WallArt      []WallArtPlacement `json:"wallArt"`
	OfficeClosed bool               `json:"officeClosed"`
}

func (a *App) officeStatePath() string { return filepath.Join(a.dataDir(), "office.json") }

func (a *App) loadOfficeState() {
	data, err := os.ReadFile(a.officeStatePath())
	if err != nil {
		return
	}
	state := OfficeState{LightsOn: true, LightRows: [3]bool{true, true, true}, BreakroomOn: true, BlindStages: map[string]int{}, Season: "auto", WallArt: []WallArtPlacement{}}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(data, &fields)
	if json.Unmarshal(data, &state) == nil && state.BlindStage >= 0 && state.BlindStage <= 2 {
		if _, hasRows := fields["lightRows"]; !hasRows {
			state.LightRows = [3]bool{state.LightsOn, state.LightsOn, state.LightsOn}
		}
		if state.BlindStages == nil {
			state.BlindStages = map[string]int{}
		}
		for id, stage := range state.BlindStages {
			if !validBlindID(id) || stage < 0 || stage > 2 {
				delete(state.BlindStages, id)
			}
		}
		if !validSeason(state.Season) {
			state.Season = "auto"
		}
		if state.WallArt == nil {
			state.WallArt = []WallArtPlacement{}
		}
		if err := validateWallArt(state.WallArt); err != nil {
			state.WallArt = []WallArtPlacement{}
		}
		a.officeState = state
	}
}

func (a *App) OfficeStateGet() OfficeState {
	a.officeMu.RLock()
	defer a.officeMu.RUnlock()
	return a.officeState
}

func (a *App) OfficeStateSet(args map[string]any) (OfficeState, error) {
	a.officeMu.Lock()
	defer a.officeMu.Unlock()
	state := a.officeState
	changed := false
	if value, ok := args["lightsOn"]; ok {
		on, valid := value.(bool)
		if !valid {
			return state, errors.New("lightsOn must be a boolean")
		}
		state.LightsOn = on
		state.LightRows = [3]bool{on, on, on}
		changed = true
	}
	if value, ok := args["lightRows"]; ok {
		rows, valid := value.([]any)
		if !valid || len(rows) != len(state.LightRows) {
			return state, errors.New("lightRows must contain three booleans")
		}
		for i, value := range rows {
			on, valid := value.(bool)
			if !valid {
				return state, errors.New("lightRows must contain three booleans")
			}
			state.LightRows[i] = on
		}
		state.LightsOn = state.LightRows[0] || state.LightRows[1] || state.LightRows[2]
		changed = true
	}
	if value, ok := args["stickyNotes"]; ok {
		notes, valid := value.([]any)
		if !valid || len(notes) != len(state.StickyNotes) {
			return state, errors.New("stickyNotes must contain thirteen strings")
		}
		for i, value := range notes {
			note, valid := value.(string)
			if !valid || len(note) > 60*1024 {
				return state, errors.New("sticky note data exceeds 60 KB")
			}
			state.StickyNotes[i] = note
		}
		changed = true
	}
	if value, ok := args["breakroomOn"]; ok {
		on, valid := value.(bool)
		if !valid {
			return state, errors.New("breakroomOn must be a boolean")
		}
		state.BreakroomOn = on
		changed = true
	}
	if value, ok := args["blindStage"]; ok {
		stage, valid := value.(float64)
		if !valid || stage < 0 || stage > 2 || stage != float64(int(stage)) {
			return state, errors.New("blindStage must be 0, 1, or 2")
		}
		state.BlindStage = int(stage)
		state.BlindStages = map[string]int{}
		changed = true
	}
	if _, ok := args["blindStages"]; ok {
		var stages map[string]int
		if err := decodeArgValue(args, "blindStages", &stages); err != nil || len(stages) > 64 {
			return state, errors.New("blindStages must contain at most sixty-four window stages")
		}
		for id, stage := range stages {
			if !validBlindID(id) || stage < 0 || stage > 2 {
				return state, errors.New("blind stages require a window id and a stage from 0 to 2")
			}
		}
		state.BlindStages = stages
		changed = true
	}
	if value, ok := args["season"]; ok {
		season, valid := value.(string)
		if !valid || !validSeason(season) {
			return state, errors.New("season must be auto, spring, summer, autumn, or winter")
		}
		state.Season = season
		changed = true
	}
	if _, ok := args["wallArt"]; ok {
		var art []WallArtPlacement
		if err := decodeArgValue(args, "wallArt", &art); err != nil {
			return state, err
		}
		if err := validateWallArt(art); err != nil {
			return state, err
		}
		state.WallArt = art
		changed = true
	}
	if value, ok := args["officeClosed"]; ok {
		closed, valid := value.(bool)
		if !valid {
			return state, errors.New("officeClosed must be a boolean")
		}
		state.OfficeClosed = closed
		changed = true
	}
	if !changed {
		return state, errors.New("office control value required")
	}
	if err := writeJSONFile(a.officeStatePath(), state); err != nil {
		return a.officeState, err
	}
	a.officeState = state
	return state, nil
}
