package api

import (
	"encoding/json"

	"memoryz/server/internal/store"
)

// Privacy is what a student lets linked parents see.
type Privacy struct {
	Accuracy   bool `json:"accuracy"`
	Time       bool `json:"time"`
	WrongNotes bool `json:"wrongNotes"`
}

// Profile is the account as the client sees it (contracts.ts Profile).
type Profile struct {
	OnboardingRequired bool     `json:"onboardingRequired"`
	ID                 string   `json:"id"`
	AvatarURL          string   `json:"avatarUrl,omitempty"`
	Name               string   `json:"name"`
	Nickname           string   `json:"nickname"`
	Role               string   `json:"role"`
	School             string   `json:"school"`
	Grade              string   `json:"grade"`
	Streak             int32    `json:"streak"`
	Points             int32    `json:"points"`
	Privacy            Privacy  `json:"privacy"`
	CompletedSubjects  []string `json:"completedSubjects"`
	SrsMode            string   `json:"srsMode"`
	DesiredRetention   float64  `json:"desiredRetention"`
}

// privacyOf reads the stored JSON; only an explicit true counts, as before.
func privacyOf(raw []byte) Privacy {
	var value map[string]any
	_ = json.Unmarshal(raw, &value)
	flag := func(key string) bool {
		v, ok := value[key].(bool)
		return ok && v
	}
	return Privacy{Accuracy: flag("accuracy"), Time: flag("time"), WrongNotes: flag("wrongNotes")}
}

// profileOf projects a user row.
func profileOf(u store.User) Profile {
	completed := u.CompletedSubjects
	if completed == nil {
		completed = []string{}
	}
	mode := "FIXED"
	if u.SrsMode == "FSRS" {
		mode = "FSRS"
	}
	return Profile{
		ID: u.ID, Name: u.Name, Nickname: u.Nickname, Role: string(u.Role), School: u.School, Grade: u.Grade,
		Streak: u.Streak, Points: u.Points, Privacy: privacyOf(u.Privacy), CompletedSubjects: completed,
		SrsMode: mode, DesiredRetention: u.DesiredRetention,
	}
}
