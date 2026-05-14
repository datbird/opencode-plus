package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

//go:embed ui/*
var embeddedUI embed.FS

type config struct {
	ListenAddr          string
	UpstreamURL         string
	AllowedEmails       map[string]struct{}
	AccessAudience      string
	SkipAudience        bool
	BasicAuthValue      string
	TrustedIssuerSuffix string
	RootRedirectPath    string
	UIEnabled           bool
	UIAssetDir          string
	AuthStateFile       string
	QuotaURL            string
	SecretsDir          string
	ConfigFile          string
	OpenCodeConfigFile  string
	MountsDir           string
	SoulDBEnabled       bool
	SoulPBURL           string
	DeploymentID        string
	DeploymentName      string
	DeploymentIDStable  bool
	SourceRepoDir       string
}

type plusConfig struct {
	GeminiAuthSource    string `json:"gemini_auth_source"`
	OpenAIAuthSource    string `json:"openai_auth_source"`
	AnthropicAuthSource string `json:"anthropic_auth_source"`
}

type providerSecrets struct {
	OpenAI struct {
		AdminKey string `json:"adminKey,omitempty"`
	} `json:"openai,omitempty"`
	Anthropic struct {
		AdminKey string `json:"adminKey,omitempty"`
	} `json:"anthropic,omitempty"`
	OpenRouter struct {
		ManagementKey string `json:"managementKey,omitempty"`
	} `json:"openrouter,omitempty"`
	Gemini struct {
		OAuthCreds json.RawMessage `json:"oauthCreds,omitempty"`
	} `json:"gemini,omitempty"`
	XAI struct {
		ManagementKey string `json:"managementKey,omitempty"`
		TeamID        string `json:"teamId,omitempty"`
	} `json:"xai,omitempty"`
}

