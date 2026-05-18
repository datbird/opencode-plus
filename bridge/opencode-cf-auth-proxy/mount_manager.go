package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	mountStatusDisconnected = "disconnected"
	mountStatusConnecting   = "connecting"
	mountStatusConnected    = "connected"
	mountStatusUnreachable  = "unreachable"
	mountStatusAuthFailed   = "auth_failed"
	mountStatusTimeout      = "timeout"
	mountStatusStale        = "stale"
	mountStatusSynced       = "synced"
	mountStatusError        = "error"
	mountStatusDisabled     = "disabled"
	rcloneConfigFile        = "/config/persist/opencode-plus-mounts/rclone.conf"
	rcloneCacheDir          = "/config/persist/opencode-plus-mounts/rclone-cache"
)

var safeMountNamePattern = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

type mountManager struct {
	mu        sync.Mutex
	configDir string
	configs   map[string]mountConfig
	providers map[string]storageProvider
	secrets   map[string]mountSecret
	states    map[string]mountRuntimeState
	processes map[string]*exec.Cmd
	stop      chan struct{}
}

type mountStore struct {
	Mounts    []mountConfig     `json:"mounts"`
	Providers []storageProvider `json:"providers,omitempty"`
}

type mountSecretStore struct {
	Secrets map[string]mountSecret `json:"secrets"`
}

type mountConfig struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Type          string            `json:"type"`
	WorkspaceRoot string            `json:"workspace_root"`
	MountPath     string            `json:"mount_path"`
	Remote        map[string]string `json:"remote,omitempty"`
	Options       mountOptions      `json:"options"`
	CreatedAt     string            `json:"created_at"`
	UpdatedAt     string            `json:"updated_at"`
}

type storageProvider struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Type      string            `json:"type"`
	Remote    map[string]string `json:"remote,omitempty"`
	CreatedAt string            `json:"created_at"`
	UpdatedAt string            `json:"updated_at"`
}

type mountOptions struct {
	ReadOnly      bool `json:"read_only"`
	AutoConnect   bool `json:"auto_connect"`
	AutoReconnect bool `json:"auto_reconnect"`
	SyncMode      string `json:"sync_mode,omitempty"`
}

type mountSecret struct {
	Username   string `json:"username,omitempty"`
	Password   string `json:"password,omitempty"`
	PrivateKey string `json:"private_key,omitempty"`
}

type mountRuntimeState struct {
	Status        string `json:"status"`
	LastError     string `json:"last_error,omitempty"`
	LastCheckedAt string `json:"last_checked_at,omitempty"`
	NextRetryAt   string `json:"next_retry_at,omitempty"`
	RetryCount    int    `json:"retry_count"`
	PID           int    `json:"pid,omitempty"`
	ConnectedAt   string `json:"connected_at,omitempty"`
}

type mountCreateRequest struct {
	Name          string            `json:"name"`
	Type          string            `json:"type"`
	ProviderID    string            `json:"provider_id"`
	WorkspaceRoot string            `json:"workspace_root"`
	MountName     string            `json:"mount_name"`
	Remote        map[string]string `json:"remote"`
	Options       mountOptions      `json:"options"`
	Secret        mountSecret       `json:"secret"`
}

type providerCreateRequest struct {
	Name   string            `json:"name"`
	Type   string            `json:"type"`
	Remote map[string]string `json:"remote"`
	Secret mountSecret       `json:"secret"`
}

func newMountManager(cfg config) *mountManager {
	m := &mountManager{
		configDir: strings.TrimSpace(cfg.MountsDir),
		configs:   map[string]mountConfig{},
		providers: map[string]storageProvider{},
		secrets:   map[string]mountSecret{},
		states:    map[string]mountRuntimeState{},
		processes: map[string]*exec.Cmd{},
		stop:      make(chan struct{}),
	}
	if m.configDir == "" {
		m.configDir = "/config/persist/opencode-plus-mounts"
	}
	if err := m.load(); err != nil {
		log.Printf("mount manager load failed: %v", err)
	}
	return m
}

func (m *mountManager) Start() {
	go m.loop()
}

func (m *mountManager) CollectionHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mounts": m.snapshots()})
		case http.MethodPost:
			defer r.Body.Close()
			var request mountCreateRequest
			if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&request); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
				return
			}
			created, err := m.create(request)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_mount", "detail": err.Error()})
				return
			}
			writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "mount": created})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

func (m *mountManager) ProviderCollectionHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "providers": m.providerSnapshots()})
		case http.MethodPost:
			defer r.Body.Close()
			var request providerCreateRequest
			if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&request); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
				return
			}
			provider, err := m.createProvider(request)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_provider", "detail": err.Error()})
				return
			}
			writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "provider": provider})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

