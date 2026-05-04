package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestShouldRedirectRootRequest(t *testing.T) {
	tests := []struct {
		name         string
		method       string
		path         string
		accept       string
		redirectPath string
		want         bool
	}{
		{name: "browser root", method: http.MethodGet, path: "/", accept: "text/html", redirectPath: "/workspace/session", want: true},
		{name: "head root", method: http.MethodHead, path: "/", accept: "text/html", redirectPath: "/workspace/session", want: true},
		{name: "api root", method: http.MethodPost, path: "/", accept: "application/json", redirectPath: "/workspace/session", want: false},
		{name: "non root", method: http.MethodGet, path: "/session", accept: "text/html", redirectPath: "/workspace/session", want: false},
		{name: "disabled", method: http.MethodGet, path: "/", accept: "text/html", redirectPath: "", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			if tt.accept != "" {
				req.Header.Set("Accept", tt.accept)
			}
			if got := shouldRedirectRootRequest(req, tt.redirectPath); got != tt.want {
				t.Fatalf("shouldRedirectRootRequest() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestInjectUIAssets(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	resp := &http.Response{
		Request:       req,
		Header:        make(http.Header),
		Body:          io.NopCloser(strings.NewReader("<html><head><title>x</title></head><body></body></html>")),
		ContentLength: -1,
	}
	resp.Header.Set("Content-Type", "text/html; charset=utf-8")

	if err := injectUIAssets(resp); err != nil {
		t.Fatalf("injectUIAssets() error = %v", err)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read injected body: %v", err)
	}
	html := string(body)
	if !strings.Contains(html, "/__opencode-plus/drawer.css") || !strings.Contains(html, "/__opencode-plus/drawer.js") {
		t.Fatalf("injected html missing drawer assets: %s", html)
	}
	if !strings.Contains(html, "</head>") || strings.Index(html, "/__opencode-plus/drawer.js") > strings.Index(html, "</head>") {
		t.Fatalf("assets were not injected before closing head: %s", html)
	}
}

func TestAuthStatePersistsCloudflareAuthToggle(t *testing.T) {
	stateFile := filepath.Join(t.TempDir(), "auth-state.json")
	state := newAuthState(config{AuthStateFile: stateFile})
	if !state.cloudflareAuthEnabled() {
		t.Fatal("Cloudflare auth should default to enabled")
	}
	if err := state.setCloudflareAuthEnabled(false); err != nil {
		t.Fatalf("setCloudflareAuthEnabled(false): %v", err)
	}

	reloaded := newAuthState(config{AuthStateFile: stateFile})
	if reloaded.cloudflareAuthEnabled() {
		t.Fatal("persisted Cloudflare auth state was not loaded")
	}
}

func TestAuthHandlerUpdatesCloudflareAuthWithoutChangingLocalAuth(t *testing.T) {
	state := &authState{cfAuthEnabled: false}
	cfg := config{BasicAuthValue: "Basic dXNlcjpwYXNz"}
	req := httptest.NewRequest(http.MethodPost, "/__opencode-plus/auth", strings.NewReader(`{"cloudflare_auth_enabled":true}`))
	rec := httptest.NewRecorder()

	authHandler(state, cfg, &jwksCache{}).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("authHandler status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !state.cloudflareAuthEnabled() {
		t.Fatal("Cloudflare auth was not enabled")
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["can_disable_local_auth"] != false {
		t.Fatalf("can_disable_local_auth = %v, want false", body["can_disable_local_auth"])
	}
	if body["local_auth_configured"] != true {
		t.Fatalf("local_auth_configured = %v, want true", body["local_auth_configured"])
	}
}
