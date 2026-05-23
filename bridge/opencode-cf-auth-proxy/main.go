package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
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
	InstanceName        string `json:"instance_name"`
	SoulDBEnabled       *bool  `json:"soul_db_enabled,omitempty"`
	SoulPBURL           string `json:"soul_pb_url"`
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
	startSessionSyncReconciler(cfg)
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
	mux.HandleFunc("/__opencode-plus/soul/project", protectedHandler(auth, cfg, cache, soulProjectHandler(cfg)))
	mux.HandleFunc("/__opencode-plus/soul/projects", soulProjectsHandler(cfg))
	mux.HandleFunc("/__opencode-plus/soul/projects/", protectedHandler(auth, cfg, cache, soulProjectItemHandler(cfg)))
	mux.HandleFunc("/__opencode-plus/soul/sessions/sync", protectedHandler(auth, cfg, cache, soulSessionsSyncHandler(cfg)))
	mux.HandleFunc("/__opencode-plus/soul/workspaces", soulWorkspacesHandler(cfg))
	mux.HandleFunc("/__opencode-plus/soul/project/new", protectedHandler(auth, cfg, cache, soulNewProjectHandler(cfg)))
	mux.HandleFunc("/__opencode-plus/soul/deployments/", protectedHandler(auth, cfg, cache, soulDeploymentHandler(cfg)))
	mux.HandleFunc("/__opencode-plus/opencode/config", openCodeConfigHandler(cfg))
	mux.HandleFunc("/__opencode-plus/opencode/projects/refresh", protectedHandler(auth, cfg, cache, openCodeProjectRefreshHandler(cfg)))
	mux.HandleFunc("/__opencode-plus/opencode/restart", protectedHandler(auth, cfg, cache, restartOpenCodeHandler()))
	mux.HandleFunc("/__opencode-plus/gateway/restart", protectedHandler(auth, cfg, cache, restartGatewayHandler()))
	mux.HandleFunc("/__opencode-plus/opencode/update/check", updateOpenCodeCheckHandler())
	mux.HandleFunc("/__opencode-plus/opencode/update", protectedHandler(auth, cfg, cache, updateOpenCodeHandler(cfg)))
	mux.HandleFunc("/__opencode-plus/opencode/update/status", updateOpenCodeStatusHandler())
	mux.HandleFunc("/__opencode-plus/mounts/google-drive/account", protectedHandler(auth, cfg, cache, googleDriveAccountHandler()))
	mux.HandleFunc("/__opencode-plus/storage-providers", protectedHandler(auth, cfg, cache, mounts.ProviderCollectionHandler()))
	mux.HandleFunc("/__opencode-plus/storage-providers/", protectedHandler(auth, cfg, cache, mounts.ProviderItemHandler()))
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
		Handler:           corsMiddleware(mux),
		ReadHeaderTimeout: 15 * time.Second,
	}

	log.Printf("opencode-cf-auth-proxy listening on %s, upstream %s", cfg.ListenAddr, cfg.UpstreamURL)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Add("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "authorization, content-type, x-requested-with")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isPTYConnectRequest(path string) bool {
	return strings.HasPrefix(path, "/pty/") && (strings.HasSuffix(path, "/connect-token") || strings.HasSuffix(path, "/connect"))
}

func prepareUpstreamRequest(r *http.Request, cfg config, cloudflareAuthEnabled bool) {
	clientAuthorization := r.Header.Get("Authorization")
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
	} else if strings.TrimSpace(clientAuthorization) != "" {
		r.Header.Set("Authorization", clientAuthorization)
	}
}

func loadConfig() (config, error) {
	cfg := config{
		ListenAddr:          env("LISTEN_ADDR", ":4097"),
		UpstreamURL:         env("UPSTREAM_URL", "http://127.0.0.1:4096"),
		AccessAudience:      strings.TrimSpace(os.Getenv("CF_ACCESS_AUD")),
		SkipAudience:        strings.EqualFold(os.Getenv("CF_ACCESS_SKIP_AUD"), "true"),
		TrustedIssuerSuffix: env("TRUSTED_CF_ISSUER_SUFFIX", ".cloudflareaccess.com"),
		RootRedirectPath:    env("OPENCODE_ROOT_REDIRECT_PATH", "/"),
		UIEnabled:           envBool("OPENCODE_PLUS_UI_ENABLED", false),
		UIAssetDir:          strings.TrimSpace(os.Getenv("OPENCODE_PLUS_UI_ASSET_DIR")),
		AuthStateFile:       env("OPENCODE_PLUS_AUTH_STATE_FILE", "/config/persist/opencode-plus-auth-state.json"),
		QuotaURL:            env("OPENCODE_PLUS_QUOTA_URL", "http://127.0.0.1:18765/quota"),
		SecretsDir:          env("OPENCODE_PLUS_SECRETS_DIR", "/config/persist/opencode-plus-secrets"),
		ConfigFile:          env("OPENCODE_PLUS_CONFIG_FILE", "/config/persist/opencode-plus-config.json"),
		OpenCodeConfigFile:  env("OPENCODE_CONFIG_FILE", "/root/workspace/opencode.json"),
		MountsDir:           env("OPENCODE_PLUS_MOUNTS_DIR", "/config/persist/opencode-plus-mounts"),
		SoulDBEnabled:       envBool("OPENCODE_PLUS_SOUL_DB_ENABLED", true),
		SoulPBURL:           strings.TrimRight(env("OPENCODE_PLUS_SOUL_PB_URL", "http://pocketbase:8080"), "/"),
		DeploymentID:        env("OPENCODE_PLUS_DEPLOYMENT_ID", env("HOSTNAME", "opencode-plus")),
		DeploymentName:      env("OPENCODE_PLUS_DEPLOYMENT_NAME", env("HOSTNAME", "OpenCode Plus")),
		DeploymentIDStable:  strings.TrimSpace(os.Getenv("OPENCODE_PLUS_DEPLOYMENT_ID")) != "",
		SourceRepoDir:       env("OPENCODE_PLUS_SOURCE_REPO_DIR", ""),
	}
	plusCfg := readPlusConfig(cfg)
	if plusCfg.SoulDBEnabled != nil && strings.TrimSpace(os.Getenv("OPENCODE_PLUS_SOUL_DB_ENABLED")) == "" {
		cfg.SoulDBEnabled = *plusCfg.SoulDBEnabled
	}
	if plusCfg.SoulPBURL != "" && strings.TrimSpace(os.Getenv("OPENCODE_PLUS_SOUL_PB_URL")) == "" {
		cfg.SoulPBURL = plusCfg.SoulPBURL
	}
	configuredInstanceName := plusCfg.InstanceName
	if configuredInstanceName != "" && strings.TrimSpace(os.Getenv("OPENCODE_PLUS_DEPLOYMENT_ID")) == "" {
		cfg.DeploymentID = configuredInstanceName
		cfg.DeploymentName = configuredInstanceName
		cfg.DeploymentIDStable = true
	} else if configuredInstanceName != "" && strings.TrimSpace(os.Getenv("OPENCODE_PLUS_DEPLOYMENT_NAME")) == "" {
		cfg.DeploymentName = configuredInstanceName
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
		payload := map[string]any{
			"ok":               true,
			"service":          "opencode-plus-ui-gateway",
			"ui_enabled":       cfg.UIEnabled,
			"external_ui":      cfg.UIAssetDir != "",
			"upstream_url":     upstream.String(),
			"opencode_version": currentOpenCodeVersion(),
		}
		if r.URL.Query().Get("support") == "1" {
			payload["support"] = supportVersionInfo(cfg)
		}
		writeJSON(w, http.StatusOK, payload)
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
			"ok":                 true,
			"enabled":            cfg.SoulDBEnabled,
			"ready":              false,
			"state":              mapBool(cfg.SoulDBEnabled, "checking", "disabled"),
			"schema_ready":       false,
			"named_space_count":  0,
			"project_registered": false,
			"deployment":         deploymentStatus(cfg, r),
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
			localPath := strings.TrimSpace(r.URL.Query().Get("local_path"))
			if localPath != "" && filepath.IsAbs(localPath) {
				registered, err := deploymentProjectPathExists(cfg.SoulPBURL, cfg.DeploymentID, localPath)
				if err == nil {
					status["project_registered"] = registered
				}
			}
		}
		writeJSON(w, http.StatusOK, status)
	}
}