func (m *mountManager) ProviderItemHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/__opencode-plus/storage-providers/"), "/")
		if id == "" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		switch r.Method {
		case http.MethodDelete:
			if err := m.deleteProvider(id); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "provider_delete_failed", "detail": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

func (m *mountManager) ItemHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/__opencode-plus/mounts/"), "/")
		if len(parts) == 0 || parts[0] == "" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		id := parts[0]
		action := ""
		if len(parts) > 1 {
			action = parts[1]
		}

		switch {
		case r.Method == http.MethodGet && action == "":
			snapshot, ok := m.snapshot(id)
			if !ok {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "mount_not_found"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mount": snapshot})
		case r.Method == http.MethodDelete && action == "":
			if err := m.delete(id); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "mount_delete_failed", "detail": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		case (r.Method == http.MethodPut || r.Method == http.MethodPatch) && action == "":
			defer r.Body.Close()
			var request mountCreateRequest
			if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&request); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
				return
			}
			updated, err := m.update(id, request)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "mount_update_failed", "detail": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mount": updated})
		case r.Method == http.MethodPost && action == "connect":
			go m.connect(id, true)
			writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "status": "connecting"})
		case r.Method == http.MethodPost && action == "disconnect":
			if err := m.disconnect(id); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "mount_disconnect_failed", "detail": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": "disconnected"})
		case r.Method == http.MethodPost && action == "test":
			result := m.test(id)
			writeJSON(w, http.StatusOK, map[string]any{"ok": result.Status == mountStatusConnected, "status": result})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

func (m *mountManager) update(id string, request mountCreateRequest) (map[string]any, error) {
	old, _, ok := m.configAndSecret(id)
	if !ok {
		return nil, errors.New("mount_not_found")
	}
	updated, err := m.buildConfigFromRequest(request, old.ID, old.CreatedAt)
	if err != nil {
		return nil, err
	}
	_ = m.disconnect(id)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.configs[id] = updated.config
	m.secrets[id] = updated.secret
	m.states[id] = mountRuntimeState{Status: mountStatusDisconnected, LastCheckedAt: time.Now().UTC().Format(time.RFC3339)}
	if err := m.saveLocked(); err != nil {
		return nil, err
	}
	return m.snapshotLocked(id), nil
}

type builtMountConfig struct {
	config mountConfig
	secret mountSecret
}

func (m *mountManager) buildConfigFromRequest(request mountCreateRequest, id, createdAt string) (builtMountConfig, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	if id == "" {
		id = randomID("mnt")
	}
	if createdAt == "" {
		createdAt = now
	}
	mountName := safeMountName(request.MountName)
	if mountName == "" {
		mountName = safeMountName(request.Name)
	}
	if mountName == "" {
		return builtMountConfig{}, errors.New("mount_name_required")
	}
	workspaceRoot := filepath.Clean(strings.TrimSpace(request.WorkspaceRoot))
	if workspaceRoot == "." || !filepath.IsAbs(workspaceRoot) {
		return builtMountConfig{}, errors.New("workspace_root_must_be_absolute")
	}
	mountPath := filepath.Join(workspaceRoot, "mounts", mountName)
	if err := validateMountPath(workspaceRoot, mountPath); err != nil {
		return builtMountConfig{}, err
	}
	mountType := normalizeMountType(request.Type)
	providerSecret := mountSecret{}
	if strings.TrimSpace(request.ProviderID) != "" {
		provider, ok := m.provider(strings.TrimSpace(request.ProviderID))
		if !ok {
			return builtMountConfig{}, errors.New("provider_not_found")
		}
		mountType = provider.Type
		providerSecret = m.providerSecret(provider.ID)
		mergedRemote := map[string]string{}
		for key, value := range provider.Remote {
			mergedRemote[key] = value
		}
		for key, value := range request.Remote {
			if strings.TrimSpace(value) != "" {
				mergedRemote[key] = value
			}
		}
		request.Remote = mergedRemote
	}
	if mountType == "" {
		return builtMountConfig{}, errors.New("unsupported_mount_type")
	}
	if strings.TrimSpace(request.Name) == "" {
		request.Name = mountName
	}
	if request.Remote == nil {
		request.Remote = map[string]string{}
	}
	if strings.TrimSpace(request.Secret.Username) == "" {
		request.Secret.Username = providerSecret.Username
	}
	if strings.TrimSpace(request.Secret.Password) == "" {
		request.Secret.Password = providerSecret.Password
	}
	if strings.TrimSpace(request.Secret.PrivateKey) == "" {
		request.Secret.PrivateKey = providerSecret.PrivateKey
	}
	return builtMountConfig{config: mountConfig{ID: id, Name: strings.TrimSpace(request.Name), Type: mountType, WorkspaceRoot: workspaceRoot, MountPath: mountPath, Remote: trimStringMap(request.Remote), Options: request.Options, CreatedAt: createdAt, UpdatedAt: now}, secret: request.Secret}, nil
}

func (m *mountManager) create(request mountCreateRequest) (map[string]any, error) {
	built, err := m.buildConfigFromRequest(request, "", "")
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	m.configs[built.config.ID] = built.config
	m.secrets[built.config.ID] = built.secret
	m.states[built.config.ID] = mountRuntimeState{Status: mountStatusDisconnected}
	if err := m.saveLocked(); err != nil {
		delete(m.configs, built.config.ID)
		delete(m.secrets, built.config.ID)
		delete(m.states, built.config.ID)
		return nil, err
	}
	return m.snapshotLocked(built.config.ID), nil
}