type encryptedVaultFile struct {
	Version    int    `json:"version"`
	Algorithm  string `json:"algorithm"`
	CreatedAt  string `json:"createdAt,omitempty"`
	UpdatedAt  string `json:"updatedAt"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type authState struct {
	mu            sync.RWMutex
	cfAuthEnabled bool
	stateFile     string
}

type authStateFile struct {
	CloudflareAuthEnabled bool `json:"cloudflare_auth_enabled"`
}

type updateStatus struct {
	mu         sync.RWMutex
	Running    bool   `json:"running"`
	Stage      string `json:"stage"`
	StartedAt  string `json:"started_at,omitempty"`
	EndedAt    string `json:"ended_at,omitempty"`
	Before     string `json:"before_version,omitempty"`
	Latest     string `json:"latest_version,omitempty"`
	After      string `json:"after_version,omitempty"`
	ReleaseURL string `json:"release_url,omitempty"`
	Changelog  string `json:"changelog,omitempty"`
	Error      string `json:"error,omitempty"`
	Log        string `json:"log,omitempty"`
}

var opencodeUpdate = &updateStatus{Stage: "idle"}

type accessClaims struct {
	Email string `json:"email"`
	jwt.RegisteredClaims
}

type jwksCache struct {
	mu      sync.Mutex
	issuer  string
	expires time.Time
	keys    map[string]*rsa.PublicKey
}

type jwksResponse struct {
	Keys []jwkKey `json:"keys"`
}

type jwkKey struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	upstream, err := url.Parse(cfg.UpstreamURL)
	if err != nil {
		log.Fatalf("invalid UPSTREAM_URL: %v", err)
	}

	cache := &jwksCache{}
	auth := newAuthState(cfg)
	mounts := newMountManager(cfg)
	mounts.Start()
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	originalDirector := proxy.Director
	proxy.Director = func(r *http.Request) {
		originalDirector(r)
		r.Host = upstream.Host
		prepareUpstreamRequest(r, cfg, auth.cloudflareAuthEnabled())
	}
	if cfg.UIEnabled {
		proxy.ModifyResponse = injectUIAssets
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		if wantsHTML(r) {
			writeRestartingPage(w, r, err)
			return
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"error":  "upstream_unreachable",
			"detail": err.Error(),
		})
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/__health", healthHandler(upstream))
	mux.HandleFunc("/__opencode-plus/health", plusHealthHandler(cfg, upstream))
	mux.HandleFunc("/__opencode-plus/auth", authHandler(auth, cfg, cache))
	mux.HandleFunc("/__opencode-plus/secrets/status", secretsStatusHandler(cfg))
	mux.HandleFunc("/__opencode-plus/secrets/key/generate", protectedHandler(auth, cfg, cache, secretsGenerateKeyHandler(cfg)))
	mux.HandleFunc("/__opencode-plus/secrets/key/regenerate", protectedHandler(auth, cfg, cache, secretsRegenerateKeyHandler(cfg)))
	mux.HandleFunc("/__opencode-plus/secrets/provider/openai", protectedHandler(auth, cfg, cache, secretsProviderHandler(cfg, "openai")))
	mux.HandleFunc("/__opencode-plus/secrets/provider/anthropic", protectedHandler(auth, cfg, cache, secretsProviderHandler(cfg, "anthropic")))
	mux.HandleFunc("/__opencode-plus/secrets/provider/openrouter", protectedHandler(auth, cfg, cache, secretsProviderHandler(cfg, "openrouter")))
	mux.HandleFunc("/__opencode-plus/secrets/provider/gemini", protectedHandler(auth, cfg, cache, secretsProviderHandler(cfg, "gemini")))
	mux.HandleFunc("/__opencode-plus/secrets/provider/xai", protectedHandler(auth, cfg, cache, secretsProviderHandler(cfg, "xai")))
	mux.HandleFunc("/__opencode-plus/config", configHandler(cfg))
	mux.HandleFunc("/__opencode-plus/soul/status", soulStatusHandler(cfg))
	mux.HandleFunc("/__opencode-plus/opencode/config", openCodeConfigHandler(cfg))
	mux.HandleFunc("/__opencode-plus/opencode/restart", protectedHandler(auth, cfg, cache, restartOpenCodeHandler()))
	mux.HandleFunc("/__opencode-plus/opencode/update/check", updateOpenCodeCheckHandler())
	mux.HandleFunc("/__opencode-plus/opencode/update", protectedHandler(auth, cfg, cache, updateOpenCodeHandler(cfg)))
	mux.HandleFunc("/__opencode-plus/opencode/update/status", updateOpenCodeStatusHandler())
	mux.HandleFunc("/__opencode-plus/mounts", protectedHandler(auth, cfg, cache, mounts.CollectionHandler()))
	mux.HandleFunc("/__opencode-plus/mounts/", protectedHandler(auth, cfg, cache, mounts.ItemHandler()))
	mux.HandleFunc("/__opencode-plus/quota", quotaHandler(cfg))
	mux.HandleFunc("/__opencode-plus/", uiAssetHandler(cfg))
	mux.HandleFunc("/assets/", uiAssetOverrideHandler(cfg, proxy))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/ghostty-vt.wasm") {
			if serveUIAsset(w, r, cfg, "ghostty-vt.wasm") {
				return
			}
		}
		if auth.cloudflareAuthEnabled() {
			email, err := validateAccessJWT(r.Context(), cfg, cache, r.Header.Get("Cf-Access-Jwt-Assertion"))
			if err != nil {
				log.Printf("access denied from %s: %v", r.RemoteAddr, err)
				writeJSON(w, http.StatusUnauthorized, map[string]string{
					"error":   "cloudflare_access_required",
					"message": "Cloudflare Access authentication is required or expired.",
				})
				return
			}
			if _, ok := cfg.AllowedEmails[strings.ToLower(email)]; !ok {
				log.Printf("access denied for email %q from %s", email, r.RemoteAddr)
				writeJSON(w, http.StatusForbidden, map[string]string{
					"error":   "cloudflare_access_forbidden",
					"message": "Cloudflare Access identity is not allowed for this OpenCode instance.",
				})
				return
			}
		}
		if shouldRedirectRootRequest(r, cfg.RootRedirectPath) {
			http.Redirect(w, r, cfg.RootRedirectPath, http.StatusFound)
			return
		}
		proxy.ServeHTTP(w, r)
	})

	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}

	log.Printf("opencode-cf-auth-proxy listening on %s, upstream %s", cfg.ListenAddr, cfg.UpstreamURL)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}
}

func isPTYConnectRequest(path string) bool {
	return strings.HasPrefix(path, "/pty/") && (strings.HasSuffix(path, "/connect-token") || strings.HasSuffix(path, "/connect"))
}

func prepareUpstreamRequest(r *http.Request, cfg config, cloudflareAuthEnabled bool) {
	r.Header.Del("Accept-Encoding")
	r.Header.Del("Authorization")
	r.Header.Del("Cf-Access-Jwt-Assertion")
	r.Header.Del("Cf-Access-Authenticated-User-Email")
	if isPTYConnectRequest(r.URL.Path) {
		// The public gateway is same-origin to the browser, but the private
		// upstream is 127.0.0.1. Avoid tripping OpenCode's origin check during
		// the PTY ticket/WebSocket handoff.
		r.Header.Del("Origin")
		r.Header.Del("Referer")
	}
	if cloudflareAuthEnabled {
		r.Header.Set("Authorization", cfg.BasicAuthValue)
	}
}

func loadConfig() (config, error) {
	cfg := config{
		ListenAddr:          env("LISTEN_ADDR", ":4097"),
		UpstreamURL:         env("UPSTREAM_URL", "http://127.0.0.1:4096"),
		AccessAudience:      strings.TrimSpace(os.Getenv("CF_ACCESS_AUD")),
		SkipAudience:        strings.EqualFold(os.Getenv("CF_ACCESS_SKIP_AUD"), "true"),
		TrustedIssuerSuffix: env("TRUSTED_CF_ISSUER_SUFFIX", ".cloudflareaccess.com"),
		RootRedirectPath:    env("OPENCODE_ROOT_REDIRECT_PATH", "/L2RhdGEvYWlwbGF5Z3JvdW5k/session"),
		UIEnabled:           envBool("OPENCODE_PLUS_UI_ENABLED", false),
		UIAssetDir:          strings.TrimSpace(os.Getenv("OPENCODE_PLUS_UI_ASSET_DIR")),
		AuthStateFile:       env("OPENCODE_PLUS_AUTH_STATE_FILE", "/config/persist/opencode-plus-auth-state.json"),
		QuotaURL:            env("OPENCODE_PLUS_QUOTA_URL", "http://127.0.0.1:18765/quota"),
		SecretsDir:          env("OPENCODE_PLUS_SECRETS_DIR", "/config/persist/opencode-plus-secrets"),
		ConfigFile:          env("OPENCODE_PLUS_CONFIG_FILE", "/config/persist/opencode-plus-config.json"),
		OpenCodeConfigFile:  env("OPENCODE_CONFIG_FILE", "/root/aiplayground/opencode.json"),
		MountsDir:           env("OPENCODE_PLUS_MOUNTS_DIR", "/config/persist/opencode-plus-mounts"),
		SoulDBEnabled:       envBool("OPENCODE_PLUS_SOUL_DB_ENABLED", true),
		SoulPBURL:           strings.TrimRight(env("OPENCODE_PLUS_SOUL_PB_URL", "http://pocketbase:8080"), "/"),
		DeploymentID:        env("OPENCODE_PLUS_DEPLOYMENT_ID", env("HOSTNAME", "opencode-plus")),
		DeploymentName:      env("OPENCODE_PLUS_DEPLOYMENT_NAME", env("HOSTNAME", "OpenCode Plus")),
		DeploymentIDStable:  strings.TrimSpace(os.Getenv("OPENCODE_PLUS_DEPLOYMENT_ID")) != "",
		SourceRepoDir:       env("OPENCODE_PLUS_SOURCE_REPO_DIR", "/root/gitrepos/opencode-ubuntu-container"),
	}

	allowed := strings.Split(os.Getenv("ALLOWED_EMAILS"), ",")
	cfg.AllowedEmails = make(map[string]struct{})
	for _, email := range allowed {
		email = strings.ToLower(strings.TrimSpace(email))
		if email != "" {
			cfg.AllowedEmails[email] = struct{}{}
		}
	}
	if len(cfg.AllowedEmails) == 0 {
		return cfg, errors.New("ALLOWED_EMAILS is required")
	}
	if cfg.AccessAudience == "" && !cfg.SkipAudience {
		return cfg, errors.New("CF_ACCESS_AUD is required unless CF_ACCESS_SKIP_AUD=true")
	}

	if b64 := strings.TrimSpace(os.Getenv("OPENCODE_BASIC_AUTH_B64")); b64 != "" {
		cfg.BasicAuthValue = "Basic " + b64
		return cfg, nil
	}
	user := os.Getenv("OPENCODE_BASIC_USER")
	pass := os.Getenv("OPENCODE_BASIC_PASSWORD")
	if user == "" || pass == "" {
		return cfg, errors.New("OPENCODE_BASIC_AUTH_B64 or OPENCODE_BASIC_USER/OPENCODE_BASIC_PASSWORD is required")
	}
	cfg.BasicAuthValue = "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
	return cfg, nil
}

func newAuthState(cfg config) *authState {
	state := &authState{
		cfAuthEnabled: true,
		stateFile:     strings.TrimSpace(cfg.AuthStateFile),
	}
	if state.stateFile == "" {
		return state
	}
	body, err := os.ReadFile(state.stateFile)
	if err != nil {
		return state
	}
	var persisted authStateFile
	if err := json.Unmarshal(body, &persisted); err == nil {
		state.cfAuthEnabled = persisted.CloudflareAuthEnabled
	}
	return state
}

func (s *authState) cloudflareAuthEnabled() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfAuthEnabled
}

func (s *authState) setCloudflareAuthEnabled(enabled bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cfAuthEnabled = enabled
	if s.stateFile == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.stateFile), 0o755); err != nil {
		return err
	}
	body, err := json.MarshalIndent(authStateFile{CloudflareAuthEnabled: enabled}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.stateFile, append(body, '\n'), 0o600)
}

func validateAccessJWT(ctx context.Context, cfg config, cache *jwksCache, raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", errors.New("missing Cf-Access-Jwt-Assertion")
	}

	var unverified accessClaims
	parser := jwt.NewParser()
	if _, _, err := parser.ParseUnverified(raw, &unverified); err != nil {
		return "", fmt.Errorf("invalid token shape: %w", err)
	}
	issuer := strings.TrimRight(unverified.Issuer, "/")
	if issuer == "" {
		return "", errors.New("missing issuer")
	}
	issuerURL, err := url.Parse(issuer)
	if err != nil || issuerURL.Scheme != "https" || !strings.HasSuffix(issuerURL.Hostname(), cfg.TrustedIssuerSuffix) {
		return "", fmt.Errorf("untrusted issuer %q", issuer)
	}

	keys, err := cache.getKeys(ctx, issuer)
	if err != nil {
		return "", err
	}

	claims := &accessClaims{}
	options := []jwt.ParserOption{jwt.WithValidMethods([]string{"RS256"}), jwt.WithIssuer(issuer)}
	if !cfg.SkipAudience {
		options = append(options, jwt.WithAudience(cfg.AccessAudience))
	}
	_, err = jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		kid, _ := token.Header["kid"].(string)
		if kid == "" {
			return nil, errors.New("missing key id")
		}
		key, ok := keys[kid]
		if !ok {
			return nil, fmt.Errorf("unknown key id %q", kid)
		}
		return key, nil
	}, options...)
	if err != nil {
		return "", fmt.Errorf("token verification failed: %w", err)
	}
	if claims.Email == "" {
		return "", errors.New("missing email claim")
	}
	return claims.Email, nil
}

func (c *jwksCache) getKeys(ctx context.Context, issuer string) (map[string]*rsa.PublicKey, error) {
	c.mu.Lock()
	if c.issuer == issuer && time.Now().Before(c.expires) && len(c.keys) > 0 {
		keys := c.keys
		c.mu.Unlock()
		return keys, nil
	}
	c.mu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, issuer+"/cdn-cgi/access/certs", nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch Cloudflare Access certs: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch Cloudflare Access certs: status %d", resp.StatusCode)
	}

	var jwks jwksResponse
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return nil, fmt.Errorf("decode Cloudflare Access certs: %w", err)
	}
	keys := make(map[string]*rsa.PublicKey)
	for _, jwk := range jwks.Keys {
		key, err := rsaKeyFromJWK(jwk)
		if err != nil {
			log.Printf("ignoring invalid jwk kid=%q: %v", jwk.Kid, err)
			continue
		}
		keys[jwk.Kid] = key
	}
	if len(keys) == 0 {
		return nil, errors.New("no usable Cloudflare Access certs")
	}

	c.mu.Lock()
	c.issuer = issuer
	c.keys = keys
	c.expires = time.Now().Add(6 * time.Hour)
	c.mu.Unlock()
	return keys, nil
}

func rsaKeyFromJWK(jwk jwkKey) (*rsa.PublicKey, error) {
	if jwk.Kty != "RSA" || jwk.Kid == "" || jwk.N == "" || jwk.E == "" {
		return nil, errors.New("unsupported jwk")
	}
	nBytes, err := base64.RawURLEncoding.DecodeString(jwk.N)
	if err != nil {
		return nil, fmt.Errorf("decode modulus: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(jwk.E)
	if err != nil {
		return nil, fmt.Errorf("decode exponent: %w", err)
	}
	e := 0
	for _, b := range eBytes {
		e = e<<8 + int(b)
	}
	if e == 0 {
		return nil, errors.New("empty exponent")
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: e}, nil
}

func healthHandler(upstream *url.URL) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, http.MethodHead, upstream.String(), nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "upstream": "unreachable", "error": err.Error()})
			return
		}
		resp.Body.Close()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upstream_status": resp.StatusCode})
	}
}

func shouldRedirectRootRequest(r *http.Request, redirectPath string) bool {
	if strings.TrimSpace(redirectPath) == "" || r.URL.Path != "/" {
		return false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	accept := r.Header.Get("Accept")
	return accept == "" || strings.Contains(accept, "text/html") || strings.Contains(accept, "*/*")
}

func wantsHTML(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if strings.HasPrefix(r.URL.Path, "/__opencode-plus/") || strings.HasPrefix(r.URL.Path, "/__health") {
		return false
	}
	accept := strings.ToLower(r.Header.Get("Accept"))
	return accept == "" || strings.Contains(accept, "text/html") || strings.Contains(accept, "*/*")
}

func writeRestartingPage(w http.ResponseWriter, r *http.Request, upstreamErr error) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	detail := "OpenCode is temporarily unavailable while the server process restarts. OpenCode Plus is still online."
	if upstreamErr != nil {
		detail = fmt.Sprintf("%s Upstream detail: %s", detail, upstreamErr.Error())
	}
	_, _ = fmt.Fprintf(w, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode Restarting</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { align-items: center; background: radial-gradient(circle at 35%% 15%%, rgba(53, 230, 208, 0.18), transparent 34%%), #0d0e0f; color: rgba(245, 245, 245, 0.92); display: flex; justify-content: center; margin: 0; min-height: 100vh; }
    main { background: linear-gradient(180deg, rgba(25, 27, 30, 0.96), rgba(13, 14, 15, 0.96)); border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 24px; box-shadow: 0 28px 90px rgba(0, 0, 0, 0.46); box-sizing: border-box; max-width: min(90vw, 520px); padding: 28px; text-align: center; }
    .spinner { animation: spin 900ms linear infinite; border: 3px solid rgba(255, 255, 255, 0.16); border-radius: 999px; border-top-color: #35e6d0; display: inline-block; height: 38px; margin-bottom: 18px; width: 38px; }
    h1 { font-size: clamp(24px, 5vw, 36px); line-height: 1.05; margin: 0 0 10px; }
    p { color: rgba(245, 245, 245, 0.64); font-size: 14px; line-height: 1.45; margin: 0; }
    small { color: rgba(245, 245, 245, 0.42); display: block; font-size: 11px; line-height: 1.35; margin-top: 16px; overflow-wrap: anywhere; }
    button { background: rgba(53, 230, 208, 0.12); border: 1px solid rgba(53, 230, 208, 0.28); border-radius: 999px; color: rgba(220, 255, 250, 0.94); cursor: pointer; font: inherit; font-size: 13px; margin-top: 18px; padding: 9px 14px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main>
    <span class="spinner" aria-hidden="true"></span>
    <h1>Restarting OpenCode</h1>
    <p id="status">OpenCode Plus is holding this page while the OpenCode server comes back.</p>
    <button type="button" onclick="location.reload()">Refresh now</button>
    <small>%s</small>
  </main>
  <script>
    const statusEl = document.getElementById('status');
    async function poll() {
      try {
        const response = await fetch('/__health', { cache: 'no-store' });
        if (response.ok) {
          const status = await response.json();
          if (status && status.ok) {
            statusEl.textContent = 'OpenCode is back. Refreshing...';
            setTimeout(() => location.reload(), 500);
            return;
          }
        }
      } catch {}
      setTimeout(poll, 1200);
    }
    poll();
  </script>
</body>
</html>`, htmlEscape(detail))
}

