package nativehook

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The CLI moved its config to $CAVEMAN_HOME/cloud.json; the hook must follow,
// or `think.mode=record` written there is ignored and compression keeps running.
func TestConfiguredModeReadsTheNewConfigHomeFirst(t *testing.T) {
	user := t.TempDir()
	t.Setenv("HOME", user)
	home := filepath.Join(user, ".caveman")
	write := func(path, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	legacy := filepath.Join(user, ".caveman-cloud", "config.json")
	current := filepath.Join(home, "cloud.json")

	if got := configuredMode(home); got != "compress" {
		t.Fatalf("no config: got %q, want compress", got)
	}
	write(legacy, `{"think":{"mode":"record"}}`)
	if got := configuredMode(home); got != "record" {
		t.Fatalf("old config only: got %q, want record", got)
	}
	write(current, `{"think":{"mode":"pixel"}}`)
	if got := configuredMode(home); got != "pixel" {
		t.Fatalf("new config wins over the old one: got %q, want pixel", got)
	}
	write(current, `{"think":{"mode":"record"}}`)
	write(legacy, `{"think":{"mode":"compress"}}`)
	if got := configuredMode(home); got != "record" {
		t.Fatalf("record in the new config: got %q, want record", got)
	}
}

func TestAntigravityNormalizationAndPreToolRequest(t *testing.T) {
	if !validAgent("antigravity") {
		t.Fatal("expected antigravity to be a valid agent")
	}
	if got := normalizeEvent("antigravity", "PreInvocation"); got != "UserPromptSubmit" {
		t.Fatalf("normalizeEvent PreInvocation = %q, want UserPromptSubmit", got)
	}
	if !toolNeedsRepositoryState("run_command", map[string]any{"CommandLine": "go test ./..."}) {
		t.Fatal("expected CommandLine go test to require repository state")
	}

	home := t.TempDir()
	workspace := t.TempDir()
	sample := filepath.Join(workspace, "sample.txt")
	if err := os.WriteFile(sample, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	event := hostEvent{
		"hookEventName":  "PreToolUse",
		"conversationId": "conv-123",
		"workspacePaths": []any{workspace},
		"toolCall": map[string]any{
			"id":   "tc-1",
			"name": "read_file",
			"args": map[string]any{"Path": "sample.txt"},
		},
	}
	req := preToolRequest(context.Background(), home, "antigravity", "PreToolUse", "conv-123", event)
	if req.Session.ID != "antigravity:conv-123" {
		t.Fatalf("Session.ID = %q, want antigravity:conv-123", req.Session.ID)
	}
	if req.Tool == nil || req.Tool.Name != "read_file" {
		t.Fatalf("Tool = %+v, want read_file", req.Tool)
	}
	if !strings.HasPrefix(req.Tool.InputState, "sha256:") {
		t.Fatalf("Tool.InputState = %q, want sha256 prefix", req.Tool.InputState)
	}
}