func (m *mountManager) createProvider(request providerCreateRequest) (map[string]any, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	providerType := normalizeMountType(request.Type)
	if providerType == "" {
		return nil, errors.New("unsupported_provider_type")
	}
	name := strings.TrimSpace(request.Name)
	if name == "" {
		name = providerType
	}
	provider := storageProvider{
		ID:        randomID("src"),
		Name:      name,
		Type:      providerType,
		Remote:    trimStringMap(request.Remote),
		CreatedAt: now,
		UpdatedAt: now,
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.providers[provider.ID] = provider
	m.secrets[provider.ID] = request.Secret
	if err := m.saveLocked(); err != nil {
		delete(m.providers, provider.ID)
		delete(m.secrets, provider.ID)
		return nil, err
	}
	return m.providerSnapshotLocked(provider.ID), nil
}

func (m *mountManager) deleteProvider(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.providers[id]; !ok {
		return errors.New("provider_not_found")
	}
	delete(m.providers, id)
	delete(m.secrets, id)
	return m.saveLocked()
}

func (m *mountManager) delete(id string) error {
	_ = m.disconnect(id)
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.configs[id]; !ok {
		return errors.New("mount_not_found")
	}
	delete(m.configs, id)
	delete(m.secrets, id)
	delete(m.states, id)
	delete(m.processes, id)
	return m.saveLocked()
}

func (m *mountManager) snapshots() []map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]map[string]any, 0, len(m.configs))
	for id := range m.configs {
		result = append(result, m.snapshotLocked(id))
	}
	return result
}

func (m *mountManager) providerSnapshots() []map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	providers := make([]map[string]any, 0, len(m.providers))
	for id := range m.providers {
		providers = append(providers, m.providerSnapshotLocked(id))
	}
	return providers
}

func (m *mountManager) provider(id string) (storageProvider, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	provider, ok := m.providers[id]
	return provider, ok
}

func (m *mountManager) providerSecret(id string) mountSecret {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.secrets[id]
}

func (m *mountManager) providerSnapshotLocked(id string) map[string]any {
	provider := m.providers[id]
	return map[string]any{
		"id":         provider.ID,
		"name":       provider.Name,
		"type":       provider.Type,
		"remote":     redactRemote(provider.Remote),
		"created_at": provider.CreatedAt,
		"updated_at": provider.UpdatedAt,
	}
}

func (m *mountManager) snapshot(id string) (map[string]any, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.configs[id]; !ok {
		return nil, false
	}
	return m.snapshotLocked(id), true
}

func (m *mountManager) snapshotLocked(id string) map[string]any {
	config := m.configs[id]
	state := m.states[id]
	if state.Status == "" {
		state.Status = mountStatusDisconnected
	}
	return map[string]any{
		"id":             config.ID,
		"name":           config.Name,
		"type":           config.Type,
		"workspace_root": config.WorkspaceRoot,
		"mount_path":     config.MountPath,
		"remote":         redactRemote(config.Remote),
		"options":        config.Options,
		"created_at":     config.CreatedAt,
		"updated_at":     config.UpdatedAt,
		"state":          state,
	}
}

func (m *mountManager) connect(id string, manual bool) {
	config, secret, ok := m.configAndSecret(id)
	if !ok {
		return
	}
	if !manual && !config.Options.AutoReconnect && !config.Options.AutoConnect {
		return
	}
	m.setState(id, mountRuntimeState{Status: mountStatusConnecting})
	if err := os.MkdirAll(config.MountPath, 0o755); err != nil {
		m.setFailedState(id, mountStatusError, err)
		return
	}

	if config.Type == "google_drive" && googleDriveSyncMode(config) == "copy" {
		m.syncRcloneRemoteToLocal(id, config)
		return
	}
	if config.Type == "google_drive" && googleDriveSyncMode(config) == "mount" {
		if err := ensureFuseDevice(); err != nil {
			m.setFailedState(id, mountStatusError, err)
			return
		}
		m.startMountProcess(id, config, secret)
		return
	}
	if probe := probeRemote(config, secret, 12*time.Second); probe.Status != mountStatusConnected {
		m.setProbeState(id, probe)
		return
	}
	if config.Type == "smb" {
		if err := ensureFuseDevice(); err != nil {
			m.setFailedState(id, mountStatusError, err)
			return
		}
	}
	m.startMountProcess(id, config, secret)
}

func (m *mountManager) startMountProcess(id string, config mountConfig, secret mountSecret) {
	cmd, cleanup, err := buildMountCommand(config, secret)
	if err != nil {
		m.setFailedState(id, mountStatusError, err)
		return
	}
	if cleanup != nil {
		defer cleanup()
	}
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Start(); err != nil {
		m.setFailedState(id, classifyMountError(err), err)
		return
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err == nil {
			err = errors.New("mount process exited before becoming ready")
		} else if text := strings.TrimSpace(output.String()); text != "" {
			err = fmt.Errorf("%w: %s", err, text)
		}
		m.setFailedState(id, classifyMountError(err), err)
	case <-time.After(1200 * time.Millisecond):
		m.mu.Lock()
		m.processes[id] = cmd
		state := m.states[id]
		state.Status = mountStatusConnected
		state.LastError = ""
		state.RetryCount = 0
		state.NextRetryAt = ""
		state.PID = cmd.Process.Pid
		state.ConnectedAt = time.Now().UTC().Format(time.RFC3339)
		state.LastCheckedAt = state.ConnectedAt
		m.states[id] = state
		_ = m.saveStateLocked()
		m.mu.Unlock()
	}
}