func htmlEscape(value string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")
	return replacer.Replace(value)
}

func plusHealthHandler(cfg config, upstream *url.URL) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":               true,
			"service":          "opencode-plus-ui-gateway",
			"ui_enabled":       cfg.UIEnabled,
			"external_ui":      cfg.UIAssetDir != "",
			"upstream_url":     upstream.String(),
			"opencode_version": currentOpenCodeVersion(),
			"support":          supportVersionInfo(cfg),
		})
	}
}

func soulStatusHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		features := map[string]any{
			"souls":           "not initialized",
			"skills":          "not initialized",
			"commands":        "not initialized",
			"tools":           "not initialized",
			"plugins_hooks":   "not initialized",
			"named_spaces":    "not initialized",
			"synced_projects": "not initialized",
		}
		status := map[string]any{
			"ok":                true,
			"enabled":           cfg.SoulDBEnabled,
			"ready":             false,
			"state":             mapBool(cfg.SoulDBEnabled, "checking", "disabled"),
			"schema_ready":      false,
			"named_space_count": 0,
			"deployment":        deploymentStatus(cfg, r),
			"pocketbase": map[string]any{
				"url":       cfg.SoulPBURL,
				"connected": false,
			},
			"features": features,
			"deployments": map[string]any{
				"registered": false,
				"items":      []any{},
			},
		}
		if !cfg.SoulDBEnabled {
			status["state"] = "disabled"
			writeJSON(w, http.StatusOK, status)
			return
		}

		connected, detail := checkPocketBaseHealth(cfg.SoulPBURL)
		schemaReady, schemaFeatures, namedSpaceCount := checkSoulSchema(cfg.SoulPBURL)
		status["ready"] = connected && schemaReady
		status["schema_ready"] = schemaReady
		status["named_space_count"] = namedSpaceCount
		if connected && schemaReady {
			status["state"] = "ready"
		} else if connected {
			status["state"] = "schema_missing"
		} else {
			status["state"] = "degraded"
		}
		status["features"] = schemaFeatures
		status["pocketbase"] = map[string]any{
			"url":       cfg.SoulPBURL,
			"connected": connected,
			"detail":    detail,
		}
		if connected && schemaReady {
			status["deployments"] = syncDeploymentHeartbeat(cfg, r)
		}
		writeJSON(w, http.StatusOK, status)
	}
}

func deploymentStatus(cfg config, r *http.Request) map[string]any {
	hostname, _ := os.Hostname()
	return map[string]any{
		"id":               cfg.DeploymentID,
		"name":             cfg.DeploymentName,
		"stable_identity":  cfg.DeploymentIDStable,
		"hostname":         hostname,
		"url":              requestBaseURL(r),
		"git_commit":       currentGitCommit(cfg.SourceRepoDir),
		"opencode_version": currentOpenCodeVersion(),
	}
}

type pocketBaseDeploymentRecord struct {
	ID           string         `json:"id"`
	DeploymentID string         `json:"deployment_id"`
	Name         string         `json:"name"`
	URL          string         `json:"url"`
	Enabled      bool           `json:"enabled"`
	Metadata     map[string]any `json:"metadata"`
	Created      string         `json:"created"`
	Updated      string         `json:"updated"`
}

func syncDeploymentHeartbeat(cfg config, r *http.Request) map[string]any {
	result := map[string]any{
		"registered": false,
		"items":      []pocketBaseDeploymentRecord{},
	}
	metadata := deploymentStatus(cfg, r)
	metadata["last_seen_at"] = time.Now().UTC().Format(time.RFC3339)
	payload := map[string]any{
		"deployment_id": cfg.DeploymentID,
		"name":          cfg.DeploymentName,
		"enabled":       true,
		"metadata":      metadata,
	}
	record, err := findPocketBaseDeployment(cfg.SoulPBURL, cfg.DeploymentID)
	if currentURL := requestBaseURL(r); currentURL != "" {
		payload["url"] = currentURL
		metadata["url"] = currentURL
	} else if isUsableInstanceURL(record.URL) {
		payload["url"] = record.URL
		metadata["url"] = record.URL
	} else {
		payload["url"] = ""
		metadata["url"] = ""
	}
	if err == nil && record.ID != "" {
		err = patchPocketBaseRecord(cfg.SoulPBURL, "opcp_deployments", record.ID, payload)
	} else if err == nil {
		err = createPocketBaseRecord(cfg.SoulPBURL, "opcp_deployments", payload)
	}
	if err != nil {
		result["error"] = err.Error()
		return result
	}
	result["registered"] = true
	items, err := listPocketBaseDeployments(cfg.SoulPBURL)
	if err != nil {
		result["error"] = err.Error()
		return result
	}
	result["items"] = items
	return result
}

func findPocketBaseDeployment(baseURL, deploymentID string) (pocketBaseDeploymentRecord, error) {
	query := url.Values{}
	query.Set("perPage", "1")
	query.Set("filter", fmt.Sprintf("deployment_id=%q", strings.ReplaceAll(deploymentID, `"`, `\"`)))
	var parsed struct {
		Items []pocketBaseDeploymentRecord `json:"items"`
	}
	if err := getPocketBaseJSON(baseURL, "opcp_deployments", query, &parsed); err != nil {
		return pocketBaseDeploymentRecord{}, err
	}
	if len(parsed.Items) == 0 {
		return pocketBaseDeploymentRecord{}, nil
	}
	return parsed.Items[0], nil
}

func listPocketBaseDeployments(baseURL string) ([]pocketBaseDeploymentRecord, error) {
	query := url.Values{}
	query.Set("perPage", "50")
	var parsed struct {
		Items []pocketBaseDeploymentRecord `json:"items"`
	}
	if err := getPocketBaseJSON(baseURL, "opcp_deployments", query, &parsed); err != nil {
		return nil, err
	}
	return parsed.Items, nil
}

