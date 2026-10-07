package office

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type WhiteboardPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type WhiteboardStroke struct {
	ID     string           `json:"id"`
	Points []WhiteboardPoint `json:"points"`
	Color  string           `json:"color"`
	Width  float64          `json:"width"`
	Tool   string           `json:"tool"`
}

const whiteboardByteLimit = 4 << 20

func (a *App) whiteboardPath() string {
	return filepath.Join(a.dataDir(), "whiteboard.json")
}

func (a *App) WhiteboardGet() ([]WhiteboardStroke, error) {
	data, err := os.ReadFile(a.whiteboardPath())
	if err != nil {
		if os.IsNotExist(err) {
			return []WhiteboardStroke{}, nil
		}
		return nil, err
	}
	var strokes []WhiteboardStroke
	if err := json.Unmarshal(data, &strokes); err != nil {
		return []WhiteboardStroke{}, nil
	}
	return strokes, nil
}

func (a *App) WhiteboardSave(strokes []WhiteboardStroke) error {
	cleaned := make([]WhiteboardStroke, 0, len(strokes))
	for _, stroke := range strokes {
		if len(stroke.Points) == 0 {
			continue
		}
		points := make([]WhiteboardPoint, 0, len(stroke.Points))
		for _, point := range stroke.Points {
			if point.X < -0.05 || point.X > 1.05 || point.Y < -0.05 || point.Y > 1.05 {
				continue
			}
			points = append(points, point)
		}
		if len(points) == 0 {
			continue
		}
		if stroke.Tool != "eraser" {
			stroke.Tool = "pen"
		}
		if stroke.Width <= 0 {
			stroke.Width = 0.004
		}
		if stroke.ID == "" {
			stroke.ID = randomID()
		}
		if stroke.Color == "" {
			stroke.Color = "#1b2430"
		}
		cleaned = append(cleaned, WhiteboardStroke{ID: stroke.ID, Points: points, Color: stroke.Color, Width: stroke.Width, Tool: stroke.Tool})
	}
	data, err := json.Marshal(cleaned)
	if err != nil {
		return err
	}
	if len(data) > whiteboardByteLimit {
		return fmt.Errorf("whiteboard is too large to save (%d bytes); clear some of it", len(data))
	}
	return os.WriteFile(a.whiteboardPath(), data, 0o600)
}

func (a *App) WhiteboardClear() error {
	if err := os.Remove(a.whiteboardPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func isWhiteboardCommand(command string) bool {
	return strings.HasPrefix(command, "whiteboard_")
}