func soulProjectHandler(cfg config) http.HandlerFunc {
	type requestBody struct {
		Name      string `json:"name"`
		LocalPath string `json:"local_path"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if !cfg.SoulDBEnabled {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sync_disabled", "detail": "Synchronization database features are disabled."})
			return
		}
		connected, detail := checkPocketBaseHealth(cfg.SoulPBURL)
		if !connected {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "pocketbase_unavailable", "detail": detail})
			return
		}
		schemaReady, _, _ := checkSoulSchema(cfg.SoulPBURL)
		if !schemaReady {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "schema_not_ready", "detail": "Synchronization schema is not initialized."})
			return
		}
		var request requestBody
		if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&request); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
			return
		}
		localPath := strings.TrimSpace(request.LocalPath)
		if localPath == "" || !filepath.IsAbs(localPath) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "local_path_required", "detail": "Choose an absolute local workspace path."})
			return
		}
		name := strings.TrimSpace(request.Name)
		if name == "" {
			name = filepath.Base(localPath)
		}
		if name == "." || name == string(filepath.Separator) || name == "" {
			name = "OpenCode Project"
		}

		spaceID, createdSpace, err := ensureDefaultNamedSpace(cfg.SoulPBURL)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "named_space_failed", "detail": err.Error()})
			return
		}
		projectID, createdProject, err := ensureSyncedProject(cfg.SoulPBURL, name, spaceID, localPath)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "project_failed", "detail": err.Error()})
			return
		}
		createdPath, err := ensureDeploymentProjectPath(cfg.SoulPBURL, cfg.DeploymentID, projectID, localPath)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "project_path_failed", "detail": err.Error()})
			return
		}
		createdWorkspacePath, err := ensureDeploymentSpacePath(cfg.SoulPBURL, cfg.DeploymentID, spaceID, localPath)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "workspace_path_failed", "detail": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":                     true,
			"project_id":             projectID,
			"space_id":               spaceID,
			"deployment_id":          cfg.DeploymentID,
			"local_path":             localPath,
			"created_space":          createdSpace,
			"created_project":        createdProject,
			"created_project_path":   createdPath,
			"created_workspace_path": createdWorkspacePath,
		})
	}
}

func soulWorkspacesHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if !cfg.SoulDBEnabled {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "workspaces": []any{}})
			return
		}
		workspaces, err := listMappedNamedWorkspaces(cfg)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "workspace_list_failed", "detail": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "workspaces": workspaces})
	}
}

func soulProjectsHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if !cfg.SoulDBEnabled {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "projects": []any{}})
			return
		}
		projects, err := listMappedSyncedProjects(cfg)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "project_list_failed", "detail": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "projects": projects})
	}
}

func soulProjectItemHandler(cfg config) http.HandlerFunc {
	type updateBody struct {
		Name string `json:"name"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		trimmedPath := strings.Trim(strings.TrimPrefix(r.URL.Path, "/__opencode-plus/soul/projects/"), "/")
		parts := strings.Split(trimmedPath, "/")
		if len(parts) == 2 && parts[1] == "icon" {
			soulProjectIconHandler(cfg, parts[0])(w, r)
			return
		}
		if r.Method != http.MethodDelete && r.Method != http.MethodPatch && r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		id := trimmedPath
		if id == "" || strings.Contains(id, "/") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_project_mapping"})
			return
		}
		record, err := findDeploymentProjectPathByRecordID(cfg.SoulPBURL, id)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "project_mapping_lookup_failed", "detail": err.Error()})
			return
		}
		if record.ID == "" || record.DeploymentID != cfg.DeploymentID {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "project_mapping_not_found"})
			return
		}
		if r.Method == http.MethodPatch || r.Method == http.MethodPut {
			defer r.Body.Close()
			var body updateBody
			if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
				return
			}
			name := strings.TrimSpace(body.Name)
			if name == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "project_name_required"})
				return
			}
			if err := patchPocketBaseRecord(cfg.SoulPBURL, "opcp_synced_projects", record.ProjectID, map[string]any{"name": name}); err != nil {
				writeJSON(w, http.StatusBadGateway, map[string]string{"error": "project_update_failed", "detail": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updated": id})
			return
		}
		if err := deletePocketBaseRecord(cfg.SoulPBURL, "opcp_deployment_project_paths", id); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "project_mapping_delete_failed", "detail": err.Error()})
			return
		}
		removeSyncedProjectShortcutForPath(record.LocalPath)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": id})
	}
}

func soulProjectIconHandler(cfg config, mappingID string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		record, err := findDeploymentProjectPathByRecordID(cfg.SoulPBURL, mappingID)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "project_mapping_lookup_failed", "detail": err.Error()})
			return
		}
		if record.ID == "" || record.DeploymentID != cfg.DeploymentID {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "project_mapping_not_found"})
			return
		}
		if err := r.ParseMultipartForm(768 * 1024); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_upload", "detail": err.Error()})
			return
		}
		file, header, err := r.FormFile("icon")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "icon_file_required"})
			return
		}
		defer file.Close()
		body, err := io.ReadAll(io.LimitReader(file, 512*1024+1))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "icon_read_failed", "detail": err.Error()})
			return
		}
		if len(body) > 512*1024 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "icon_too_large", "detail": "Use a 128x128 PNG, JPEG, or GIF under 512KB."})
			return
		}
		mimeType, ext, err := validateProjectIcon(body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_icon", "detail": err.Error()})
			return
		}
		if strings.TrimSpace(header.Filename) == "" {
			header.Filename = "project-icon" + ext
		}
		iconPath, dataURL, err := writeSyncedProjectIcon(record.LocalPath, body, mimeType, ext)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "icon_write_failed", "detail": err.Error()})
			return
		}
		project, err := findSyncedProjectByRecordID(cfg.SoulPBURL, record.ProjectID)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "project_lookup_failed", "detail": err.Error()})
			return
		}
		metadata := project.Metadata
		if metadata == nil {
			metadata = map[string]any{}
		}
		metadata["icon_path"] = filepath.ToSlash(iconPath)
		metadata["icon_mime"] = mimeType
		metadata["icon_updated_at"] = time.Now().UTC().Format(time.RFC3339)
		metadata["icon_updated_by_deployment"] = cfg.DeploymentID
		if err := patchPocketBaseRecord(cfg.SoulPBURL, "opcp_synced_projects", record.ProjectID, map[string]any{"metadata": metadata}); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "project_icon_index_failed", "detail": err.Error()})
			return
		}
		if err := applySyncedProjectIcon(record.LocalPath, project.Name, dataURL); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "project_icon_apply_failed", "detail": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "project_id": record.ProjectID, "icon_url": dataURL})
	}
}

func validateProjectIcon(body []byte) (string, string, error) {
	config, format, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil {
		return "", "", errors.New("Use a PNG, JPEG, or GIF image.")
	}
	if config.Width != 128 || config.Height != 128 {
		return "", "", fmt.Errorf("Image must be exactly 128x128 pixels; got %dx%d.", config.Width, config.Height)
	}
	switch format {
	case "png":
		return "image/png", ".png", nil
	case "jpeg":
		return "image/jpeg", ".jpg", nil
	case "gif":
		return "image/gif", ".gif", nil
	default:
		return "", "", errors.New("Use a PNG, JPEG, or GIF image.")
	}
}

func writeSyncedProjectIcon(projectPath string, body []byte, mimeType, ext string) (string, string, error) {
	root := filepath.Join(projectPath, ".opencode-plus")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", "", err
	}
	for _, oldExt := range []string{".png", ".jpg", ".gif"} {
		if oldExt != ext {
			_ = os.Remove(filepath.Join(root, "project-icon"+oldExt))
		}
	}
	iconPath := filepath.Join(root, "project-icon"+ext)
	tmp := iconPath + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return "", "", err
	}
	if err := os.Rename(tmp, iconPath); err != nil {
		return "", "", err
	}
	return filepath.Join(".opencode-plus", "project-icon"+ext), "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(body), nil
}