func getPocketBaseJSON(baseURL, collection string, query url.Values, target any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	endpoint := strings.TrimRight(baseURL, "/") + "/api/collections/" + url.PathEscape(collection) + "/records"
	if encoded := query.Encode(); encoded != "" {
		endpoint += "?" + encoded
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("PocketBase %s list failed: HTTP %d %s", collection, res.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.Unmarshal(body, target)
}

func createPocketBaseRecord(baseURL, collection string, payload map[string]any) error {
	return writePocketBaseRecord(http.MethodPost, strings.TrimRight(baseURL, "/")+"/api/collections/"+url.PathEscape(collection)+"/records", payload)
}

func patchPocketBaseRecord(baseURL, collection, id string, payload map[string]any) error {
	return writePocketBaseRecord(http.MethodPatch, strings.TrimRight(baseURL, "/")+"/api/collections/"+url.PathEscape(collection)+"/records/"+url.PathEscape(id), payload)
}

func writePocketBaseRecord(method, endpoint string, payload map[string]any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	resBody, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("PocketBase write failed: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(resBody)))
	}
	return nil
}

func requestBaseURL(r *http.Request) string {
	if r == nil || r.Host == "" {
		return ""
	}
	hostname := r.Host
	if host, _, found := strings.Cut(r.Host, ":"); found {
		hostname = host
	}
	if hostname == "localhost" || hostname == "127.0.0.1" || r.Host == "[::1]" || r.Host == "[::1]:4097" {
		return ""
	}
	scheme := r.Header.Get("X-Forwarded-Proto")
	if scheme == "" {
		scheme = mapBool(r.TLS != nil, "https", "http")
	}
	return scheme + "://" + r.Host
}

func isUsableInstanceURL(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" {
		return false
	}
	hostname := parsed.Hostname()
	return hostname != "localhost" && hostname != "127.0.0.1" && hostname != "::1"
}

func currentGitCommit(repoDir string) string {
	repoDir = strings.TrimSpace(repoDir)
	if repoDir == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "git", "-C", repoDir, "rev-parse", "--short", "HEAD").CombinedOutput()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func checkSoulSchema(baseURL string) (bool, map[string]any, int) {
	collections := map[string]string{
		"souls":           "opcp_souls",
		"skills":          "opcp_assets",
		"commands":        "opcp_assets",
		"tools":           "opcp_assets",
		"plugins_hooks":   "opcp_assets",
		"named_spaces":    "opcp_named_spaces",
		"synced_projects": "opcp_synced_projects",
	}
	features := map[string]any{}
	ready := true
	for feature, collection := range collections {
		ok, _ := checkPocketBaseCollection(baseURL, collection)
		if ok {
			features[feature] = "initialized"
		} else {
			features[feature] = "not initialized"
			ready = false
		}
	}
	for _, collection := range []string{"opcp_deployments", "opcp_roles", "opcp_deployment_roles", "opcp_deployment_asset_overrides", "opcp_deployment_space_paths", "opcp_deployment_project_paths", "opcp_render_history"} {
		ok, _ := checkPocketBaseCollection(baseURL, collection)
		if !ok {
			ready = false
		}
	}
	namedSpaceCount := pocketBaseCollectionTotal(baseURL, "opcp_named_spaces")
	return ready, features, namedSpaceCount
}

func checkPocketBaseCollection(baseURL, collection string) (bool, string) {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	url := strings.TrimRight(baseURL, "/") + "/api/collections/" + url.PathEscape(collection) + "/records?perPage=1"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, err.Error()
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, err.Error()
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return false, fmt.Sprintf("HTTP %d %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	return true, strings.TrimSpace(string(body))
}

func pocketBaseCollectionTotal(baseURL, collection string) int {
	ok, body := checkPocketBaseCollection(baseURL, collection)
	if !ok {
		return 0
	}
	var parsed struct {
		TotalItems int `json:"totalItems"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return 0
	}
	return parsed.TotalItems
}

func checkPocketBaseHealth(baseURL string) (bool, string) {
	if strings.TrimSpace(baseURL) == "" {
		return false, "PocketBase URL is not configured"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/api/health", nil)
	if err != nil {
		return false, err.Error()
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, err.Error()
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
	detail := strings.TrimSpace(string(body))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return false, fmt.Sprintf("HTTP %d %s", res.StatusCode, detail)
	}
	if detail == "" {
		detail = "PocketBase health endpoint responded"
	}
	return true, detail
}

func supportVersionInfo(cfg config) []map[string]string {
	items := []struct {
		Name  string
		Cmd   string
		Args  []string
		Shell string
	}{
		{Name: "os", Shell: ". /etc/os-release 2>/dev/null && printf '%s %s' \"$NAME\" \"$VERSION_ID\""},
		{Name: "kernel", Cmd: "uname", Args: []string{"-srmo"}},
		{Name: "architecture", Cmd: "dpkg", Args: []string{"--print-architecture"}},
		{Name: "opencode", Cmd: "opencode", Args: []string{"--version"}},
		{Name: "bash", Cmd: "bash", Args: []string{"--version"}},
		{Name: "zsh", Cmd: "zsh", Args: []string{"--version"}},
		{Name: "fish", Cmd: "fish", Args: []string{"--version"}},
		{Name: "node", Cmd: "node", Args: []string{"--version"}},
		{Name: "npm", Cmd: "npm", Args: []string{"--version"}},
		{Name: "npm-global-packages", Shell: "npm list -g --depth=0 --json 2>/dev/null | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d);process.stdin.on(\"end\",()=>{const j=JSON.parse(s||\"{}\");console.log(Object.entries(j.dependencies||{}).map(([n,v])=>`${n}@${v.version||\"?\"}`).join(\", \"))})'"},
		{Name: "pnpm", Cmd: "pnpm", Args: []string{"--version"}},
		{Name: "corepack", Cmd: "corepack", Args: []string{"--version"}},
		{Name: "python3", Cmd: "python3", Args: []string{"--version"}},
		{Name: "pipx", Cmd: "pipx", Args: []string{"--version"}},
		{Name: "pipx-packages", Shell: "PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx list --short 2>/dev/null | paste -sd ', ' -"},
		{Name: "uv", Cmd: "uv", Args: []string{"--version"}},
		{Name: "deno", Cmd: "deno", Args: []string{"--version"}},
		{Name: "bun", Cmd: "bun", Args: []string{"--version"}},
		{Name: "go", Cmd: "go", Args: []string{"version"}},
		{Name: "rustc", Cmd: "rustc", Args: []string{"--version"}},
		{Name: "cargo", Cmd: "cargo", Args: []string{"--version"}},
		{Name: "java", Cmd: "java", Args: []string{"--version"}},
		{Name: "ruby", Cmd: "ruby", Args: []string{"--version"}},
		{Name: "perl", Cmd: "perl", Args: []string{"--version"}},
		{Name: "git", Cmd: "git", Args: []string{"--version"}},
		{Name: "git-lfs", Cmd: "git-lfs", Args: []string{"--version"}},
		{Name: "gh", Cmd: "gh", Args: []string{"--version"}},
		{Name: "docker", Cmd: "docker", Args: []string{"--version"}},
		{Name: "docker-compose", Cmd: "docker", Args: []string{"compose", "version"}},
		{Name: "devcontainer", Cmd: "devcontainer", Args: []string{"--version"}},
		{Name: "jq", Cmd: "jq", Args: []string{"--version"}},
		{Name: "yq", Cmd: "yq", Args: []string{"--version"}},
		{Name: "ripgrep", Cmd: "rg", Args: []string{"--version"}},
		{Name: "fd", Cmd: "fd", Args: []string{"--version"}},
		{Name: "fzf", Cmd: "fzf", Args: []string{"--version"}},
		{Name: "tmux", Cmd: "tmux", Args: []string{"-V"}},
		{Name: "screen", Cmd: "screen", Args: []string{"--version"}},
		{Name: "sqlite3", Cmd: "sqlite3", Args: []string{"--version"}},
		{Name: "openssl", Cmd: "openssl", Args: []string{"version"}},
		{Name: "curl", Cmd: "curl", Args: []string{"--version"}},
		{Name: "wget", Cmd: "wget", Args: []string{"--version"}},
		{Name: "rsync", Cmd: "rsync", Args: []string{"--version"}},
		{Name: "supervisorctl", Cmd: "supervisorctl", Args: []string{"version"}},
		{Name: "sshfs", Cmd: "sshfs", Args: []string{"-V"}},
		{Name: "sshpass", Cmd: "sshpass", Args: []string{"-V"}},
		{Name: "cloudflared", Cmd: "cloudflared", Args: []string{"--version"}},
		{Name: "1password-cli", Cmd: "op", Args: []string{"--version"}},
		{Name: "rclone", Cmd: "rclone", Args: []string{"version"}},
		{Name: "gcloud", Cmd: "gcloud", Args: []string{"--version"}},
		{Name: "kubectl", Cmd: "kubectl", Args: []string{"version", "--client=true"}},
		{Name: "terraform", Cmd: "terraform", Args: []string{"version"}},
		{Name: "helm", Cmd: "helm", Args: []string{"version", "--short"}},
		{Name: "ansible", Cmd: "ansible", Args: []string{"--version"}},
		{Name: "age", Cmd: "age", Args: []string{"--version"}},
		{Name: "sops", Cmd: "sops", Args: []string{"--version"}},
		{Name: "restic", Cmd: "restic", Args: []string{"version"}},
		{Name: "syncthing", Cmd: "syncthing", Args: []string{"--version"}},
		{Name: "ruff", Cmd: "ruff", Args: []string{"--version"}},
		{Name: "black", Cmd: "black", Args: []string{"--version"}},
		{Name: "mypy", Cmd: "mypy", Args: []string{"--version"}},
		{Name: "python-lsp-server", Cmd: "pylsp", Args: []string{"--version"}},
		{Name: "debugpy", Cmd: "debugpy", Args: []string{"--version"}},
		{Name: "eslint", Cmd: "eslint", Args: []string{"--version"}},
		{Name: "prettier", Cmd: "prettier", Args: []string{"--version"}},
		{Name: "typescript", Cmd: "tsc", Args: []string{"--version"}},
		{Name: "pyright", Cmd: "pyright", Args: []string{"--version"}},
		{Name: "gemini-cli", Cmd: "gemini", Args: []string{"--version"}},
		{Name: "firebase-tools", Cmd: "firebase", Args: []string{"--version"}},
		{Name: "wrangler", Cmd: "wrangler", Args: []string{"--version"}},
		{Name: "tailwindcss-language-server", Cmd: "tailwindcss-language-server", Args: []string{"--version"}},
		{Name: "bash-language-server", Cmd: "bash-language-server", Args: []string{"--version"}},
		{Name: "typescript-language-server", Cmd: "typescript-language-server", Args: []string{"--version"}},
		{Name: "yaml-language-server", Cmd: "yaml-language-server", Args: []string{"--version"}},
		{Name: "vscode-json-language-server", Cmd: "vscode-json-language-server", Args: []string{"--version"}},
		{Name: "shellcheck", Cmd: "shellcheck", Args: []string{"--version"}},
		{Name: "shfmt", Cmd: "shfmt", Args: []string{"--version"}},
		{Name: "editorconfig-checker", Cmd: "editorconfig-checker", Args: []string{"--version"}},
		{Name: "lazygit", Cmd: "lazygit", Args: []string{"--version"}},
		{Name: "helix", Cmd: "hx", Args: []string{"--version"}},
		{Name: "neovim", Cmd: "nvim", Args: []string{"--version"}},
		{Name: "emacs", Cmd: "emacs", Args: []string{"--version"}},
		{Name: "chromium", Cmd: "chromium", Args: []string{"--version"}},
		{Name: "ffmpeg", Cmd: "ffmpeg", Args: []string{"-version"}},
		{Name: "pandoc", Cmd: "pandoc", Args: []string{"--version"}},
		{Name: "imagemagick", Cmd: "convert", Args: []string{"--version"}},
		{Name: "graphicsmagick", Cmd: "gm", Args: []string{"version"}},
		{Name: "inkscape", Cmd: "inkscape", Args: []string{"--version"}},
		{Name: "tesseract", Cmd: "tesseract", Args: []string{"--version"}},
		{Name: "exiftool", Cmd: "exiftool", Args: []string{"-ver"}},
		{Name: "poppler-pdftotext", Cmd: "pdftotext", Args: []string{"-v"}},
		{Name: "qpdf", Cmd: "qpdf", Args: []string{"--version"}},
		{Name: "graphviz", Cmd: "dot", Args: []string{"-V"}},
		{Name: "plantuml", Cmd: "plantuml", Args: []string{"-version"}},
		{Name: "mermaid-cli", Cmd: "mmdc", Args: []string{"--version"}},
		{Name: "dropbox-cli", Cmd: "dropbox", Args: []string{"version"}},
	}
	versions := []map[string]string{
		{"name": "opencode-plus-ui-gateway", "version": "local Docker build"},
		{"name": "ui-assets", "version": mapBool(cfg.UIAssetDir != "", "external persisted assets", "embedded assets")},
	}
	for _, item := range items {
		version := ""
		if item.Shell != "" {
			version = commandVersionShell(item.Shell)
		} else {
			version = commandVersion(item.Cmd, item.Args...)
		}
		versions = append(versions, map[string]string{"name": item.Name, "version": version})
	}
	return versions
}

func mapBool(value bool, whenTrue, whenFalse string) string {
	if value {
		return whenTrue
	}
	return whenFalse
}

func commandVersion(name string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return "unavailable"
	}
	line := strings.TrimSpace(string(output))
	if line == "" {
		return "unknown"
	}
	line = strings.Split(line, "\n")[0]
	return shortenStatusLine(line, 300)
}

func commandVersionShell(script string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "bash", "-lc", script).CombinedOutput()
	if err != nil {
		return "unavailable"
	}
	line := strings.TrimSpace(string(output))
	if line == "" {
		return "unknown"
	}
	line = strings.Split(line, "\n")[0]
	return shortenStatusLine(line, 300)
}