func (m *mountManager) syncRcloneRemoteToLocal(id string, config mountConfig) {
	remoteName := rcloneRemoteName(config)
	remotePath := strings.TrimSpace(config.Remote["path"])
	if remotePath == "" {
		remotePath = strings.TrimSpace(config.Remote["share"])
	}
	if remoteName == "" {
		m.setFailedState(id, mountStatusError, errors.New("rclone_remote_required"))
		return
	}
	remote := remoteName + ":"
	if remotePath != "" {
		remote += strings.TrimPrefix(remotePath, "/")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "rclone", "copy", remote, config.MountPath, "--create-empty-src-dirs", "--retries", "2", "--low-level-retries", "2", "--stats", "0")
	cmd.Env = rcloneEnv()
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		m.setFailedState(id, mountStatusTimeout, ctx.Err())
		return
	}
	if err != nil {
		if text := strings.TrimSpace(string(output)); text != "" {
			err = fmt.Errorf("%w: %s", err, text)
		}
		m.setFailedState(id, classifyMountError(err), err)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	m.setState(id, mountRuntimeState{Status: mountStatusSynced, LastCheckedAt: now, ConnectedAt: now})
}

func (m *mountManager) disconnect(id string) error {
	m.mu.Lock()
	cmd := m.processes[id]
	config, ok := m.configs[id]
	delete(m.processes, id)
	m.mu.Unlock()
	if !ok {
		return errors.New("mount_not_found")
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = exec.CommandContext(ctx, "fusermount3", "-u", config.MountPath).Run()
	if ctx.Err() != nil {
		lazyCtx, lazyCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer lazyCancel()
		_ = exec.CommandContext(lazyCtx, "fusermount3", "-uz", config.MountPath).Run()
	}
	m.setState(id, mountRuntimeState{Status: mountStatusDisconnected, LastCheckedAt: time.Now().UTC().Format(time.RFC3339)})
	return nil
}

func (m *mountManager) test(id string) mountRuntimeState {
	config, secret, ok := m.configAndSecret(id)
	if !ok {
		return mountRuntimeState{Status: mountStatusError, LastError: "mount_not_found"}
	}
	if config.Type == "google_drive" && googleDriveSyncMode(config) == "mount" {
		return m.testGoogleDriveMount(config)
	}
	return probeRemote(config, secret, 12*time.Second)
}

func (m *mountManager) testGoogleDriveMount(config mountConfig) mountRuntimeState {
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := exec.LookPath("rclone"); err != nil {
		return mountRuntimeState{Status: mountStatusError, LastError: "rclone_not_installed", LastCheckedAt: now}
	}
	if rcloneRemoteName(config) == "" {
		return mountRuntimeState{Status: mountStatusError, LastError: "rclone_remote_required", LastCheckedAt: now}
	}
	if err := ensureFuseDevice(); err != nil {
		return mountRuntimeState{Status: mountStatusError, LastError: redactError(err), LastCheckedAt: now}
	}
	if isMountpoint(config.MountPath) {
		return mountRuntimeState{Status: mountStatusConnected, LastCheckedAt: now}
	}
	return mountRuntimeState{Status: mountStatusDisconnected, LastError: "Live mount is configured and ready. Click Connect to start rclone mount without a separate Drive listing probe.", LastCheckedAt: now}
}

func (m *mountManager) loop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-ticker.C:
			m.reconcile()
		}
	}
}

func (m *mountManager) reconcile() {
	now := time.Now()
	m.mu.Lock()
	ids := make([]string, 0, len(m.configs))
	for id := range m.configs {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		config, _, ok := m.configAndSecret(id)
		if !ok || (!config.Options.AutoConnect && !config.Options.AutoReconnect) {
			continue
		}
		state, _ := m.state(id)
		if state.Status == mountStatusAuthFailed || state.Status == mountStatusConnecting {
			continue
		}
		if config.Type == "google_drive" && googleDriveSyncMode(config) == "copy" && state.Status == mountStatusSynced {
			continue
		}
		if state.Status == mountStatusConnected {
			if !m.isHealthy(id, config) {
				m.setFailedState(id, mountStatusStale, errors.New("mount health check failed"))
				_ = m.disconnect(id)
			}
			continue
		}
		if state.NextRetryAt != "" {
			next, err := time.Parse(time.RFC3339, state.NextRetryAt)
			if err == nil && now.Before(next) {
				continue
			}
		}
		go m.connect(id, false)
	}
}