func soulNewProjectHandler(cfg config) http.HandlerFunc {
	type requestBody struct {
		Name        string `json:"name"`
		WorkspaceID string `json:"workspace_id"`
		FolderName  string `json:"folder_name"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if !cfg.SoulDBEnabled {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sync_disabled", "detail": "Synchronization database features are disabled."})
			return
		}
		connected, detail := checkPocketBaseHealth(cfg.SoulPBURL)
		if !connected {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "pocketbase_unreachable", "detail": detail})
			return
		}
		schemaReady, _, _ := checkSoulSchema(cfg.SoulPBURL)
		if !schemaReady {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "schema_missing", "detail": "Synchronization schema is not initialized."})
			return
		}

		defer r.Body.Close()
		var body requestBody
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
			return
		}
		name := strings.TrimSpace(body.Name)
		if name == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "project_name_required"})
			return
		}
		workspace, err := findMappedNamedWorkspace(cfg, strings.TrimSpace(body.WorkspaceID))
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "workspace_lookup_failed", "detail": err.Error()})
			return
		}
		if workspace.ID == "" || !filepath.IsAbs(workspace.LocalPath) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "named_workspace_required"})
			return
		}
		parent := filepath.Clean(workspace.LocalPath)
		folderName := sanitizeProjectFolderName(body.FolderName)
		if folderName == "" {
			folderName = sanitizeProjectFolderName(name)
		}
		if folderName == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_folder_name"})
			return
		}
		projectPath := filepath.Clean(filepath.Join(parent, folderName))
		parentWithSep := strings.TrimRight(parent, string(filepath.Separator)) + string(filepath.Separator)
		if projectPath == parent || !strings.HasPrefix(projectPath, parentWithSep) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_project_path"})
			return
		}
		if info, err := os.Stat(projectPath); err == nil {
			if !info.IsDir() {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "project_path_exists", "detail": projectPath})
				return
			}
		} else if errors.Is(err, os.ErrNotExist) {
			if err := os.MkdirAll(projectPath, 0o755); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "project_directory_create_failed", "detail": err.Error()})
				return
			}
		} else {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "project_path_check_failed", "detail": err.Error()})
			return
		}
		spaceID, _, err := ensureDefaultNamedSpace(cfg.SoulPBURL)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "space_failed", "detail": err.Error()})
			return
		}
		projectID, createdProject, err := ensureSyncedProject(cfg.SoulPBURL, name, spaceID, projectPath)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "project_failed", "detail": err.Error()})
			return
		}
		createdPath, err := ensureDeploymentProjectPath(cfg.SoulPBURL, cfg.DeploymentID, projectID, projectPath)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "project_path_failed", "detail": err.Error()})
			return
		}
		shortcutPath, err := ensureSyncedProjectShortcut(workspaceRootForShortcut(parent), name, projectPath)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "project_shortcut_failed", "detail": err.Error()})
			return
		}
		sessionSync, err := initializeProjectSessionSync(projectPath, projectID, spaceID, cfg.DeploymentID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "session_sync_init_failed", "detail": err.Error()})
			return
		}
		encodedPath := encodeOpenCodeProjectPath(projectPath)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":                   true,
			"project_id":           projectID,
			"space_id":             spaceID,
			"workspace_id":         workspace.ID,
			"workspace_name":       workspace.Name,
			"deployment_id":        cfg.DeploymentID,
			"local_path":           projectPath,
			"open_url":             "/" + encodedPath + "/session",
			"created_project":      createdProject,
			"created_project_path": createdPath,
			"shortcut_path":        shortcutPath,
			"session_sync":         sessionSync,
		})
	}
}

func ensureSyncedProjectShortcut(workspaceRoot, projectName, projectPath string) (string, error) {
	workspaceRoot = filepath.Clean(workspaceRoot)
	projectPath = filepath.Clean(projectPath)
	shortcutName := "#OCP-SyncedProject-" + sanitizeProjectFolderName(projectName)
	if shortcutName == "#OCP-SyncedProject-" {
		shortcutName += sanitizeProjectFolderName(filepath.Base(projectPath))
	}
	shortcutPath := filepath.Join(workspaceRoot, shortcutName)
	if shortcutPath == projectPath {
		return shortcutPath, nil
	}
	if isMountpointPath(shortcutPath) {
		return shortcutPath, nil
	}
	if target, err := os.Readlink(shortcutPath); err == nil {
		if filepath.Clean(target) == projectPath {
			if err := os.Remove(shortcutPath); err != nil {
				return "", err
			}
		} else {
			return "", fmt.Errorf("shortcut already points elsewhere: %s", shortcutPath)
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(shortcutPath, 0o755); err != nil {
			return "", err
		}
	} else {
		info, statErr := os.Lstat(shortcutPath)
		if statErr != nil {
			return "", statErr
		}
		if !info.IsDir() {
			return "", fmt.Errorf("shortcut path already exists and is not a directory: %s", shortcutPath)
		}
		if _, statErr := os.Stat(shortcutPath); statErr != nil {
			_ = exec.Command("umount", "-l", shortcutPath).Run()
			_ = os.Remove(shortcutPath)
			if err := os.MkdirAll(shortcutPath, 0o755); err != nil {
				return "", err
			}
		}
	}
	if err := bindMountDirectory(projectPath, shortcutPath); err != nil {
		return "", err
	}
	return shortcutPath, nil
}

func bindMountDirectory(source, target string) error {
	if strings.HasPrefix(filepath.Clean(target), filepath.Clean(os.TempDir())+string(filepath.Separator)) {
		_ = os.Remove(target)
		return os.Symlink(source, target)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "mount", "--bind", source, target)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("bind mount failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func isMountpointPath(path string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "mountpoint", "-q", path).Run() == nil
}

func workspaceRootForShortcut(syncedWorkspacePath string) string {
	parent := filepath.Dir(filepath.Clean(syncedWorkspacePath))
	if filepath.Base(parent) == "mounts" {
		return filepath.Dir(parent)
	}
	return parent
}

func removeSyncedProjectShortcutForPath(projectPath string) {
	projectPath = filepath.Clean(projectPath)
	workspaceRoot := workspaceRootForShortcut(filepath.Dir(projectPath))
	entries, err := os.ReadDir(workspaceRoot)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "#OCP-SyncedProject-") {
			continue
		}
		shortcutPath := filepath.Join(workspaceRoot, entry.Name())
		if isMountpointPath(shortcutPath) {
			_ = exec.Command("umount", shortcutPath).Run()
			_ = os.Remove(shortcutPath)
			continue
		}
		target, err := os.Readlink(shortcutPath)
		if err == nil && filepath.Clean(target) == projectPath {
			_ = os.Remove(shortcutPath)
		}
	}
}

func openCodeProjectRefreshHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		projects, err := listMappedSyncedProjects(cfg)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "synced_project_list_failed", "detail": err.Error()})
			return
		}
		registered := 0
		for _, project := range projects {
			if strings.TrimSpace(project.LocalPath) == "" {
				continue
			}
			if _, err := ensureSyncedProjectShortcut(workspaceRootForShortcut(filepath.Dir(project.LocalPath)), project.Name, project.LocalPath); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "opencode_project_shortcut_refresh_failed", "detail": err.Error()})
				return
			}
			if err := registerOpenCodeProject(project.Name, project.LocalPath); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "opencode_project_refresh_failed", "detail": err.Error()})
				return
			}
			registered++
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "registered": registered})
	}
}

func registerOpenCodeProject(name, localPath string) error {
	if _, err := os.Stat(localPath); err != nil {
		return err
	}
	dbPath := os.Getenv("OPENCODE_DB_PATH")
	if strings.TrimSpace(dbPath) == "" {
		dbPath = "/root/.local/share/opencode/opencode.db"
	}
	if _, err := os.Stat(dbPath); err != nil {
		return err
	}
	cleanPath := filepath.Clean(localPath)
	if strings.TrimSpace(name) == "" {
		name = filepath.Base(cleanPath)
	}
	now := time.Now().UnixMilli()
	id := openCodeProjectID(cleanPath)
	sql := fmt.Sprintf(
		"INSERT INTO project (id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands, icon_url_override) VALUES (%s, %s, NULL, %s, NULL, NULL, %d, %d, NULL, '[]', NULL, NULL) ON CONFLICT(id) DO UPDATE SET worktree=excluded.worktree, name=excluded.name, time_updated=excluded.time_updated;",
		sqlQuote(id), sqlQuote(cleanPath), sqlQuote(name), now, now,
	)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sqlite3", dbPath, sql)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("sqlite3 project upsert failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func soulSessionsSyncHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		projects, err := listMappedSyncedProjects(cfg)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "synced_project_list_failed", "detail": err.Error()})
			return
		}
		result := map[string]any{"ok": true, "projects": 0, "exported": 0, "imported": 0, "indexed": 0, "archived": 0, "skipped": 0}
		for _, project := range projects {
			if strings.TrimSpace(project.LocalPath) == "" {
				continue
			}
			stats, err := syncOpenCodeProjectSessions(cfg, project)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "session_sync_failed", "detail": err.Error()})
				return
			}
			result["projects"] = result["projects"].(int) + 1
			result["exported"] = result["exported"].(int) + stats["exported"]
			result["imported"] = result["imported"].(int) + stats["imported"]
			result["indexed"] = result["indexed"].(int) + stats["indexed"]
			result["archived"] = result["archived"].(int) + stats["archived"]
			if _, ok := result["pulled"]; !ok {
				result["pulled"] = 0
			}
			result["pulled"] = result["pulled"].(int) + stats["pulled"]
			result["skipped"] = result["skipped"].(int) + stats["skipped"]
		}
		writeJSON(w, http.StatusOK, result)
	}
}

func syncOpenCodeProjectSessions(cfg config, project mappedSyncedProject) (map[string]int, error) {
	stats := map[string]int{"exported": 0, "imported": 0, "indexed": 0, "archived": 0, "pulled": 0, "skipped": 0}
	dbPath := openCodeDBPath()
	if _, err := os.Stat(dbPath); err != nil {
		return stats, err
	}
	if err := initializeProjectSessionSyncIfMissing(project.LocalPath, project.ProjectID, project.SpaceID, cfg.DeploymentID); err != nil {
		return stats, err
	}
	needed, err := syncedProjectSessionsNeedSync(cfg, dbPath, project)
	if err != nil {
		return stats, err
	}
	if !needed {
		stats["skipped"] = 1
		return stats, nil
	}
	exported, err := exportOpenCodeSessions(cfg, dbPath, project)
	if err != nil {
		return stats, err
	}
	stats["exported"] = exported
	flushRcloneDirCache()
	cacheDir := sessionPayloadCacheDir(project)
	if err := pullSessionPayloadsFromRemote(cfg, project, cacheDir); err != nil {
		return stats, err
	}
	stats["pulled"] = 1
	imported, indexed, err := importOpenCodeSessions(cfg, dbPath, project)
	if err != nil {
		return stats, err
	}
	stats["imported"] = imported
	stats["indexed"] = indexed
	cacheImported, cacheIndexed, err := importOpenCodeSessionsFromDir(cfg, dbPath, project, cacheDir)
	if err != nil {
		return stats, err
	}
	stats["imported"] += cacheImported
	stats["indexed"] += cacheIndexed
	archived, err := applyIndexedSessionTombstones(cfg, dbPath, project)
	if err != nil {
		return stats, err
	}
	stats["archived"] = archived
	return stats, nil
}

func startSessionSyncReconciler(cfg config) {
	if strings.TrimSpace(cfg.SoulPBURL) == "" || strings.TrimSpace(cfg.DeploymentID) == "" {
		return
	}
	go func() {
		// Let the gateway settle after startup before touching OpenCode's DB.
		timer := time.NewTimer(25 * time.Second)
		defer timer.Stop()
		for {
			<-timer.C
			runSessionSyncReconcile(cfg)
			timer.Reset(2 * time.Minute)
		}
	}()
}

func runSessionSyncReconcile(cfg config) {
	projects, err := listMappedSyncedProjects(cfg)
	if err != nil {
		log.Printf("session sync reconcile skipped: %v", err)
		return
	}
	for _, project := range projects {
		if strings.TrimSpace(project.LocalPath) == "" {
			continue
		}
		stats, err := syncOpenCodeProjectSessions(cfg, project)
		if err != nil {
			log.Printf("session sync reconcile failed for %s: %v", project.LocalPath, err)
			continue
		}
		if stats["exported"] > 0 || stats["imported"] > 0 || stats["indexed"] > 0 || stats["archived"] > 0 {
			log.Printf("session sync reconciled %s: exported=%d imported=%d indexed=%d archived=%d pulled=%d", project.LocalPath, stats["exported"], stats["imported"], stats["indexed"], stats["archived"], stats["pulled"])
		}
	}
}

func flushRcloneDirCache() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = exec.CommandContext(ctx, "pkill", "-HUP", "rclone").Run()
}

func pullSessionPayloadsFromRemote(cfg config, project mappedSyncedProject, localOverride ...string) error {
	remote, local, err := rcloneProjectRemoteAndLocal(cfg, project, filepath.Join(".opencode-plus", "sessions"))
	if err != nil || remote == "" || local == "" {
		return err
	}
	if len(localOverride) > 0 && strings.TrimSpace(localOverride[0]) != "" {
		local = localOverride[0]
	}
	if err := os.MkdirAll(local, 0o755); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "rclone", "copy", remote, local, "--include", "*.json", "--retries", "1", "--low-level-retries", "1", "--stats", "0")
	cmd.Env = rcloneEnv()
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("rclone session payload pull failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func sessionPayloadCacheDir(project mappedSyncedProject) string {
	cacheKey := firstNonEmpty(project.ProjectID, openCodeProjectID(project.LocalPath))
	return filepath.Join(os.TempDir(), "opencode-plus-session-payloads", sanitizeProjectFolderName(cacheKey))
}

func rcloneProjectRemoteAndLocal(cfg config, project mappedSyncedProject, projectSubpath string) (string, string, error) {
	store, err := readMountStore(cfg.MountsDir)
	if err != nil {
		return "", "", err
	}
	projectPath := filepath.Clean(project.LocalPath)
	var selected mountConfig
	for _, mount := range store.Mounts {
		mountPath := filepath.Clean(mount.MountPath)
		if mountPath == "." || mountPath == string(filepath.Separator) {
			continue
		}
		prefix := strings.TrimRight(mountPath, string(filepath.Separator)) + string(filepath.Separator)
		if projectPath == mountPath || strings.HasPrefix(projectPath, prefix) {
			selected = mount
			break
		}
	}
	if strings.TrimSpace(selected.MountPath) == "" {
		return "", "", nil
	}
	remoteName := rcloneRemoteName(selected)
	if remoteName == "" {
		return "", "", nil
	}
	remotePath := firstNonEmpty(selected.Remote["path"], selected.Remote["share"])
	relativeProject, err := filepath.Rel(filepath.Clean(selected.MountPath), projectPath)
	if err != nil || strings.HasPrefix(relativeProject, "..") {
		return "", "", nil
	}
	remoteParts := []string{strings.Trim(remotePath, "/")}
	if relativeProject != "." {
		remoteParts = append(remoteParts, filepath.ToSlash(relativeProject))
	}
	for _, part := range strings.Split(filepath.ToSlash(projectSubpath), "/") {
		if strings.TrimSpace(part) != "" && part != "." {
			remoteParts = append(remoteParts, part)
		}
	}
	remote := remoteName + ":" + strings.Trim(strings.Join(remoteParts, "/"), "/")
	local := filepath.Join(projectPath, projectSubpath)
	return remote, local, nil
}

func openCodeDBPath() string {
	dbPath := os.Getenv("OPENCODE_DB_PATH")
	if strings.TrimSpace(dbPath) == "" {
		dbPath = "/root/.local/share/opencode/opencode.db"
	}
	return dbPath
}

func initializeProjectSessionSyncIfMissing(projectPath, projectID, spaceID, deploymentID string) error {
	manifestPath := filepath.Join(projectPath, ".opencode-plus", "manifest.json")
	if _, err := os.Stat(manifestPath); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_, err := initializeProjectSessionSync(projectPath, projectID, spaceID, deploymentID)
	return err
}

type syncedSessionState struct {
	ID       string
	Updated  int64
	Archived bool
}

func syncedProjectSessionsNeedSync(cfg config, dbPath string, project mappedSyncedProject) (bool, error) {
	localSessions, err := localOpenCodeSessionStates(dbPath, project)
	if err != nil {
		return false, err
	}
	payloads, err := localSessionPayloadStates(project)
	if err != nil {
		return false, err
	}
	indexed, err := indexedSessionStates(cfg, project)
	if err != nil {
		return false, err
	}
	for id, local := range localSessions {
		payload, hasPayload := payloads[id]
		index, hasIndex := indexed[id]
		if local.Archived {
			if !hasIndex || !index.Archived || index.Updated < local.Updated {
				return true, nil
			}
			continue
		}
		if !hasPayload || payload.Updated < local.Updated || !hasIndex || index.Updated < local.Updated {
			return true, nil
		}
	}
	for id := range indexed {
		local, ok := localSessions[id]
		if indexed[id].Archived {
			if ok && (!local.Archived || indexed[id].Updated > local.Updated) {
				return true, nil
			}
			continue
		}
		if !ok || indexed[id].Updated > local.Updated || local.Archived {
			return true, nil
		}
	}
	for id, payload := range payloads {
		local, ok := localSessions[id]
		if !ok || payload.Updated > local.Updated || payload.Archived != local.Archived {
			return true, nil
		}
	}
	return false, nil
}

func localOpenCodeSessionStates(dbPath string, project mappedSyncedProject) (map[string]syncedSessionState, error) {
	dirs := equivalentSyncedProjectPaths(project)
	conditions := make([]string, 0, len(dirs)*2)
	for _, dir := range dirs {
		conditions = append(conditions, "directory = "+sqlQuote(dir), "path = "+sqlQuote(strings.TrimLeft(dir, string(filepath.Separator))))
	}
	query := "select id, coalesce(time_updated, 0) as time_updated, coalesce(time_archived, 0) as time_archived from session where " + strings.Join(conditions, " or ")
	rows, err := sqliteJSONRows(dbPath, query)
	if err != nil {
		return nil, err
	}
	states := map[string]syncedSessionState{}
	for _, row := range rows {
		id, _ := row["id"].(string)
		if id == "" {
			continue
		}
		updated := anyInt64(row["time_updated"])
		archivedAt := anyInt64(row["time_archived"])
		if archivedAt > updated {
			updated = archivedAt
		}
		states[id] = syncedSessionState{ID: id, Updated: updated, Archived: archivedAt > 0}
	}
	return states, nil
}

func localSessionPayloadStates(project mappedSyncedProject) (map[string]syncedSessionState, error) {
	sessionsDir := filepath.Join(project.LocalPath, ".opencode-plus", "sessions")
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		return nil, err
	}
	states := map[string]syncedSessionState{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		payload, err := readOpenCodeSessionPayload(filepath.Join(sessionsDir, entry.Name()))
		if err != nil {
			return nil, err
		}
		id, _ := payload.Session["id"].(string)
		if id == "" {
			continue
		}
		updated := anyInt64(payload.Session["time_updated"])
		archivedAt := anyInt64(payload.Session["time_archived"])
		if archivedAt > updated {
			updated = archivedAt
		}
		states[id] = syncedSessionState{ID: id, Updated: updated, Archived: archivedAt > 0}
	}
	return states, nil
}

func indexedSessionStates(cfg config, project mappedSyncedProject) (map[string]syncedSessionState, error) {
	states := map[string]syncedSessionState{}
	if strings.TrimSpace(cfg.SoulPBURL) == "" || project.ProjectID == "" {
		return states, nil
	}
	query := url.Values{}
	query.Set("perPage", "200")
	query.Set("filter", fmt.Sprintf("project_id=%q", strings.ReplaceAll(project.ProjectID, `"`, `\"`)))
	var parsed struct {
		Items []struct {
			SessionID string         `json:"session_id"`
			Status    string         `json:"status"`
			Metadata  map[string]any `json:"metadata"`
		} `json:"items"`
	}
	if err := getPocketBaseJSON(cfg.SoulPBURL, "opcp_synced_sessions", query, &parsed); err != nil {
		return nil, err
	}
	for _, item := range parsed.Items {
		if item.SessionID == "" {
			continue
		}
		states[item.SessionID] = syncedSessionState{ID: item.SessionID, Updated: anyInt64(item.Metadata["time_updated"]), Archived: item.Status == "archived"}
	}
	return states, nil
}

func exportOpenCodeSessions(cfg config, dbPath string, project mappedSyncedProject) (int, error) {
	dirs := equivalentSyncedProjectPaths(project)
	conditions := make([]string, 0, len(dirs)*2)
	for _, dir := range dirs {
		conditions = append(conditions, "directory = "+sqlQuote(dir), "path = "+sqlQuote(strings.TrimLeft(dir, string(filepath.Separator))))
	}
	query := "select * from session where " + strings.Join(conditions, " or ")
	sessions, err := sqliteJSONRows(dbPath, query)
	if err != nil {
		return 0, err
	}
	exported := 0
	for _, session := range sessions {
		sessionID, _ := session["id"].(string)
		if sessionID == "" {
			continue
		}
		var messages []map[string]any
		var parts []map[string]any
		var sessionMessages []map[string]any
		if anyInt64(session["time_archived"]) == 0 {
			messages, err = sqliteJSONRows(dbPath, "select * from message where session_id = "+sqlQuote(sessionID)+" order by time_created, id")
			if err != nil {
				return exported, err
			}
			parts, err = sqliteJSONRows(dbPath, "select * from part where session_id = "+sqlQuote(sessionID)+" order by time_created, id")
			if err != nil {
				return exported, err
			}
			sessionMessages, err = sqliteJSONRows(dbPath, "select * from session_message where session_id = "+sqlQuote(sessionID)+" order by time_created, id")
			if err != nil {
				return exported, err
			}
		}
		payload := openCodeSessionPayload{
			Version:          1,
			ExportedAt:       time.Now().UTC().Format(time.RFC3339),
			ProjectID:        project.ProjectID,
			ProjectName:      project.Name,
			SourceDeployment: cfg.DeploymentID,
			Session:          session,
			Messages:         messages,
			Parts:            parts,
			SessionMessages:  sessionMessages,
		}
		if err := writeOpenCodeSessionPayload(project.LocalPath, sessionID, payload); err != nil {
			return exported, err
		}
		if err := upsertSyncedSessionIndex(cfg, project, payload); err != nil {
			return exported, err
		}
		exported++
	}
	return exported, nil
}

func importOpenCodeSessions(cfg config, dbPath string, project mappedSyncedProject) (int, int, error) {
	sessionsDir := filepath.Join(project.LocalPath, ".opencode-plus", "sessions")
	return importOpenCodeSessionsFromDir(cfg, dbPath, project, sessionsDir)
}

func importOpenCodeSessionsFromDir(cfg config, dbPath string, project mappedSyncedProject, sessionsDir string) (int, int, error) {
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		return 0, 0, err
	}
	imported := 0
	indexed := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		payload, err := readOpenCodeSessionPayload(filepath.Join(sessionsDir, entry.Name()))
		if err != nil {
			return imported, indexed, err
		}
		sessionID, _ := payload.Session["id"].(string)
		if sessionID == "" {
			continue
		}
		preferredPath := preferredSyncedProjectOpenPath(project)
		currentUpdated, _ := sqliteScalarInt(dbPath, "select coalesce(time_updated, 0) from session where id = "+sqlQuote(sessionID))
		currentArchived, _ := sqliteScalarInt(dbPath, "select coalesce(time_archived, 0) from session where id = "+sqlQuote(sessionID))
		currentDirectory, _ := sqliteScalarString(dbPath, "select coalesce(directory, '') from session where id = "+sqlQuote(sessionID))
		payloadUpdated := maxInt64(anyInt64(payload.Session["time_updated"]), anyInt64(payload.Session["time_archived"]))
		if currentArchived > 0 && currentArchived >= payloadUpdated {
			if err := upsertLocalSessionIndex(cfg, project, dbPath, sessionID); err != nil {
				return imported, indexed, err
			}
			indexed++
			continue
		}
		if currentUpdated == 0 || payloadUpdated > currentUpdated || currentDirectory != preferredPath {
			if err := importOpenCodeSessionPayload(dbPath, preferredPath, payload); err != nil {
				return imported, indexed, err
			}
			imported++
		}
		if err := upsertSyncedSessionIndex(cfg, project, payload); err != nil {
			return imported, indexed, err
		}
		indexed++
	}
	return imported, indexed, nil
}

