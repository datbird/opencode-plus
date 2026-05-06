package main

import (
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
	mux.HandleFunc("/__opencode-plus/opencode/restart", protectedHandler(auth, cfg, cache, restartOpenCodeHandler()))
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
			"ok":           true,
			"service":      "opencode-plus-ui-gateway",
			"ui_enabled":   cfg.UIEnabled,
			"external_ui":  cfg.UIAssetDir != "",
			"upstream_url": upstream.String(),
		})
	}
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