func (m *mountManager) isHealthy(id string, config mountConfig) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	if config.Type == "google_drive" && googleDriveSyncMode(config) == "mount" {
		return m.isMountpointHealthy(ctx, id, config)
	}
	cmd := exec.CommandContext(ctx, "bash", "-lc", "mountpoint -q \"$1\" && timeout 3s ls -A \"$1\" >/dev/null", "--", config.MountPath)
	if err := cmd.Run(); err != nil {
		return false
	}
	m.markHealthy(id)
	return true
}

func (m *mountManager) isMountpointHealthy(ctx context.Context, id string, config mountConfig) bool {
	cmd := exec.CommandContext(ctx, "mountpoint", "-q", config.MountPath)
	if err := cmd.Run(); err != nil {
		return false
	}
	m.markHealthy(id)
	return true
}

func (m *mountManager) markHealthy(id string) {
	m.mu.Lock()
	state := m.states[id]
	state.LastCheckedAt = time.Now().UTC().Format(time.RFC3339)
	m.states[id] = state
	_ = m.saveStateLocked()
	m.mu.Unlock()
}

func (m *mountManager) configAndSecret(id string) (mountConfig, mountSecret, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	config, ok := m.configs[id]
	if !ok {
		return mountConfig{}, mountSecret{}, false
	}
	return config, m.secrets[id], true
}

func (m *mountManager) state(id string) (mountRuntimeState, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.states[id]
	return state, ok
}

func (m *mountManager) setState(id string, state mountRuntimeState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.configs[id]; !ok {
		return
	}
	m.states[id] = state
	_ = m.saveStateLocked()
}

func (m *mountManager) setProbeState(id string, state mountRuntimeState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.states[id]
	state.RetryCount = current.RetryCount + 1
	state.NextRetryAt = retryAfter(state.RetryCount).Format(time.RFC3339)
	m.states[id] = state
	_ = m.saveStateLocked()
}

func (m *mountManager) setFailedState(id, status string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state := m.states[id]
	state.Status = status
	state.LastError = redactError(err)
	state.LastCheckedAt = time.Now().UTC().Format(time.RFC3339)
	if status == mountStatusAuthFailed {
		state.NextRetryAt = ""
	} else {
		state.RetryCount++
		state.NextRetryAt = retryAfter(state.RetryCount).Format(time.RFC3339)
	}
	state.PID = 0
	state.ConnectedAt = ""
	m.states[id] = state
	_ = m.saveStateLocked()
}

func (m *mountManager) load() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := os.MkdirAll(m.configDir, 0o700); err != nil {
		return err
	}
	var store mountStore
	if body, err := os.ReadFile(m.configPath()); err == nil {
		if err := json.Unmarshal(body, &store); err != nil {
			return err
		}
	}
	for _, mount := range store.Mounts {
		m.configs[mount.ID] = mount
	}
	for _, provider := range store.Providers {
		m.providers[provider.ID] = provider
	}
	var secrets mountSecretStore
	if body, err := os.ReadFile(m.secretsPath()); err == nil {
		if err := json.Unmarshal(body, &secrets); err != nil {
			return err
		}
		m.secrets = secrets.Secrets
	}
	if m.secrets == nil {
		m.secrets = map[string]mountSecret{}
	}
	if body, err := os.ReadFile(m.statePath()); err == nil {
		_ = json.Unmarshal(body, &m.states)
	}
	if m.states == nil {
		m.states = map[string]mountRuntimeState{}
	}
	for id, config := range m.configs {
		state := m.states[id]
		if config.Type == "google_drive" && googleDriveSyncMode(config) == "copy" {
			config.Options.AutoConnect = false
			config.Options.AutoReconnect = false
			m.configs[id] = config
			state.NextRetryAt = ""
		}
		if state.Status == mountStatusConnected || state.Status == mountStatusConnecting {
			state.Status = mountStatusStale
			state.LastError = "OpenCode Plus restarted before this mount was verified. It will reconnect if auto-reconnect is enabled."
		}
		if state.Status == "" {
			state.Status = mountStatusDisconnected
		}
		if config.Options.AutoConnect || config.Options.AutoReconnect {
			state.NextRetryAt = time.Now().Add(5 * time.Second).UTC().Format(time.RFC3339)
		}
		m.states[id] = state
	}
	return m.saveLocked()
}