func applyIndexedSessionTombstones(cfg config, dbPath string, project mappedSyncedProject) (int, error) {
	indexed, err := indexedSessionStates(cfg, project)
	if err != nil {
		return 0, err
	}
	applied := 0
	for id, state := range indexed {
		if !state.Archived || state.Updated == 0 {
			continue
		}
		currentArchived, _ := sqliteScalarInt(dbPath, "select coalesce(time_archived, 0) from session where id = "+sqlQuote(id))
		currentUpdated, _ := sqliteScalarInt(dbPath, "select coalesce(time_updated, 0) from session where id = "+sqlQuote(id))
		if currentUpdated == 0 || (currentArchived > 0 && currentArchived >= state.Updated) {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		cmd := exec.CommandContext(ctx, "sqlite3", dbPath, "update session set time_archived = "+sqlValue(state.Updated)+", time_updated = "+sqlValue(maxInt64(currentUpdated, state.Updated))+" where id = "+sqlQuote(id))
		output, err := cmd.CombinedOutput()
		cancel()
		if err != nil {
			return applied, fmt.Errorf("sqlite3 tombstone apply failed: %w: %s", err, strings.TrimSpace(string(output)))
		}
		applied++
	}
	return applied, nil
}

func preferredSyncedProjectOpenPath(project mappedSyncedProject) string {
	projectPath := filepath.Clean(project.LocalPath)
	workspaceRoot := workspaceRootForShortcut(filepath.Dir(projectPath))
	for _, name := range []string{project.Name, filepath.Base(projectPath)} {
		folderName := sanitizeProjectFolderName(name)
		if folderName == "" {
			continue
		}
		shortcutPath := filepath.Clean(filepath.Join(workspaceRoot, "#OCP-SyncedProject-"+folderName))
		if _, err := os.Stat(shortcutPath); err == nil {
			return shortcutPath
		}
	}
	return projectPath
}

func equivalentSyncedProjectPaths(project mappedSyncedProject) []string {
	projectPath := filepath.Clean(project.LocalPath)
	paths := []string{projectPath}
	workspaceRoot := workspaceRootForShortcut(filepath.Dir(projectPath))
	for _, name := range []string{project.Name, filepath.Base(projectPath)} {
		folderName := sanitizeProjectFolderName(name)
		if folderName == "" {
			continue
		}
		shortcutPath := filepath.Clean(filepath.Join(workspaceRoot, "#OCP-SyncedProject-"+folderName))
		if _, err := os.Stat(shortcutPath); err == nil {
			paths = appendUniquePath(paths, shortcutPath)
		}
	}
	entries, err := os.ReadDir(workspaceRoot)
	if err != nil {
		return paths
	}
	projectInfo, err := os.Stat(projectPath)
	if err != nil {
		return paths
	}
	seen := map[string]bool{projectPath: true}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "#OCP-SyncedProject-") {
			continue
		}
		candidate := filepath.Join(workspaceRoot, entry.Name())
		candidateInfo, err := os.Stat(candidate)
		if err != nil || !os.SameFile(projectInfo, candidateInfo) {
			continue
		}
		candidate = filepath.Clean(candidate)
		paths = appendUniquePath(paths, candidate)
		seen[candidate] = true
	}
	return paths
}