func shortenStatusLine(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	return value[:max-3] + "..."
}

func authHandler(auth *authState, cfg config, cache *jwksCache) http.HandlerFunc {
	type authUpdate struct {
		CloudflareAuthEnabled *bool `json:"cloudflare_auth_enabled"`
	}
	writeStatus := func(w http.ResponseWriter) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":                       true,
			"cloudflare_auth_enabled":  auth.cloudflareAuthEnabled(),
			"local_auth_configured":    cfg.BasicAuthValue != "",
			"can_disable_local_auth":   false,
			"local_auth_change_policy": "Local OpenCode auth is never changed automatically by the Cloudflare Auth toggle.",
		})
	}
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			writeStatus(w)
		case http.MethodPost:
			if auth.cloudflareAuthEnabled() {
				email, err := validateAccessJWT(r.Context(), cfg, cache, r.Header.Get("Cf-Access-Jwt-Assertion"))
				if err != nil {
					writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "cloudflare_access_required"})
					return
				}
				if _, ok := cfg.AllowedEmails[strings.ToLower(email)]; !ok {
					writeJSON(w, http.StatusForbidden, map[string]string{"error": "cloudflare_access_forbidden"})
					return
				}
			}
			defer r.Body.Close()
			var update authUpdate
			if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&update); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
				return
			}
			if update.CloudflareAuthEnabled == nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cloudflare_auth_enabled_required"})
				return
			}
			if err := auth.setCloudflareAuthEnabled(*update.CloudflareAuthEnabled); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "persist_auth_state_failed", "detail": err.Error()})
				return
			}
			writeStatus(w)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

func protectedHandler(auth *authState, cfg config, cache *jwksCache, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if auth.cloudflareAuthEnabled() {
			email, err := validateAccessJWT(r.Context(), cfg, cache, r.Header.Get("Cf-Access-Jwt-Assertion"))
			if err != nil {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "cloudflare_access_required"})
				return
			}
			if _, ok := cfg.AllowedEmails[strings.ToLower(email)]; !ok {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "cloudflare_access_forbidden"})
				return
			}
		}
		next(w, r)
	}
}

func secretsStatusHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		keyExists := secretsKeyExists(cfg)
		status := map[string]any{
			"ok":         true,
			"key_exists": keyExists,
			"providers": map[string]any{
				"openai":     map[string]bool{"configured": false},
				"anthropic":  map[string]bool{"configured": false},
				"openrouter": map[string]bool{"configured": false},
				"gemini":     map[string]bool{"configured": false},
				"xai":        map[string]bool{"configured": false},
			},
		}
		if keyExists {
			if secrets, err := readProviderSecrets(cfg); err == nil {
				status["providers"] = map[string]any{
					"openai":     map[string]bool{"configured": strings.TrimSpace(secrets.OpenAI.AdminKey) != ""},
					"anthropic":  map[string]bool{"configured": strings.TrimSpace(secrets.Anthropic.AdminKey) != ""},
					"openrouter": map[string]bool{"configured": strings.TrimSpace(secrets.OpenRouter.ManagementKey) != ""},
					"gemini":     map[string]bool{"configured": len(secrets.Gemini.OAuthCreds) > 0},
					"xai":        map[string]bool{"configured": strings.TrimSpace(secrets.XAI.ManagementKey) != ""},
				}
			} else if !errors.Is(err, os.ErrNotExist) {
				status["error"] = "vault_read_failed"
			}
		}
		writeJSON(w, http.StatusOK, status)
	}
}

func secretsGenerateKeyHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if secretsKeyExists(cfg) {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "key_exists": true, "created": false})
			return
		}
		if err := writeNewSecretsKey(cfg); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "key_generation_failed", "detail": err.Error()})
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "key_exists": true, "created": true})
	}
}