func (m *mountManager) saveLocked() error {
	if err := os.MkdirAll(m.configDir, 0o700); err != nil {
		return err
	}
	mounts := make([]mountConfig, 0, len(m.configs))
	for _, mount := range m.configs {
		mounts = append(mounts, mount)
	}
	providers := make([]storageProvider, 0, len(m.providers))
	for _, provider := range m.providers {
		providers = append(providers, provider)
	}
	body, err := json.MarshalIndent(mountStore{Mounts: mounts, Providers: providers}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(m.configPath(), append(body, '\n'), 0o600); err != nil {
		return err
	}
	body, err = json.MarshalIndent(mountSecretStore{Secrets: m.secrets}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(m.secretsPath(), append(body, '\n'), 0o600); err != nil {
		return err
	}
	return m.saveStateLocked()
}

func (m *mountManager) saveStateLocked() error {
	body, err := json.MarshalIndent(m.states, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.statePath(), append(body, '\n'), 0o600)
}

func (m *mountManager) configPath() string  { return filepath.Join(m.configDir, "config.json") }
func (m *mountManager) secretsPath() string { return filepath.Join(m.configDir, "secrets.json") }
func (m *mountManager) statePath() string   { return filepath.Join(m.configDir, "state.json") }

func buildMountCommand(config mountConfig, secret mountSecret) (*exec.Cmd, func(), error) {
	switch config.Type {
	case "ssh", "sftp":
		return buildSSHMountCommand(config, secret)
	case "smb", "google_drive":
		return buildRcloneMountCommand(config)
	default:
		return nil, nil, errors.New("unsupported_mount_type")
	}
}

func buildRcloneMountCommand(config mountConfig) (*exec.Cmd, func(), error) {
	remoteName := strings.TrimSpace(config.Remote["rclone_remote"])
	if remoteName == "" {
		remoteName = strings.TrimSpace(config.Remote["host"])
	}
	remotePath := strings.TrimSpace(config.Remote["path"])
	if remotePath == "" {
		remotePath = strings.TrimSpace(config.Remote["share"])
	}
	if remoteName == "" {
		return nil, nil, errors.New("rclone_remote_required")
	}
	remote := remoteName + ":"
	if remotePath != "" {
		remote += strings.TrimPrefix(remotePath, "/")
	}
	args := []string{"mount", remote, config.MountPath, "--vfs-cache-mode", "writes", "--cache-dir", rcloneCacheDir, "--dir-cache-time", "15m", "--poll-interval", "5m", "--drive-pacer-min-sleep", "200ms", "--drive-pacer-burst", "10", "--tpslimit", "4", "--tpslimit-burst", "4", "--retries", "1", "--low-level-retries", "1"}
	if config.Options.ReadOnly {
		args = append(args, "--read-only")
	}
	cmd := exec.Command("rclone", args...)
	cmd.Env = rcloneEnv()
	return cmd, nil, nil
}

func buildSSHMountCommand(config mountConfig, secret mountSecret) (*exec.Cmd, func(), error) {
	host := strings.TrimSpace(config.Remote["host"])
	path := strings.TrimSpace(config.Remote["path"])
	if path == "" {
		path = "/"
	}
	user := strings.TrimSpace(secret.Username)
	if user == "" {
		user = strings.TrimSpace(config.Remote["username"])
	}
	if host == "" || user == "" {
		return nil, nil, errors.New("ssh_host_and_username_required")
	}
	port := strings.TrimSpace(config.Remote["port"])
	if port == "" {
		port = "22"
	}
	args := []string{fmt.Sprintf("%s@%s:%s", user, host, path), config.MountPath, "-f", "-o", "reconnect", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "StrictHostKeyChecking=accept-new", "-p", port}
	if config.Options.ReadOnly {
		args = append(args, "-o", "ro")
	}
	cleanup := func() {}
	if strings.TrimSpace(secret.PrivateKey) != "" {
		keyFile, err := writeTempSecret("opencode-plus-ssh-key-*", secret.PrivateKey, 0o600)
		if err != nil {
			return nil, nil, err
		}
		cleanup = func() { _ = os.Remove(keyFile) }
		args = append(args, "-o", "IdentityFile="+keyFile)
	}
	cmd := exec.Command("sshfs", args...)
	if strings.TrimSpace(secret.Password) != "" {
		cmd = exec.Command("sshpass", append([]string{"-e", "sshfs"}, args...)...)
		cmd.Env = append(os.Environ(), "SSHPASS="+secret.Password)
	}
	return cmd, cleanup, nil
}

func probeRemote(config mountConfig, secret mountSecret, timeout time.Duration) mountRuntimeState {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	now := time.Now().UTC().Format(time.RFC3339)
	switch config.Type {
	case "ssh", "sftp":
		host := strings.TrimSpace(config.Remote["host"])
		port := strings.TrimSpace(config.Remote["port"])
		if port == "" {
			port = "22"
		}
		if host == "" {
			return mountRuntimeState{Status: mountStatusError, LastError: "host_required", LastCheckedAt: now}
		}
		dialer := net.Dialer{}
		conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
		if err != nil {
			status := mountStatusUnreachable
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				status = mountStatusTimeout
			}
			return mountRuntimeState{Status: status, LastError: redactError(err), LastCheckedAt: now}
		}
		_ = conn.Close()
		return mountRuntimeState{Status: mountStatusConnected, LastCheckedAt: now}
	case "smb":
		if remoteName := rcloneRemoteName(config); remoteName != "" && !strings.Contains(remoteName, ".") {
			return probeRcloneRemote(ctx, config, now)
		}
		host := strings.TrimSpace(config.Remote["host"])
		if host == "" {
			return mountRuntimeState{Status: mountStatusError, LastError: "host_or_rclone_remote_required", LastCheckedAt: now}
		}
		dialer := net.Dialer{}
		conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, "445"))
		if err != nil {
			return mountRuntimeState{Status: mountStatusUnreachable, LastError: redactError(err), LastCheckedAt: now}
		}
		_ = conn.Close()
		return mountRuntimeState{Status: mountStatusConnected, LastCheckedAt: now}
	case "google_drive":
		return probeRcloneRemote(ctx, config, now)
	default:
		return mountRuntimeState{Status: mountStatusError, LastError: "unsupported_mount_type", LastCheckedAt: now}
	}
}