func appendUniquePath(paths []string, path string) []string {
	for _, existing := range paths {
		if existing == path {
			return paths
		}
	}
	return append(paths, path)
}

func sqliteJSONRows(dbPath, sql string) ([]map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sqlite3", "-json", dbPath, sql)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("sqlite3 query failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	decoder.UseNumber()
	var rows []map[string]any
	if err := decoder.Decode(&rows); err != nil && strings.TrimSpace(string(output)) != "" {
		return nil, err
	}
	return rows, nil
}

func sqliteScalarInt(dbPath, sql string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sqlite3", dbPath, sql)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("sqlite3 scalar failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	value := strings.TrimSpace(string(output))
	if value == "" {
		return 0, nil
	}
	return strconv.ParseInt(value, 10, 64)
}

func sqliteScalarString(dbPath, sql string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sqlite3", dbPath, sql)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("sqlite3 scalar failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func writeOpenCodeSessionPayload(projectPath, sessionID string, payload openCodeSessionPayload) error {
	sessionsDir := filepath.Join(projectPath, ".opencode-plus", "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		return err
	}
	body, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	path := filepath.Join(sessionsDir, sessionID+".json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readOpenCodeSessionPayload(path string) (openCodeSessionPayload, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return openCodeSessionPayload{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var payload openCodeSessionPayload
	if err := decoder.Decode(&payload); err != nil {
		return openCodeSessionPayload{}, err
	}
	return payload, nil
}

func importOpenCodeSessionPayload(dbPath, localPath string, payload openCodeSessionPayload) error {
	session := copyMap(payload.Session)
	session["directory"] = filepath.Clean(localPath)
	session["path"] = strings.TrimLeft(filepath.Clean(localPath), string(filepath.Separator))
	statements := []string{"begin immediate;"}
	statements = append(statements, upsertSQL("session", []string{"id", "project_id", "parent_id", "slug", "directory", "title", "version", "share_url", "summary_additions", "summary_deletions", "summary_files", "summary_diffs", "revert", "permission", "time_created", "time_updated", "time_compacting", "time_archived", "workspace_id", "path", "agent", "model"}, session))
	for _, row := range payload.Messages {
		statements = append(statements, upsertSQL("message", []string{"id", "session_id", "time_created", "time_updated", "data"}, row))
	}
	for _, row := range payload.Parts {
		statements = append(statements, upsertSQL("part", []string{"id", "message_id", "session_id", "time_created", "time_updated", "data"}, row))
	}
	for _, row := range payload.SessionMessages {
		statements = append(statements, upsertSQL("session_message", []string{"id", "session_id", "type", "time_created", "time_updated", "data"}, row))
	}
	statements = append(statements, "commit;")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sqlite3", dbPath)
	cmd.Stdin = strings.NewReader(strings.Join(statements, "\n"))
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("sqlite3 import failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func upsertSQL(table string, columns []string, row map[string]any) string {
	values := make([]string, 0, len(columns))
	updates := make([]string, 0, len(columns)-1)
	for _, column := range columns {
		values = append(values, sqlValue(row[column]))
		if column != "id" {
			updates = append(updates, column+"=excluded."+column)
		}
	}
	return "insert into " + table + " (" + strings.Join(columns, ",") + ") values (" + strings.Join(values, ",") + ") on conflict(id) do update set " + strings.Join(updates, ",") + ";"
}

func sqlValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return "NULL"
	case string:
		return sqlQuote(typed)
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case bool:
		if typed {
			return "1"
		}
		return "0"
	default:
		body, _ := json.Marshal(typed)
		return sqlQuote(string(body))
	}
}

func copyMap(source map[string]any) map[string]any {
	target := make(map[string]any, len(source))
	for key, value := range source {
		target[key] = value
	}
	return target
}

func anyInt64(value any) int64 {
	switch typed := value.(type) {
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	case float64:
		return int64(typed)
	case int64:
		return typed
	case int:
		return int64(typed)
	case string:
		parsed, _ := strconv.ParseInt(typed, 10, 64)
		return parsed
	default:
		return 0
	}
}

func maxInt64(a, b int64) int64 {
	if b > a {
		return b
	}
	return a
}

func upsertSyncedSessionIndex(cfg config, project mappedSyncedProject, payload openCodeSessionPayload) error {
	sessionID, _ := payload.Session["id"].(string)
	if sessionID == "" || strings.TrimSpace(cfg.SoulPBURL) == "" {
		return nil
	}
	projectID := firstNonEmpty(payload.ProjectID, project.ProjectID)
	spaceID := project.SpaceID
	payloadPath := filepath.ToSlash(filepath.Join(".opencode-plus", "sessions", sessionID+".json"))
	payloadBody := map[string]any{
		"session_id":            sessionID,
		"project_id":            projectID,
		"space_id":              spaceID,
		"title":                 stringValue(payload.Session["title"]),
		"payload_path":          payloadPath,
		"created_by_deployment": firstNonEmpty(payload.SourceDeployment, cfg.DeploymentID),
		"updated_by_deployment": cfg.DeploymentID,
		"status":                mapBool(anyInt64(payload.Session["time_archived"]) > 0, "archived", "available"),
		"metadata": map[string]any{
			"time_created":  anyInt64(payload.Session["time_created"]),
			"time_updated":  maxInt64(anyInt64(payload.Session["time_updated"]), anyInt64(payload.Session["time_archived"])),
			"time_archived": anyInt64(payload.Session["time_archived"]),
			"project_name":  project.Name,
		},
	}
	query := url.Values{"perPage": {"1"}, "filter": {fmt.Sprintf("session_id = %q", strings.ReplaceAll(sessionID, `"`, `\"`))}}
	id, err := firstPocketBaseRecordID(cfg.SoulPBURL, "opcp_synced_sessions", query)
	if err != nil {
		return err
	}
	if id == "" {
		return createPocketBaseRecord(cfg.SoulPBURL, "opcp_synced_sessions", payloadBody)
	}
	return patchPocketBaseRecord(cfg.SoulPBURL, "opcp_synced_sessions", id, payloadBody)
}

func upsertLocalSessionIndex(cfg config, project mappedSyncedProject, dbPath, sessionID string) error {
	rows, err := sqliteJSONRows(dbPath, "select * from session where id = "+sqlQuote(sessionID))
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	payload := openCodeSessionPayload{
		Version:          1,
		ExportedAt:       time.Now().UTC().Format(time.RFC3339),
		ProjectID:        project.ProjectID,
		ProjectName:      project.Name,
		SourceDeployment: cfg.DeploymentID,
		Session:          rows[0],
	}
	return upsertSyncedSessionIndex(cfg, project, payload)
}

func stringValue(value any) string {
	if typed, ok := value.(string); ok {
		return typed
	}
	return ""
}

func openCodeProjectID(localPath string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(localPath)))
	return "opcp_" + fmt.Sprintf("%x", sum[:])[:24]
}

func sqlQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func sanitizeProjectFolderName(value string) string {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, "\\", "-")
	value = strings.ReplaceAll(value, "/", "-")
	parts := strings.Fields(value)
	value = strings.Join(parts, "-")
	value = strings.Trim(value, ".-_")
	if value == "." || value == ".." {
		return ""
	}
	return value
}

func initializeProjectSessionSync(projectPath, projectID, spaceID, deploymentID string) (map[string]any, error) {
	root := filepath.Join(projectPath, ".opencode-plus")
	sessionsDir := filepath.Join(root, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		return nil, err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	manifestPath := filepath.Join(root, "manifest.json")
	manifest := map[string]any{
		"version":               1,
		"kind":                  "opencode-plus-synced-project",
		"project_id":            projectID,
		"space_id":              spaceID,
		"created_by_deployment": deploymentID,
		"created_at":            now,
		"session_sync": map[string]any{
			"enabled":             true,
			"index":               "pocketbase:opcp_synced_sessions",
			"payload_dir":         ".opencode-plus/sessions",
			"payload_description": "Full session payloads live here; PocketBase stores only the lightweight index.",
		},
	}
	body, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	body = append(body, '\n')
	if err := os.WriteFile(manifestPath, body, 0o644); err != nil {
		return nil, err
	}
	keepPath := filepath.Join(sessionsDir, ".keep")
	if _, err := os.Stat(keepPath); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(keepPath, []byte("OpenCode Plus synced session payloads will be stored here.\n"), 0o644); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	return map[string]any{
		"enabled":       true,
		"manifest_path": filepath.ToSlash(filepath.Join(".opencode-plus", "manifest.json")),
		"payload_dir":   filepath.ToSlash(filepath.Join(".opencode-plus", "sessions")),
		"index":         "pocketbase:opcp_synced_sessions",
	}, nil
}

func soulDeploymentHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/__opencode-plus/soul/deployments/"), "/")
		if id == "" || strings.Contains(id, "/") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_deployment_record"})
			return
		}
		record, err := findPocketBaseDeploymentByRecordID(cfg.SoulPBURL, id)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "deployment_lookup_failed", "detail": err.Error()})
			return
		}
		if record.ID == "" {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "deployment_not_found"})
			return
		}
		if record.DeploymentID == cfg.DeploymentID {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot_delete_current_deployment"})
			return
		}
		if err := deletePocketBaseRecord(cfg.SoulPBURL, "opcp_deployments", id); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "deployment_delete_failed", "detail": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": id})
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

type pocketBaseNamedSpaceRecord struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type pocketBaseDeploymentSpacePathRecord struct {
	ID           string `json:"id"`
	DeploymentID string `json:"deployment_id"`
	SpaceID      string `json:"space_id"`
	LocalPath    string `json:"local_path"`
	Enabled      bool   `json:"enabled"`
}

type pocketBaseSyncedProjectRecord struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	SpaceID  string         `json:"space_id"`
	Enabled  bool           `json:"enabled"`
	Metadata map[string]any `json:"metadata"`
}

type pocketBaseDeploymentProjectPathRecord struct {
	ID           string `json:"id"`
	DeploymentID string `json:"deployment_id"`
	ProjectID    string `json:"project_id"`
	LocalPath    string `json:"local_path"`
	Enabled      bool   `json:"enabled"`
}

type mappedSyncedProject struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	SpaceID   string `json:"space_id,omitempty"`
	Name      string `json:"name"`
	LocalPath string `json:"local_path"`
	OpenURL   string `json:"open_url"`
	IconURL   string `json:"icon_url,omitempty"`
}

type openCodeSessionPayload struct {
	Version          int              `json:"version"`
	ExportedAt       string           `json:"exported_at"`
	ProjectID        string           `json:"project_id"`
	ProjectName      string           `json:"project_name"`
	SourceDeployment string           `json:"source_deployment"`
	Session          map[string]any   `json:"session"`
	Messages         []map[string]any `json:"messages,omitempty"`
	Parts            []map[string]any `json:"parts,omitempty"`
	SessionMessages  []map[string]any `json:"session_messages,omitempty"`
}

type mappedNamedWorkspace struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	LocalPath  string `json:"local_path"`
	RemotePath string `json:"remote_path,omitempty"`
	Provider   string `json:"provider,omitempty"`
}

type pocketBaseIDRecord struct {
	ID string `json:"id"`
}

func ensureDefaultNamedSpace(baseURL string) (string, bool, error) {
	if id, err := firstPocketBaseRecordID(baseURL, "opcp_named_spaces", url.Values{"perPage": {"1"}}); err != nil || id != "" {
		return id, false, err
	}
	record, err := createPocketBaseRecordReturning(baseURL, "opcp_named_spaces", map[string]any{
		"name":          "default",
		"description":   "Default OpenCode Plus synchronization space.",
		"expected_kind": "workspace",
		"sync_mode":     "external",
		"enabled":       true,
	})
	if err != nil {
		return "", false, err
	}
	return record.ID, true, nil
}

func ensureSyncedProject(baseURL, name, spaceID, localPath string) (string, bool, error) {
	query := url.Values{"perPage": {"1"}, "filter": {fmt.Sprintf("name = %q", strings.ReplaceAll(name, `"`, `\"`))}}
	if id, err := firstPocketBaseRecordID(baseURL, "opcp_synced_projects", query); err != nil || id != "" {
		return id, false, err
	}
	record, err := createPocketBaseRecordReturning(baseURL, "opcp_synced_projects", map[string]any{
		"name":        name,
		"description": "Created from OpenCode Plus synchronization setup.",
		"space_id":    spaceID,
		"enabled":     true,
		"metadata": map[string]any{
			"created_by": "opencode-plus",
			"local_path": localPath,
		},
	})
	if err != nil {
		return "", false, err
	}
	return record.ID, true, nil
}