func secretsRegenerateKeyHandler(cfg config) http.HandlerFunc {
	type regenerateRequest struct {
		ConfirmWipe bool `json:"confirm_wipe"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		defer r.Body.Close()
		var body regenerateRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
			return
		}
		if !body.ConfirmWipe {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "confirm_wipe_required"})
			return
		}
		if err := writeNewSecretsKey(cfg); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "key_generation_failed", "detail": err.Error()})
			return
		}
		if err := os.Remove(secretsVaultPath(cfg)); err != nil && !errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "vault_wipe_failed", "detail": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "key_exists": true, "vault_wiped": true})
	}
}

func writeNewSecretsKey(cfg config) error {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.SecretsDir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(secretsKeyPath(cfg), []byte(base64.StdEncoding.EncodeToString(key)+"\n"), 0o600)
}

func secretsProviderHandler(cfg config, provider string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		defer r.Body.Close()
		if !secretsKeyExists(cfg) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "encryption_key_required"})
			return
		}
		secrets, err := readProviderSecrets(cfg)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "vault_read_failed", "detail": err.Error()})
			return
		}

		switch provider {
		case "openai":
			var update struct {
				AdminKey string `json:"adminKey"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&update); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
				return
			}
			if strings.TrimSpace(update.AdminKey) == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "admin_key_required"})
				return
			}
			secrets.OpenAI.AdminKey = strings.TrimSpace(update.AdminKey)
		case "anthropic":
			var update struct {
				AdminKey string `json:"adminKey"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&update); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
				return
			}
			if strings.TrimSpace(update.AdminKey) == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "admin_key_required"})
				return
			}
			secrets.Anthropic.AdminKey = strings.TrimSpace(update.AdminKey)
		case "openrouter":
			var update struct {
				ManagementKey string `json:"managementKey"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&update); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
				return
			}
			if strings.TrimSpace(update.ManagementKey) == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "management_key_required"})
				return
			}
			secrets.OpenRouter.ManagementKey = strings.TrimSpace(update.ManagementKey)
		case "gemini":
			var update struct {
				OAuthCreds json.RawMessage `json:"oauthCreds"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 256<<10)).Decode(&update); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
				return
			}
			if !json.Valid(update.OAuthCreds) || len(update.OAuthCreds) == 0 || string(update.OAuthCreds) == "null" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "oauth_credentials_required"})
				return
			}
			secrets.Gemini.OAuthCreds = append(secrets.Gemini.OAuthCreds[:0], update.OAuthCreds...)
		case "xai":
			var update struct {
				ManagementKey string `json:"managementKey"`
				TeamID        string `json:"teamId"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&update); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
				return
			}
			if strings.TrimSpace(update.ManagementKey) == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "management_key_required"})
				return
			}
			secrets.XAI.ManagementKey = strings.TrimSpace(update.ManagementKey)
			secrets.XAI.TeamID = strings.TrimSpace(update.TeamID)
		default:
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown_provider"})
			return
		}

		if err := writeProviderSecrets(cfg, secrets); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "vault_write_failed", "detail": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "provider": provider, "configured": true})
	}
}

func secretsKeyPath(cfg config) string {
	return filepath.Join(cfg.SecretsDir, "master.key")
}

func secretsVaultPath(cfg config) string {
	return filepath.Join(cfg.SecretsDir, "providers.enc.json")
}

func secretsKeyExists(cfg config) bool {
	info, err := os.Stat(secretsKeyPath(cfg))
	return err == nil && !info.IsDir()
}

func readSecretsKey(cfg config) ([]byte, error) {
	body, err := os.ReadFile(secretsKeyPath(cfg))
	if err != nil {
		return nil, err
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(body)))
	if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("invalid key length %d", len(key))
	}
	return key, nil
}

func readProviderSecrets(cfg config) (providerSecrets, error) {
	var secrets providerSecrets
	key, err := readSecretsKey(cfg)
	if err != nil {
		return secrets, err
	}
	body, err := os.ReadFile(secretsVaultPath(cfg))
	if err != nil {
		return secrets, err
	}
	var vault encryptedVaultFile
	if err := json.Unmarshal(body, &vault); err != nil {
		return secrets, err
	}
	if vault.Version != 1 || vault.Algorithm != "AES-256-GCM" {
		return secrets, errors.New("unsupported vault format")
	}
	nonce, err := base64.StdEncoding.DecodeString(vault.Nonce)
	if err != nil {
		return secrets, err
	}
	ciphertext, err := base64.StdEncoding.DecodeString(vault.Ciphertext)
	if err != nil {
		return secrets, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return secrets, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return secrets, err
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return secrets, err
	}
	if err := json.Unmarshal(plaintext, &secrets); err != nil {
		return secrets, err
	}
	return secrets, nil
}

func writeProviderSecrets(cfg config, secrets providerSecrets) error {
	key, err := readSecretsKey(cfg)
	if err != nil {
		return err
	}
	plaintext, err := json.Marshal(secrets)
	if err != nil {
		return err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	createdAt := now
	if existing, err := os.ReadFile(secretsVaultPath(cfg)); err == nil {
		var existingVault encryptedVaultFile
		if json.Unmarshal(existing, &existingVault) == nil && existingVault.CreatedAt != "" {
			createdAt = existingVault.CreatedAt
		}
	}
	vault := encryptedVaultFile{
		Version:    1,
		Algorithm:  "AES-256-GCM",
		CreatedAt:  createdAt,
		UpdatedAt:  now,
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
		Ciphertext: base64.StdEncoding.EncodeToString(gcm.Seal(nil, nonce, plaintext, nil)),
	}
	body, err := json.MarshalIndent(vault, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.SecretsDir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(secretsVaultPath(cfg), append(body, '\n'), 0o600)
}

func configHandler(cfg config) http.HandlerFunc {
	type configUpdate struct {
		GeminiAuthSource    string `json:"gemini_auth_source"`
		OpenAIAuthSource    string `json:"openai_auth_source"`
		AnthropicAuthSource string `json:"anthropic_auth_source"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "config": readPlusConfig(cfg)})
		case http.MethodPost:
			defer r.Body.Close()
			var update configUpdate
			if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&update); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
				return
			}
			current := readPlusConfig(cfg)
			if update.GeminiAuthSource != "" {
				source := normalizeGeminiAuthSource(update.GeminiAuthSource)
				if source == "" {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_gemini_auth_source"})
					return
				}
				current.GeminiAuthSource = source
			}
			if update.OpenAIAuthSource != "" {
				source := normalizeOpenAIAuthSource(update.OpenAIAuthSource)
				if source == "" {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_openai_auth_source"})
					return
				}
				current.OpenAIAuthSource = source
			}
			if update.AnthropicAuthSource != "" {
				source := normalizeAnthropicAuthSource(update.AnthropicAuthSource)
				if source == "" {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_anthropic_auth_source"})
					return
				}
				current.AnthropicAuthSource = source
			}
			if err := writePlusConfig(cfg, current); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "config_write_failed", "detail": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "config": current})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

func openCodeConfigHandler(cfg config) http.HandlerFunc {
	type update struct {
		AutoAcceptPermissions *bool `json:"auto_accept_permissions"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			config, err := readOpenCodeConfig(cfg)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "opencode_config_read_failed", "detail": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "config": openCodeHiddenConfigStatus(cfg, config)})
		case http.MethodPost:
			defer r.Body.Close()
			var patch update
			if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&patch); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
				return
			}
			config, err := readOpenCodeConfig(cfg)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "opencode_config_read_failed", "detail": err.Error()})
				return
			}
			if patch.AutoAcceptPermissions != nil {
				if *patch.AutoAcceptPermissions {
					config["permission"] = "allow"
				} else if value, ok := config["permission"].(string); ok && value == "allow" {
					config["permission"] = map[string]any{"skill": map[string]any{"*": "allow"}}
				}
			}
			if err := writeOpenCodeConfig(cfg, config); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "opencode_config_write_failed", "detail": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "config": openCodeHiddenConfigStatus(cfg, config)})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

func readOpenCodeConfig(cfg config) (map[string]any, error) {
	body, err := os.ReadFile(cfg.OpenCodeConfigFile)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{"$schema": "https://opencode.ai/config.json"}, nil
		}
		return nil, err
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	return parsed, nil
}

func writeOpenCodeConfig(cfg config, next map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(cfg.OpenCodeConfigFile), 0o755); err != nil {
		return err
	}
	body, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(cfg.OpenCodeConfigFile, append(body, '\n'), 0o644)
}

func openCodeHiddenConfigStatus(cfg config, config map[string]any) map[string]any {
	autoAccept := false
	if value, ok := config["permission"].(string); ok && value == "allow" {
		autoAccept = true
	}
	return map[string]any{
		"auto_accept_permissions": autoAccept,
		"config_file":             cfg.OpenCodeConfigFile,
	}
}

func restartOpenCodeHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, "supervisorctl", "restart", "opencode-server")
			if output, err := cmd.CombinedOutput(); err != nil {
				log.Printf("opencode-server restart failed: %v: %s", err, strings.TrimSpace(string(output)))
			} else {
				log.Printf("opencode-server restart requested: %s", strings.TrimSpace(string(output)))
			}
		}()

		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "status": "restart_queued", "service": "opencode-server"})
	}
}

func updateOpenCodeHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		opencodeUpdate.mu.Lock()
		if opencodeUpdate.Running {
			snapshot := updateStatusSnapshotLocked()
			opencodeUpdate.mu.Unlock()
			writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "update_running", "status": snapshot})
			return
		}
		opencodeUpdate.Running = true
		opencodeUpdate.Stage = "queued"
		opencodeUpdate.StartedAt = time.Now().UTC().Format(time.RFC3339)
		opencodeUpdate.EndedAt = ""
		opencodeUpdate.Before = ""
		opencodeUpdate.Latest = ""
		opencodeUpdate.After = ""
		opencodeUpdate.ReleaseURL = ""
		opencodeUpdate.Changelog = ""
		opencodeUpdate.Error = ""
		opencodeUpdate.Log = ""
		snapshot := updateStatusSnapshotLocked()
		opencodeUpdate.mu.Unlock()

		go runOpenCodeUpdate(cfg)
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "status": snapshot})
	}
}

func updateOpenCodeCheckHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		current := currentOpenCodeVersion()
		release, err := fetchLatestOpenCodeRelease()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "latest_version_check_failed", "detail": err.Error()})
			return
		}
		if !versionsEqual(current, release.Version) {
			if changelog, err := fetchOpenCodeReleaseChangelogSeries(current, release.Version); err == nil && strings.TrimSpace(changelog) != "" {
				release.Changelog = changelog
			} else if err != nil {
				log.Printf("OpenCode changelog series unavailable: %v", err)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":               true,
			"current_version":  current,
			"latest_version":   release.Version,
			"update_available": !versionsEqual(current, release.Version),
			"release_url":      release.URL,
			"changelog":        trimForStatus(release.Changelog, 16000),
		})
	}
}

func updateOpenCodeStatusHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		opencodeUpdate.mu.RLock()
		snapshot := updateStatusSnapshotLocked()
		opencodeUpdate.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": snapshot})
	}
}

func runOpenCodeUpdate(cfg config) {
	setUpdateStage("checking", "")
	before := currentOpenCodeVersion()
	setUpdateVersion("before", before)
	appendUpdateLog(fmt.Sprintf("Current OpenCode: %s", fallback(before, "unknown")))

	release, err := fetchLatestOpenCodeRelease()
	if err != nil {
		setUpdateDone("failed", "", fmt.Errorf("latest version check failed: %w", err))
		return
	}
	setLatestRelease(release)
	appendUpdateLog(fmt.Sprintf("Latest OpenCode: %s", release.Version))
	if versionsEqual(before, release.Version) {
		appendUpdateLog("OpenCode is already current. No update needed.")
		setUpdateVersion("after", before)
		setUpdateDone("up_to_date", "", nil)
		return
	}
	if changelog, err := fetchOpenCodeReleaseChangelogSeries(before, release.Version); err != nil {
		appendUpdateLog(fmt.Sprintf("Release changelog series unavailable: %v", err))
	} else if strings.TrimSpace(changelog) != "" {
		release.Changelog = changelog
		setLatestRelease(release)
	}
	appendUpdateLog(fmt.Sprintf("Preparing upgrade %s -> %s", fallback(before, "unknown"), release.Version))

	setUpdateStage("installing", "")
	installScript := strings.Join([]string{
		"set -euo pipefail",
		"export HOME=/root USER=root LOGNAME=root PATH=/root/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}",
		fmt.Sprintf("echo \"Installing OpenCode %s...\"", release.Version),
		fmt.Sprintf("curl -fsSL https://opencode.ai/install | bash -s -- --version %q --no-modify-path", release.Version),
		"ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode",
	}, "\n")
	if err := runLoggedCommand(5*time.Minute, installScript, "OPENCODE_SERVER_PORT="+serverPortFromConfig(cfg)); err != nil {
		setUpdateVersion("after", currentOpenCodeVersion())
		setUpdateDone("failed", "", err)
		return
	}

	setUpdateStage("persisting", "")
	if err := runLoggedCommand(60*time.Second, "set -euo pipefail\nmkdir -p /config/persist/root/.opencode\nrsync -a --delete /root/.opencode/ /config/persist/root/.opencode/", ""); err != nil {
		setUpdateVersion("after", currentOpenCodeVersion())
		setUpdateDone("failed", "", err)
		return
	}

	setUpdateStage("restarting", "")
	if err := runLoggedCommand(60*time.Second, "set -euo pipefail\necho \"Restarting opencode-server...\"\nsupervisorctl restart opencode-server", ""); err != nil {
		setUpdateVersion("after", currentOpenCodeVersion())
		setUpdateDone("failed", "", err)
		return
	}

	setUpdateStage("verifying", "")
	verifyScript := "set -euo pipefail\nfor i in $(seq 1 60); do code=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${OPENCODE_SERVER_PORT:-4096}/ 2>/dev/null || true); case \"$code\" in 2*|3*|4*) echo \"OpenCode server is responding with HTTP $code.\"; exit 0;; esac; echo \"Waiting for OpenCode server... ${i}/60\"; sleep 1; done\necho \"OpenCode server did not respond before timeout.\"\nexit 1"
	if err := runLoggedCommand(90*time.Second, verifyScript, "OPENCODE_SERVER_PORT="+serverPortFromConfig(cfg)); err != nil {
		setUpdateVersion("after", currentOpenCodeVersion())
		setUpdateDone("failed", "", err)
		return
	}

	after := currentOpenCodeVersion()
	setUpdateVersion("after", after)
	appendUpdateLog(fmt.Sprintf("Updated OpenCode: %s", fallback(after, "unknown")))
	setUpdateDone("complete", "", nil)
	return
}

type openCodeRelease struct {
	Version   string
	URL       string
	Changelog string
}

type githubRelease struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
	Body    string `json:"body"`
}