func probeRcloneRemote(ctx context.Context, config mountConfig, now string) mountRuntimeState {
	if _, err := exec.LookPath("rclone"); err != nil {
		return mountRuntimeState{Status: mountStatusError, LastError: "rclone_not_installed", LastCheckedAt: now}
	}
	remoteName := rcloneRemoteName(config)
	if remoteName == "" {
		return mountRuntimeState{Status: mountStatusError, LastError: "rclone_remote_required", LastCheckedAt: now}
	}
	remote := remoteName + ":"
	if path := strings.TrimSpace(config.Remote["path"]); path != "" {
		remote += strings.TrimPrefix(path, "/")
	}
	cmd := exec.CommandContext(ctx, "rclone", "lsf", remote, "--max-depth", "1", "--retries", "1", "--low-level-retries", "1")
	cmd.Env = rcloneEnv()
	output, err := cmd.CombinedOutput()
	if err != nil {
		status := classifyMountError(err)
		if ctx.Err() != nil {
			status = mountStatusTimeout
		}
		detail := strings.TrimSpace(string(output))
		if detail == "" {
			detail = err.Error()
		}
		return mountRuntimeState{Status: status, LastError: redactError(errors.New(detail)), LastCheckedAt: now}
	}
	return mountRuntimeState{Status: mountStatusConnected, LastCheckedAt: now}
}

func googleDriveSyncMode(config mountConfig) string {
	mode := strings.TrimSpace(config.Options.SyncMode)
	if mode == "copy" || mode == "manual" || mode == "manual_sync" {
		return "copy"
	}
	return "mount"
}

func googleDriveAccountHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			remotes, err := listGoogleDriveRemotes()
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "rclone_remote_list_failed", "detail": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "accounts": remotes})
		case http.MethodPost:
			defer r.Body.Close()
			var request struct {
				Name         string `json:"name"`
				Token        string `json:"token"`
				ClientID     string `json:"clientId"`
				ClientSecret string `json:"clientSecret"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&request); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
				return
			}
			name := safeMountName(request.Name)
			if name == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "account_name_required"})
				return
			}
			token := strings.TrimSpace(request.Token)
			if token == "" || !strings.HasPrefix(token, "{") {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "authorization_token_required", "detail": "Paste the JSON token printed by rclone authorize \"drive\"."})
				return
			}
			if err := saveGoogleDriveRemote(name, token, request.ClientID, request.ClientSecret); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "google_drive_connect_failed", "detail": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": name})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

func rcloneEnv() []string {
	return append(os.Environ(), "RCLONE_CONFIG="+rcloneConfigFile)
}

func ensureFuseDevice() error {
	if info, err := os.Stat("/dev/fuse"); err == nil {
		if info.Mode()&os.ModeCharDevice == 0 {
			return errors.New("/dev/fuse_exists_but_is_not_a_character_device")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := syscall.Mknod("/dev/fuse", syscall.S_IFCHR|0o666, int(10<<8|229)); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("fuse_device_missing: add /dev/fuse to the container or allow mknod: %w", err)
	}
	_ = os.Chmod("/dev/fuse", 0o666)
	return nil
}

func isMountpoint(path string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "mountpoint", "-q", path).Run() == nil
}

func listGoogleDriveRemotes() ([]string, error) {
	if _, err := exec.LookPath("rclone"); err != nil {
		return nil, errors.New("rclone_not_installed")
	}
	cmd := exec.Command("rclone", "listremotes", "--long")
	cmd.Env = rcloneEnv()
	output, err := cmd.CombinedOutput()
	if err != nil && len(output) == 0 {
		return nil, errors.New(redactError(err))
	}
	accounts := []string{}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == "drive" {
			accounts = append(accounts, strings.TrimSuffix(fields[0], ":"))
		}
	}
	return accounts, nil
}

func saveGoogleDriveRemote(name, token, clientID, clientSecret string) error {
	if _, err := exec.LookPath("rclone"); err != nil {
		return errors.New("rclone_not_installed")
	}
	if err := os.MkdirAll(filepath.Dir(rcloneConfigFile), 0o700); err != nil {
		return err
	}
	args := []string{"config", "create", name, "drive", "config_is_local=false"}
	if strings.TrimSpace(clientID) != "" {
		args = append(args, "client_id", strings.TrimSpace(clientID))
	}
	if strings.TrimSpace(clientSecret) != "" {
		args = append(args, "client_secret", strings.TrimSpace(clientSecret))
	}
	args = append(args, "--non-interactive")
	create := exec.Command("rclone", args...)
	create.Env = rcloneEnv()
	if output, err := create.CombinedOutput(); err != nil {
		return fmt.Errorf("start auth config: %s", strings.TrimSpace(string(output)))
	}
	connect := exec.Command("rclone", "config", "create", name, "drive", "--continue", "--state", "*oauth-authorize,teamdrive,,", "--result", token, "--non-interactive")
	connect.Env = rcloneEnv()
	if output, err := connect.CombinedOutput(); err != nil {
		return fmt.Errorf("store auth token: %s", strings.TrimSpace(string(output)))
	}
	finish := exec.Command("rclone", "config", "create", name, "drive", "--continue", "--state", "teamdrive_ok", "--result", "false", "--non-interactive")
	finish.Env = rcloneEnv()
	if output, err := finish.CombinedOutput(); err != nil {
		return fmt.Errorf("finish auth config: %s", strings.TrimSpace(string(output)))
	}
	_ = os.Chmod(rcloneConfigFile, 0o600)
	return nil
}

func rcloneRemoteName(config mountConfig) string {
	remoteName := strings.TrimSpace(config.Remote["rclone_remote"])
	if remoteName == "" {
		remoteName = strings.TrimSpace(config.Remote["host"])
	}
	return strings.TrimSuffix(remoteName, ":")
}

func normalizeMountType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "ssh", "sshfs", "sftp":
		return "ssh"
	case "smb", "cifs":
		return "smb"
	case "google_drive", "googledrive", "google-drive", "gdrive":
		return "google_drive"
	default:
		return ""
	}
}

func safeMountName(value string) string {
	value = strings.Trim(strings.ToLower(strings.TrimSpace(value)), ".-")
	value = safeMountNamePattern.ReplaceAllString(value, "-")
	return strings.Trim(value, ".-")
}

func validateMountPath(workspaceRoot, mountPath string) error {
	workspaceRoot = filepath.Clean(workspaceRoot)
	mountPath = filepath.Clean(mountPath)
	if workspaceRoot == "/" || workspaceRoot == "/root" || workspaceRoot == "/config" || workspaceRoot == "/data" {
		return errors.New("workspace_root_is_too_broad")
	}
	if !strings.HasPrefix(mountPath, workspaceRoot+string(os.PathSeparator)) {
		return errors.New("mount_path_must_be_inside_workspace")
	}
	if strings.Contains(mountPath, string(os.PathSeparator)+".git"+string(os.PathSeparator)) || strings.HasSuffix(mountPath, string(os.PathSeparator)+".git") {
		return errors.New("mount_path_cannot_be_inside_git_metadata")
	}
	if info, err := os.Stat(mountPath); err == nil && !info.IsDir() {
		return errors.New("mount_path_exists_and_is_not_directory")
	}
	return nil
}

func trimStringMap(input map[string]string) map[string]string {
	result := map[string]string{}
	for key, value := range input {
		result[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return result
}

func redactRemote(remote map[string]string) map[string]string {
	result := map[string]string{}
	for key, value := range remote {
		lower := strings.ToLower(key)
		if strings.Contains(lower, "pass") || strings.Contains(lower, "token") || strings.Contains(lower, "secret") || strings.Contains(lower, "key") {
			result[key] = "redacted"
		} else {
			result[key] = value
		}
	}
	return result
}

func redactError(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	if strings.Contains(text, "drive.googleapis.com") && strings.Contains(text, "RATE_LIMIT_EXCEEDED") {
		return "Google Drive API quota/rate limit exceeded while checking this folder. Wait a few minutes and try again, or reconnect the provider with your own Google OAuth Client ID/Secret."
	}
	if strings.Contains(text, "couldn't find root directory ID") {
		return "Google Drive could not find or access that remote folder. Check the Workspace Link remote folder spelling and that the connected account can open it."
	}
	if strings.Contains(text, "failed to mount FUSE") || strings.Contains(text, "fusermount") {
		return "This provider requires a filesystem mount, but the container does not have FUSE permission. Google Drive links should use Sync instead."
	}
	if len(text) > 500 {
		text = text[:500]
	}
	return text
}

func classifyMountError(err error) string {
	if err == nil {
		return mountStatusError
	}
	text := strings.ToLower(err.Error())
	if strings.Contains(text, "permission denied") || strings.Contains(text, "authentication") || strings.Contains(text, "auth") {
		return mountStatusAuthFailed
	}
	if strings.Contains(text, "timeout") || strings.Contains(text, "deadline") {
		return mountStatusTimeout
	}
	if strings.Contains(text, "no route") || strings.Contains(text, "network") || strings.Contains(text, "connection refused") || strings.Contains(text, "host") {
		return mountStatusUnreachable
	}
	return mountStatusError
}

func retryAfter(retryCount int) time.Time {
	if retryCount < 1 {
		retryCount = 1
	}
	seconds := 30 * (1 << minInt(retryCount-1, 6))
	if seconds > 1800 {
		seconds = 1800
	}
	return time.Now().UTC().Add(time.Duration(seconds) * time.Second)
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func randomID(prefix string) string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return prefix + "_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return prefix + "_" + hex.EncodeToString(raw[:])
}

func writeTempSecret(pattern, value string, mode os.FileMode) (string, error) {
	file, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", err
	}
	path := file.Name()
	if _, err := file.WriteString(value); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	if err := os.Chmod(path, mode); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return path, nil
}
