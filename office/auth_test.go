package office

import (
	"testing"
	"time"
)

func TestGuestApprovalRequiresMatchingRequest(t *testing.T) {
	store := &AuthStore{
		users: map[string]*User{
			"owner": {Username: "owner", Role: RoleOwner, Approved: true},
			"guest": {Username: "guest", Role: RoleGuest, Approved: true},
		},
		sessions: map[string]*Session{
			"owner-token": {Token: "owner-token", Username: "owner", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()},
			"guest-token": {Token: "guest-token", Username: "guest", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()},
		},
	}
	for _, attempt := range []struct{ name, token string }{{"owner", "owner-token"}, {"owner", "guest-token"}, {"guest", "owner-token"}, {"guest", ""}} {
		if _, _, approved := store.GuestApproved(attempt.name, attempt.token); approved {
			t.Fatalf("unexpected approval for %s with %s", attempt.name, attempt.token)
		}
	}
	user, session, approved := store.GuestApproved("guest", "guest-token")
	if !approved || user.Username != "guest" || session.Token != "guest-token" {
		t.Fatal("valid guest request was rejected")
	}
}