func fetchLatestOpenCodeRelease() (openCodeRelease, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/anomalyco/opencode/releases/latest", nil)
	if err != nil {
		return openCodeRelease{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "OpenCode-Plus-Updater/1.0")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return openCodeRelease{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return openCodeRelease{}, fmt.Errorf("GitHub release check failed: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	var parsed struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
		Body    string `json:"body"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&parsed); err != nil {
		return openCodeRelease{}, err
	}
	version := strings.TrimPrefix(strings.TrimSpace(parsed.TagName), "v")
	if version == "" {
		return openCodeRelease{}, errors.New("latest release did not include a version tag")
	}
	return openCodeRelease{Version: version, URL: parsed.HTMLURL, Changelog: strings.TrimSpace(parsed.Body)}, nil
}

func fetchOpenCodeReleaseChangelogSeries(currentVersion, latestVersion string) (string, error) {
	releases, err := fetchOpenCodeReleases(50)
	if err != nil {
		return "", err
	}
	var sections []string
	for _, release := range releases {
		if compareVersions(release.Version, currentVersion) <= 0 || compareVersions(release.Version, latestVersion) > 0 {
			continue
		}
		body := strings.TrimSpace(release.Changelog)
		if body == "" {
			body = "No changelog was published for this release."
		}
		sections = append(sections, fmt.Sprintf("## OpenCode v%s\n\n%s", release.Version, body))
	}
	return strings.Join(sections, "\n\n"), nil
}

func fetchOpenCodeReleases(limit int) ([]openCodeRelease, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("https://api.github.com/repos/anomalyco/opencode/releases?per_page=%d", limit), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "OpenCode-Plus-Updater/1.0")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return nil, fmt.Errorf("GitHub release list failed: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	var parsed []githubRelease
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&parsed); err != nil {
		return nil, err
	}
	releases := make([]openCodeRelease, 0, len(parsed))
	for _, item := range parsed {
		version := strings.TrimPrefix(strings.TrimSpace(item.TagName), "v")
		if version == "" {
			continue
		}
		releases = append(releases, openCodeRelease{Version: version, URL: item.HTMLURL, Changelog: strings.TrimSpace(item.Body)})
	}
	return releases, nil
}

func versionsEqual(a, b string) bool {
	return strings.TrimPrefix(strings.TrimSpace(a), "v") == strings.TrimPrefix(strings.TrimSpace(b), "v")
}

func compareVersions(a, b string) int {
	aParts := parseVersionParts(a)
	bParts := parseVersionParts(b)
	for i := 0; i < len(aParts) && i < len(bParts); i++ {
		if aParts[i] > bParts[i] {
			return 1
		}
		if aParts[i] < bParts[i] {
			return -1
		}
	}
	return 0
}

func parseVersionParts(version string) [3]int {
	var parts [3]int
	version = strings.TrimPrefix(strings.TrimSpace(version), "v")
	version = strings.SplitN(version, "-", 2)[0]
	for i, value := range strings.Split(version, ".") {
		if i >= len(parts) {
			break
		}
		parsed, err := strconv.Atoi(value)
		if err != nil {
			continue
		}
		parts[i] = parsed
	}
	return parts
}

func fallback(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}

func runLoggedCommand(timeout time.Duration, script string, extraEnv string) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bash", "-lc", script)
	cmd.Env = os.Environ()
	if strings.TrimSpace(extraEnv) != "" {
		cmd.Env = append(cmd.Env, extraEnv)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	var wg sync.WaitGroup
	readPipe := func(prefix string, reader io.Reader) {
		defer wg.Done()
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 0, 4096), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			if prefix != "" {
				line = prefix + line
			}
			appendUpdateLog(line)
		}
	}
	wg.Add(2)
	go readPipe("", stdout)
	go readPipe("", stderr)
	wg.Wait()
	if err := cmd.Wait(); err != nil {
		return err
	}
	return nil
}

func currentOpenCodeVersion() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "opencode", "--version").CombinedOutput()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func serverPortFromConfig(cfg config) string {
	parsed, err := url.Parse(cfg.UpstreamURL)
	if err != nil || parsed.Port() == "" {
		return "4096"
	}
	return parsed.Port()
}

func setUpdateStage(stage, logText string) {
	opencodeUpdate.mu.Lock()
	defer opencodeUpdate.mu.Unlock()
	opencodeUpdate.Stage = stage
	if logText != "" {
		opencodeUpdate.Log = logText
	}
}

func setUpdateVersion(field, version string) {
	opencodeUpdate.mu.Lock()
	defer opencodeUpdate.mu.Unlock()
	if field == "before" {
		opencodeUpdate.Before = version
	} else {
		opencodeUpdate.After = version
	}
}

func setLatestRelease(release openCodeRelease) {
	opencodeUpdate.mu.Lock()
	defer opencodeUpdate.mu.Unlock()
	opencodeUpdate.Latest = release.Version
	opencodeUpdate.ReleaseURL = release.URL
	opencodeUpdate.Changelog = trimForStatus(release.Changelog, 16000)
}

func appendUpdateLog(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	opencodeUpdate.mu.Lock()
	defer opencodeUpdate.mu.Unlock()
	if opencodeUpdate.Log == "" {
		opencodeUpdate.Log = line
	} else {
		opencodeUpdate.Log += "\n" + line
	}
	opencodeUpdate.Log = trimForStatus(opencodeUpdate.Log, 12000)
}

func trimForStatus(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	return value[len(value)-max:]
}

func setUpdateDone(stage, logText string, err error) {
	opencodeUpdate.mu.Lock()
	defer opencodeUpdate.mu.Unlock()
	opencodeUpdate.Running = false
	opencodeUpdate.Stage = stage
	opencodeUpdate.EndedAt = time.Now().UTC().Format(time.RFC3339)
	if strings.TrimSpace(logText) != "" {
		opencodeUpdate.Log = trimForStatus(logText, 12000)
	}
	if err != nil {
		opencodeUpdate.Error = err.Error()
		appendLine := err.Error()
		if opencodeUpdate.Log == "" {
			opencodeUpdate.Log = appendLine
		} else {
			opencodeUpdate.Log = trimForStatus(opencodeUpdate.Log+"\n"+appendLine, 12000)
		}
	}
}

func updateStatusSnapshotLocked() map[string]any {
	return map[string]any{
		"running":        opencodeUpdate.Running,
		"stage":          opencodeUpdate.Stage,
		"started_at":     opencodeUpdate.StartedAt,
		"ended_at":       opencodeUpdate.EndedAt,
		"before_version": opencodeUpdate.Before,
		"latest_version": opencodeUpdate.Latest,
		"after_version":  opencodeUpdate.After,
		"release_url":    opencodeUpdate.ReleaseURL,
		"changelog":      opencodeUpdate.Changelog,
		"error":          opencodeUpdate.Error,
		"log":            opencodeUpdate.Log,
	}
}

func readPlusConfig(cfg config) plusConfig {
	loaded := plusConfig{GeminiAuthSource: "auto", OpenAIAuthSource: "auto", AnthropicAuthSource: "auto"}
	body, err := os.ReadFile(cfg.ConfigFile)
	if err != nil {
		return loaded
	}
	if err := json.Unmarshal(body, &loaded); err != nil {
		return plusConfig{GeminiAuthSource: "auto", OpenAIAuthSource: "auto", AnthropicAuthSource: "auto"}
	}
	loaded.GeminiAuthSource = normalizedOrDefault(normalizeGeminiAuthSource(loaded.GeminiAuthSource), "auto")
	loaded.OpenAIAuthSource = normalizedOrDefault(normalizeOpenAIAuthSource(loaded.OpenAIAuthSource), "auto")
	loaded.AnthropicAuthSource = normalizedOrDefault(normalizeAnthropicAuthSource(loaded.AnthropicAuthSource), "auto")
	return loaded
}

func writePlusConfig(cfg config, next plusConfig) error {
	next.GeminiAuthSource = normalizedOrDefault(normalizeGeminiAuthSource(next.GeminiAuthSource), "auto")
	next.OpenAIAuthSource = normalizedOrDefault(normalizeOpenAIAuthSource(next.OpenAIAuthSource), "auto")
	next.AnthropicAuthSource = normalizedOrDefault(normalizeAnthropicAuthSource(next.AnthropicAuthSource), "auto")
	if err := os.MkdirAll(filepath.Dir(cfg.ConfigFile), 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(cfg.ConfigFile, append(body, '\n'), 0o600)
}

func normalizedOrDefault(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func normalizeGeminiAuthSource(source string) string {
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "", "auto":
		return "auto"
	case "gemini_cli", "gemini-cli", "cli":
		return "gemini_cli"
	case "opencode_provider", "opencode-provider", "opencode":
		return "opencode_provider"
	default:
		return ""
	}
}

func normalizeOpenAIAuthSource(source string) string {
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "", "auto":
		return "auto"
	case "chatgpt", "chatgpt_subscription", "subscription":
		return "chatgpt_subscription"
	case "admin_api", "admin-api", "admin":
		return "admin_api"
	case "opencode_provider", "opencode-provider", "opencode", "api":
		return "opencode_provider"
	default:
		return ""
	}
}

func normalizeAnthropicAuthSource(source string) string {
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "", "auto":
		return "auto"
	case "claude", "claude_subscription", "subscription":
		return "claude_subscription"
	case "admin_api", "admin-api", "admin":
		return "admin_api"
	case "opencode_provider", "opencode-provider", "opencode", "api":
		return "opencode_provider"
	default:
		return ""
	}
}

func quotaHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.QuotaURL, nil)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "invalid_quota_url", "detail": err.Error()})
			return
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "quota_unreachable", "detail": err.Error()})
			return
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "quota_read_failed", "detail": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(resp.StatusCode)
		if r.Method != http.MethodHead {
			_, _ = w.Write(body)
		}
	}
}

func uiAssetOverrideHandler(cfg config, proxy *httputil.ReverseProxy) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			proxy.ServeHTTP(w, r)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" || strings.Contains(name, "..") || strings.ContainsAny(name, `\\`) {
			proxy.ServeHTTP(w, r)
			return
		}
		if !serveUIAsset(w, r, cfg, name) {
			proxy.ServeHTTP(w, r)
		}
	}
}

func serveUIAsset(w http.ResponseWriter, r *http.Request, cfg config, name string) bool {
	body, err := readUIAsset(cfg, name)
	if err != nil {
		return false
	}
	contentType := mime.TypeByExtension(filepath.Ext(name))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
	return true
}

func uiAssetHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/__opencode-plus/")
		if name == "" || strings.Contains(name, "..") || strings.ContainsAny(name, `/\\`) {
			http.NotFound(w, r)
			return
		}

		body, err := readUIAsset(cfg, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		contentType := mime.TypeByExtension(filepath.Ext(name))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = w.Write(body)
		}
	}
}

func readUIAsset(cfg config, name string) ([]byte, error) {
	if cfg.UIAssetDir != "" {
		path := filepath.Join(cfg.UIAssetDir, name)
		cleanRoot, err := filepath.Abs(cfg.UIAssetDir)
		if err != nil {
			return nil, err
		}
		cleanPath, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		if cleanPath != cleanRoot && !strings.HasPrefix(cleanPath, cleanRoot+string(os.PathSeparator)) {
			return nil, os.ErrPermission
		}
		return os.ReadFile(cleanPath)
	}
	return embeddedUI.ReadFile("ui/" + name)
}

func injectUIAssets(resp *http.Response) error {
	if resp.Request == nil || resp.Request.Method == http.MethodHead {
		return nil
	}
	contentType := resp.Header.Get("Content-Type")
	if !strings.Contains(strings.ToLower(contentType), "text/html") {
		return nil
	}
	if resp.Body == nil {
		return nil
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		return err
	}
	html := string(body)
	if strings.Contains(html, "/__opencode-plus/drawer.js") {
		resp.Body = io.NopCloser(strings.NewReader(html))
		resp.ContentLength = int64(len(html))
		resp.Header.Set("Content-Length", fmt.Sprint(len(html)))
		return nil
	}
	injection := `<script src="/__opencode-plus/terminal-rescue.js" data-opencode-plus-ui="terminal-rescue"></script><link rel="stylesheet" href="/__opencode-plus/statusline.css" data-opencode-plus-ui="statusline"><link rel="stylesheet" href="/__opencode-plus/drawer.css" data-opencode-plus-ui="drawer"><script defer src="/__opencode-plus/statusline.js" data-opencode-plus-ui="statusline"></script><script defer src="/__opencode-plus/drawer.js" data-opencode-plus-ui="drawer"></script>`
	lower := strings.ToLower(html)
	idx := strings.LastIndex(lower, "</head>")
	if idx >= 0 {
		html = html[:idx] + injection + html[idx:]
	} else {
		html += injection
	}
	resp.Body = io.NopCloser(strings.NewReader(html))
	resp.ContentLength = int64(len(html))
	resp.Header.Set("Content-Length", fmt.Sprint(len(html)))
	resp.Header.Del("Content-Encoding")
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func env(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func envBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return strings.EqualFold(value, "true") || value == "1" || strings.EqualFold(value, "yes")
}