func ensureDeploymentProjectPath(baseURL, deploymentID, projectID, localPath string) (bool, error) {
	query := url.Values{"perPage": {"1"}, "filter": {fmt.Sprintf("deployment_id = %q && project_id = %q", strings.ReplaceAll(deploymentID, `"`, `\"`), strings.ReplaceAll(projectID, `"`, `\"`))}}
	if id, err := firstPocketBaseRecordID(baseURL, "opcp_deployment_project_paths", query); err != nil || id != "" {
		if err != nil {
			return false, err
		}
		return false, patchPocketBaseRecord(baseURL, "opcp_deployment_project_paths", id, map[string]any{"local_path": localPath, "enabled": true})
	}
	_, err := createPocketBaseRecordReturning(baseURL, "opcp_deployment_project_paths", map[string]any{
		"deployment_id": deploymentID,
		"project_id":    projectID,
		"local_path":    localPath,
		"enabled":       true,
	})
	return true, err
}

func ensureDeploymentSpacePath(baseURL, deploymentID, spaceID, localPath string) (bool, error) {
	query := url.Values{"perPage": {"1"}, "filter": {fmt.Sprintf("deployment_id = %q && space_id = %q", strings.ReplaceAll(deploymentID, `"`, `\"`), strings.ReplaceAll(spaceID, `"`, `\"`))}}
	if id, err := firstPocketBaseRecordID(baseURL, "opcp_deployment_space_paths", query); err != nil || id != "" {
		if err != nil {
			return false, err
		}
		return false, patchPocketBaseRecord(baseURL, "opcp_deployment_space_paths", id, map[string]any{"local_path": localPath, "enabled": true})
	}
	_, err := createPocketBaseRecordReturning(baseURL, "opcp_deployment_space_paths", map[string]any{
		"deployment_id": deploymentID,
		"space_id":      spaceID,
		"local_path":    localPath,
		"enabled":       true,
	})
	return true, err
}

func listMappedNamedWorkspaces(cfg config) ([]mappedNamedWorkspace, error) {
	store, err := readMountStore(cfg.MountsDir)
	if err != nil {
		return nil, err
	}
	providers := make(map[string]storageProvider, len(store.Providers))
	for _, provider := range store.Providers {
		providers[provider.ID] = provider
	}
	workspaces := make([]mappedNamedWorkspace, 0, len(store.Mounts))
	for _, mount := range store.Mounts {
		if strings.TrimSpace(mount.MountPath) == "" {
			continue
		}
		provider := providers[mount.Remote["provider_id"]]
		providerName := provider.Name
		if providerName == "" {
			providerName = mount.Remote["rclone_remote"]
		}
		workspaces = append(workspaces, mappedNamedWorkspace{
			ID:         mount.ID,
			Name:       mount.Name,
			LocalPath:  mount.MountPath,
			RemotePath: firstNonEmpty(mount.Remote["path"], mount.Remote["share"]),
			Provider:   providerName,
		})
	}
	return workspaces, nil
}

func findMappedNamedWorkspace(cfg config, workspaceID string) (mappedNamedWorkspace, error) {
	workspaces, err := listMappedNamedWorkspaces(cfg)
	if err != nil {
		return mappedNamedWorkspace{}, err
	}
	for _, workspace := range workspaces {
		if workspace.ID == workspaceID {
			return workspace, nil
		}
	}
	return mappedNamedWorkspace{}, nil
}

