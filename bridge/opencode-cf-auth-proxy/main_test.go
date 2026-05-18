package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestIsPTYConnectRequest(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "/pty/pty_123/connect-token", want: true},
		{path: "/pty/pty_123/connect", want: true},
		{path: "/pty/pty_123", want: false},
		{path: "/pty", want: false},
		{path: "/session/pty_123/connect", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := isPTYConnectRequest(tt.path); got != tt.want {
				t.Fatalf("isPTYConnectRequest(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestPrepareUpstreamRequestStripsPTYOriginHeadersOnlyForConnect(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/pty/pty_123/connect-token", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Authorization", "Bearer user-token")
	req.Header.Set("Cf-Access-Jwt-Assertion", "jwt")
	req.Header.Set("Cf-Access-Authenticated-User-Email", "user@example.com")
	req.Header.Set("Origin", "https://opencode2.crossmojonation.net")
	req.Header.Set("Referer", "https://opencode2.crossmojonation.net/session")

	prepareUpstreamRequest(req, config{BasicAuthValue: "Basic gateway-token"}, true)

	for _, header := range []string{"Accept-Encoding", "Cf-Access-Jwt-Assertion", "Cf-Access-Authenticated-User-Email", "Origin", "Referer"} {
		if got := req.Header.Get(header); got != "" {
			t.Fatalf("%s header = %q, want empty", header, got)
		}
	}
	if got := req.Header.Get("Authorization"); got != "Basic gateway-token" {
		t.Fatalf("Authorization header = %q, want gateway basic auth", got)
	}
}

func TestPrepareUpstreamRequestPreservesNormalOriginHeaders(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/pty", nil)
	req.Header.Set("Origin", "https://opencode2.crossmojonation.net")
	req.Header.Set("Referer", "https://opencode2.crossmojonation.net/session")
	req.Header.Set("Authorization", "Basic user-token")

	prepareUpstreamRequest(req, config{}, false)

	if got := req.Header.Get("Origin"); got != "https://opencode2.crossmojonation.net" {
		t.Fatalf("Origin header = %q, want preserved", got)
	}
	if got := req.Header.Get("Referer"); got != "https://opencode2.crossmojonation.net/session" {
		t.Fatalf("Referer header = %q, want preserved", got)
	}
	if got := req.Header.Get("Authorization"); got != "Basic user-token" {
		t.Fatalf("Authorization header = %q, want client basic auth", got)
	}
}

func TestCorsMiddlewareHandlesPreflight(t *testing.T) {
	called := false
	handler := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodOptions, "/global/health", nil)
	req.Header.Set("Origin", "https://opencode.crossmojonation.net")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if called {
		t.Fatal("next handler was called for preflight")
	}
	if got := rec.Code; got != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", got, http.StatusNoContent)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://opencode.crossmojonation.net" {
		t.Fatalf("Access-Control-Allow-Origin = %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Private-Network"); got != "true" {
		t.Fatalf("Access-Control-Allow-Private-Network = %q", got)
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

func TestMountPathValidationRequiresWorkspaceMountsChild(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}

	if err := validateMountPath(workspace, filepath.Join(workspace, "mounts", "nas")); err != nil {
		t.Fatalf("valid mount path rejected: %v", err)
	}
	if err := validateMountPath(workspace, filepath.Join(filepath.Dir(workspace), "outside")); err == nil {
		t.Fatal("outside mount path was accepted")
	}
	if err := validateMountPath("/root", "/root/mounts/nas"); err == nil {
		t.Fatal("broad workspace root was accepted")
	}
}

func TestBuildRcloneMountCommandUsesDriveFriendlyDefaults(t *testing.T) {
	cmd, cleanup, err := buildRcloneMountCommand(mountConfig{
		MountPath: filepath.Join(t.TempDir(), "gdrive"),
		Remote: map[string]string{
			"rclone_remote": "gdrive",
			"path":          "opencode-plus",
		},
	})
	if err != nil {
		t.Fatalf("buildRcloneMountCommand() error = %v", err)
	}
	if cleanup != nil {
		cleanup()
	}

	args := strings.Join(cmd.Args, "\n")
	for _, want := range []string{
		"mount\ngdrive:opencode-plus",
		"--vfs-cache-mode\nwrites",
		"--dir-cache-time\n5m",
		"--poll-interval\n1m",
		"--drive-pacer-min-sleep\n200ms",
		"--drive-pacer-burst\n10",
		"--tpslimit\n4",
		"--tpslimit-burst\n4",
		"--retries\n1",
		"--low-level-retries\n1",
	} {
		if !strings.Contains(args, want) {
			t.Fatalf("rclone args missing %q in %#v", want, cmd.Args)
		}
	}
}

func TestMountManagerCreateRedactsSecretsAndPersists(t *testing.T) {
	dir := t.TempDir()
	manager := newMountManager(config{MountsDir: dir})
	mount, err := manager.create(mountCreateRequest{
		Name:          "Remote Server",
		Type:          "ssh",
		WorkspaceRoot: filepath.Join(dir, "workspace"),
		MountName:     "remote-server",
		Remote: map[string]string{
			"host":     "example.test",
			"password": "should-redact",
		},
		Options: mountOptions{ReadOnly: true, AutoReconnect: true},
		Secret:  mountSecret{Username: "robert", Password: "secret"},
	})
	if err != nil {
		t.Fatalf("create mount: %v", err)
	}
	if mount["mount_path"] == "" {
		t.Fatalf("mount snapshot missing mount_path: %#v", mount)
	}
	remote, ok := mount["remote"].(map[string]string)
	if !ok {
		t.Fatalf("remote snapshot has unexpected type: %#v", mount["remote"])
	}
	if remote["password"] != "redacted" {
		t.Fatalf("remote password not redacted: %#v", remote)
	}
	if body, err := os.ReadFile(filepath.Join(dir, "config.json")); err != nil || strings.Contains(string(body), "secret") {
		t.Fatalf("config file read failed or contains secret: err=%v body=%s", err, string(body))
	}
}

func TestRetryAfterBacksOffAndCaps(t *testing.T) {
	first := retryAfter(1)
	second := retryAfter(2)
	late := retryAfter(20)
	if !second.After(first) {
		t.Fatalf("second retry should be after first: first=%s second=%s", first, second)
	}
	if timeUntil := time.Until(late); timeUntil > 31*time.Minute {
		t.Fatalf("retry cap exceeded: %s", timeUntil)
	}
}

func TestSyncDeploymentHeartbeatCreatesAndListsDeployment(t *testing.T) {
	var records []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/api/collections/opcp_deployments/records") {
			t.Fatalf("unexpected PocketBase path: %s", r.URL.Path)
		}
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{"items": records})
		case http.MethodPost:
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode create payload: %v", err)
			}
			payload["id"] = "rec1"
			payload["created"] = "2026-05-08 00:00:00.000Z"
			payload["updated"] = "2026-05-08 00:00:00.000Z"
			records = append(records, payload)
			writeJSON(w, http.StatusOK, payload)
		case http.MethodPatch:
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()

	cfg := config{
		SoulPBURL:          server.URL,
		DeploymentID:       "opencode-test",
		DeploymentName:     "OpenCode Test",
		DeploymentIDStable: true,
		SourceRepoDir:      t.TempDir(),
	}
	req := httptest.NewRequest(http.MethodGet, "https://opencode-test.example/__opencode-plus/soul/status", nil)
	result := syncDeploymentHeartbeat(cfg, req)
	if result["registered"] != true {
		t.Fatalf("registered = %v, result = %#v", result["registered"], result)
	}
	items, ok := result["items"].([]pocketBaseDeploymentRecord)
	if !ok || len(items) != 1 {
		t.Fatalf("items = %#v, want one deployment record", result["items"])
	}
	if items[0].DeploymentID != "opencode-test" || items[0].Name != "OpenCode Test" {
		t.Fatalf("deployment record mismatch: %#v", items[0])
	}
}