func readMountStore(configDir string) (mountStore, error) {
	if strings.TrimSpace(configDir) == "" {
		configDir = "/config/persist/opencode-plus-mounts"
	}
	body, err := os.ReadFile(filepath.Join(configDir, "config.json"))
	if errors.Is(err, os.ErrNotExist) {
		return mountStore{}, nil
	}
	if err != nil {
		return mountStore{}, err
	}
	var store mountStore
	if err := json.Unmarshal(body, &store); err != nil {
		return mountStore{}, err
	}
	return store, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func listNamedSpaces(baseURL string) ([]pocketBaseNamedSpaceRecord, error) {
	query := url.Values{"perPage": {"100"}}
	var parsed struct {
		Items []pocketBaseNamedSpaceRecord `json:"items"`
	}
	if err := getPocketBaseJSON(baseURL, "opcp_named_spaces", query, &parsed); err != nil {
		return nil, err
	}
	return parsed.Items, nil
}

func listDeploymentSpacePaths(baseURL, deploymentID string) ([]pocketBaseDeploymentSpacePathRecord, error) {
	query := url.Values{"perPage": {"100"}, "filter": {fmt.Sprintf("deployment_id = %q", strings.ReplaceAll(deploymentID, `"`, `\"`))}}
	var parsed struct {
		Items []pocketBaseDeploymentSpacePathRecord `json:"items"`
	}
	if err := getPocketBaseJSON(baseURL, "opcp_deployment_space_paths", query, &parsed); err != nil {
		return nil, err
	}
	return parsed.Items, nil
}

func deploymentProjectPathExists(baseURL, deploymentID, localPath string) (bool, error) {
	query := url.Values{"perPage": {"1"}, "filter": {fmt.Sprintf("deployment_id = %q && local_path = %q && enabled = true", strings.ReplaceAll(deploymentID, `"`, `\"`), strings.ReplaceAll(localPath, `"`, `\"`))}}
	id, err := firstPocketBaseRecordID(baseURL, "opcp_deployment_project_paths", query)
	return id != "", err
}

func listMappedSyncedProjects(cfg config) ([]mappedSyncedProject, error) {
	projects, err := listSyncedProjects(cfg.SoulPBURL)
	if err != nil {
		return nil, err
	}
	paths, err := listDeploymentProjectPaths(cfg.SoulPBURL, cfg.DeploymentID)
	if err != nil {
		return nil, err
	}
	workspaces, err := listMappedNamedWorkspaces(cfg)
	if err != nil {
		return nil, err
	}
	workspaceRoots := make([]string, 0, len(workspaces))
	for _, workspace := range workspaces {
		if strings.TrimSpace(workspace.LocalPath) != "" {
			workspaceRoots = append(workspaceRoots, filepath.Clean(workspace.LocalPath))
		}
	}
	projectNames := make(map[string]string, len(projects))
	projectSpaces := make(map[string]string, len(projects))
	for _, project := range projects {
		projectNames[project.ID] = project.Name
		projectSpaces[project.ID] = project.SpaceID
	}
	mapped := make([]mappedSyncedProject, 0, len(paths))
	for _, path := range paths {
		if !path.Enabled || strings.TrimSpace(path.LocalPath) == "" {
			continue
		}
		if !pathIsInsideAnyRoot(path.LocalPath, workspaceRoots) {
			continue
		}
		openURL := "/" + encodeOpenCodeProjectPath(path.LocalPath) + "/session"
		project := mappedSyncedProject{ID: path.ID, ProjectID: path.ProjectID, SpaceID: projectSpaces[path.ProjectID], Name: projectNames[path.ProjectID], LocalPath: path.LocalPath, OpenURL: openURL}
		_ = pullProjectIconFromRemote(cfg, project)
		if iconURL, err := syncedProjectIconDataURL(path.LocalPath); err == nil && iconURL != "" {
			project.IconURL = iconURL
			_ = applySyncedProjectIcon(path.LocalPath, project.Name, iconURL)
		}
		mapped = append(mapped, project)
	}
	return mapped, nil
}

func pullProjectIconFromRemote(cfg config, project mappedSyncedProject) error {
	remote, local, err := rcloneProjectRemoteAndLocal(cfg, project, ".opencode-plus")
	if err != nil || remote == "" || local == "" {
		return err
	}
	if err := os.MkdirAll(local, 0o755); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "rclone", "copy", remote, local, "--include", "project-icon.*", "--retries", "1", "--low-level-retries", "1", "--stats", "0")
	cmd.Env = rcloneEnv()
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("rclone project icon pull failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func syncedProjectIconDataURL(projectPath string) (string, error) {
	root := filepath.Join(projectPath, ".opencode-plus")
	for _, candidate := range []struct {
		Name string
		Mime string
	}{
		{Name: "project-icon.png", Mime: "image/png"},
		{Name: "project-icon.jpg", Mime: "image/jpeg"},
		{Name: "project-icon.gif", Mime: "image/gif"},
	} {
		body, err := os.ReadFile(filepath.Join(root, candidate.Name))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if _, _, err := validateProjectIcon(body); err != nil {
			continue
		}
		return "data:" + candidate.Mime + ";base64," + base64.StdEncoding.EncodeToString(body), nil
	}
	return "", nil
}

func applySyncedProjectIcon(projectPath, name, iconURL string) error {
	if strings.TrimSpace(iconURL) == "" {
		return nil
	}
	dbPath := openCodeDBPath()
	if _, err := os.Stat(dbPath); err != nil {
		return err
	}
	paths := equivalentSyncedProjectPaths(mappedSyncedProject{Name: name, LocalPath: projectPath})
	for _, path := range paths {
		if err := registerOpenCodeProject(name, path); err != nil {
			return err
		}
		if err := updateOpenCodeProjectIcon(dbPath, path, iconURL); err != nil {
			return err
		}
	}
	return nil
}

func updateOpenCodeProjectIcon(dbPath, localPath, iconURL string) error {
	id := openCodeProjectID(localPath)
	return updateOpenCodeProjectIconByID(dbPath, id, iconURL)
}

func updateOpenCodeProjectIconByID(dbPath, id, iconURL string) error {
	now := time.Now().UnixMilli()
	sql := fmt.Sprintf("UPDATE project SET icon_url_override=%s, time_updated=%d WHERE id=%s;", sqlQuote(iconURL), now, sqlQuote(id))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "sqlite3", dbPath, sql).CombinedOutput()
	if err != nil {
		return fmt.Errorf("sqlite3 project icon update failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func encodeOpenCodeProjectPath(path string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(filepath.Clean(path)))
}

func pathIsInsideAnyRoot(path string, roots []string) bool {
	cleanPath := filepath.Clean(path)
	for _, root := range roots {
		cleanRoot := filepath.Clean(root)
		if cleanRoot == "." || cleanRoot == string(filepath.Separator) || cleanPath == cleanRoot {
			continue
		}
		prefix := strings.TrimRight(cleanRoot, string(filepath.Separator)) + string(filepath.Separator)
		if strings.HasPrefix(cleanPath, prefix) {
			return true
		}
	}
	return false
}

func listSyncedProjects(baseURL string) ([]pocketBaseSyncedProjectRecord, error) {
	query := url.Values{"perPage": {"100"}}
	var parsed struct {
		Items []pocketBaseSyncedProjectRecord `json:"items"`
	}
	if err := getPocketBaseJSON(baseURL, "opcp_synced_projects", query, &parsed); err != nil {
		return nil, err
	}
	return parsed.Items, nil
}

func findSyncedProjectByRecordID(baseURL, id string) (pocketBaseSyncedProjectRecord, error) {
	var record pocketBaseSyncedProjectRecord
	endpoint := strings.TrimRight(baseURL, "/") + "/api/collections/opcp_synced_projects/records/" + url.PathEscape(id)
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return pocketBaseSyncedProjectRecord{}, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return pocketBaseSyncedProjectRecord{}, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode == http.StatusNotFound {
		return pocketBaseSyncedProjectRecord{}, nil
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return pocketBaseSyncedProjectRecord{}, fmt.Errorf("PocketBase synced project lookup failed: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	if err := json.Unmarshal(body, &record); err != nil {
		return pocketBaseSyncedProjectRecord{}, err
	}
	return record, nil
}

func listDeploymentProjectPaths(baseURL, deploymentID string) ([]pocketBaseDeploymentProjectPathRecord, error) {
	query := url.Values{"perPage": {"100"}, "filter": {fmt.Sprintf("deployment_id = %q", strings.ReplaceAll(deploymentID, `"`, `\"`))}}
	var parsed struct {
		Items []pocketBaseDeploymentProjectPathRecord `json:"items"`
	}
	if err := getPocketBaseJSON(baseURL, "opcp_deployment_project_paths", query, &parsed); err != nil {
		return nil, err
	}
	return parsed.Items, nil
}

func findDeploymentProjectPathByRecordID(baseURL, id string) (pocketBaseDeploymentProjectPathRecord, error) {
	var record pocketBaseDeploymentProjectPathRecord
	endpoint := strings.TrimRight(baseURL, "/") + "/api/collections/opcp_deployment_project_paths/records/" + url.PathEscape(id)
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return pocketBaseDeploymentProjectPathRecord{}, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return pocketBaseDeploymentProjectPathRecord{}, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode == http.StatusNotFound {
		return pocketBaseDeploymentProjectPathRecord{}, nil
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return pocketBaseDeploymentProjectPathRecord{}, fmt.Errorf("PocketBase project mapping lookup failed: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	if err := json.Unmarshal(body, &record); err != nil {
		return pocketBaseDeploymentProjectPathRecord{}, err
	}
	return record, nil
}

func firstPocketBaseRecordID(baseURL, collection string, query url.Values) (string, error) {
	var parsed struct {
		Items []pocketBaseIDRecord `json:"items"`
	}
	if err := getPocketBaseJSON(baseURL, collection, query, &parsed); err != nil {
		return "", err
	}
	if len(parsed.Items) == 0 {
		return "", nil
	}
	return parsed.Items[0].ID, nil
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

func findPocketBaseDeploymentByRecordID(baseURL, id string) (pocketBaseDeploymentRecord, error) {
	var record pocketBaseDeploymentRecord
	endpoint := strings.TrimRight(baseURL, "/") + "/api/collections/opcp_deployments/records/" + url.PathEscape(id)
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return pocketBaseDeploymentRecord{}, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return pocketBaseDeploymentRecord{}, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode == http.StatusNotFound {
		return pocketBaseDeploymentRecord{}, nil
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return pocketBaseDeploymentRecord{}, fmt.Errorf("PocketBase deployment lookup failed: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	if err := json.Unmarshal(body, &record); err != nil {
		return pocketBaseDeploymentRecord{}, err
	}
	return record, nil
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
	_, err := writePocketBaseRecord(http.MethodPost, strings.TrimRight(baseURL, "/")+"/api/collections/"+url.PathEscape(collection)+"/records", payload)
	return err
}

func createPocketBaseRecordReturning(baseURL, collection string, payload map[string]any) (pocketBaseIDRecord, error) {
	body, err := writePocketBaseRecord(http.MethodPost, strings.TrimRight(baseURL, "/")+"/api/collections/"+url.PathEscape(collection)+"/records", payload)
	if err != nil {
		return pocketBaseIDRecord{}, err
	}
	var record pocketBaseIDRecord
	if err := json.Unmarshal(body, &record); err != nil {
		return pocketBaseIDRecord{}, err
	}
	if record.ID == "" {
		return pocketBaseIDRecord{}, errors.New("PocketBase create returned no record id")
	}
	return record, nil
}

func patchPocketBaseRecord(baseURL, collection, id string, payload map[string]any) error {
	_, err := writePocketBaseRecord(http.MethodPatch, strings.TrimRight(baseURL, "/")+"/api/collections/"+url.PathEscape(collection)+"/records/"+url.PathEscape(id), payload)
	return err
}

func deletePocketBaseRecord(baseURL, collection, id string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	endpoint := strings.TrimRight(baseURL, "/") + "/api/collections/" + url.PathEscape(collection) + "/records/" + url.PathEscape(id)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("PocketBase delete failed: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

func writePocketBaseRecord(method, endpoint string, payload map[string]any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	resBody, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("PocketBase write failed: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(resBody)))
	}
	return resBody, nil
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
		"synced_sessions": "opcp_synced_sessions",
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
		GeminiAuthSource    string  `json:"gemini_auth_source"`
		OpenAIAuthSource    string  `json:"openai_auth_source"`
		AnthropicAuthSource string  `json:"anthropic_auth_source"`
		InstanceName        *string `json:"instance_name"`
		SoulDBEnabled       *bool   `json:"soul_db_enabled"`
		SoulPBURL           *string `json:"soul_pb_url"`
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
			if update.InstanceName != nil {
				name := normalizeInstanceName(*update.InstanceName)
				if name == "" {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_instance_name"})
					return
				}
				current.InstanceName = name
			}
			if update.SoulDBEnabled != nil {
				enabled := *update.SoulDBEnabled
				current.SoulDBEnabled = &enabled
			}
			if update.SoulPBURL != nil {
				pbURL := normalizePocketBaseURL(*update.SoulPBURL)
				if pbURL == "" {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_soul_pb_url"})
					return
				}
				current.SoulPBURL = pbURL
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

func restartGatewayHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, "bash", "-lc", "sleep 1; supervisorctl restart opencode-cf-auth-proxy")
			if output, err := cmd.CombinedOutput(); err != nil {
				log.Printf("opencode-cf-auth-proxy restart failed: %v: %s", err, strings.TrimSpace(string(output)))
			} else {
				log.Printf("opencode-cf-auth-proxy restart requested: %s", strings.TrimSpace(string(output)))
			}
		}()

		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "status": "restart_queued", "service": "opencode-cf-auth-proxy"})
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
	loaded.InstanceName = normalizeInstanceName(loaded.InstanceName)
	loaded.SoulPBURL = normalizePocketBaseURL(loaded.SoulPBURL)
	return loaded
}

func writePlusConfig(cfg config, next plusConfig) error {
	next.GeminiAuthSource = normalizedOrDefault(normalizeGeminiAuthSource(next.GeminiAuthSource), "auto")
	next.OpenAIAuthSource = normalizedOrDefault(normalizeOpenAIAuthSource(next.OpenAIAuthSource), "auto")
	next.AnthropicAuthSource = normalizedOrDefault(normalizeAnthropicAuthSource(next.AnthropicAuthSource), "auto")
	next.InstanceName = normalizeInstanceName(next.InstanceName)
	next.SoulPBURL = normalizePocketBaseURL(next.SoulPBURL)
	if err := os.MkdirAll(filepath.Dir(cfg.ConfigFile), 0o700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(cfg.ConfigFile, append(body, '\n'), 0o600)
}

func normalizePocketBaseURL(value string) string {
	value = strings.TrimRight(strings.TrimSpace(value), "/")
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	return value
}

func normalizeInstanceName(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 80 {
		value = value[:80]
	}
	value = strings.Join(strings.Fields(value), " ")
	if value == "" {
		return ""
	}
	for _, r := range value {
		if r < 32 || r == 127 || strings.ContainsRune(`/\\"'`, r) {
			return ""
		}
	}
	return value
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
