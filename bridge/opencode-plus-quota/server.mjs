import http from 'node:http';
import { execFile } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const HOST = process.env.OPENCODE_SIDECAR_HOST || '0.0.0.0';
const PORT = Number(process.env.OPENCODE_SIDECAR_PORT || 18765);
const CACHE_MS = Number(process.env.OPENCODE_SIDECAR_CACHE_MS || 15000);
const PROVIDER_FETCH_TIMEOUT_MS = Number(process.env.OPENCODE_SIDECAR_PROVIDER_TIMEOUT_MS || 12000);
const GEMINI_OAUTH_CLIENT_ID = process.env.GEMINI_OAUTH_CLIENT_ID || '';
const GEMINI_OAUTH_CLIENT_SECRET = process.env.GEMINI_OAUTH_CLIENT_SECRET || '';
const GEMINI_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
const GEMINI_OAUTH_CREDS_PATH = process.env.GEMINI_OAUTH_CREDS_PATH || join(homedir(), '.gemini', 'oauth_creds.json');
const GEMINI_CLI_BUNDLE_DIR = process.env.GEMINI_CLI_BUNDLE_DIR || '/usr/lib/node_modules/@google/gemini-cli/bundle';
const OPENAI_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const OPENAI_ADMIN_COSTS_URL = 'https://api.openai.com/v1/organization/costs';
const OPENAI_AUTH_SOURCE_KEYS = ['openai', 'codex', 'chatgpt', 'opencode'];
const ANTHROPIC_AUTH_SOURCE_KEYS = ['anthropic', 'claude'];
const ANTHROPIC_COST_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const OPENROUTER_AUTH_SOURCE_KEYS = ['openrouter', 'open-router'];
const DEEPSEEK_AUTH_SOURCE_KEYS = ['deepseek', 'deep-seek'];
const SILICONFLOW_AUTH_SOURCE_KEYS = ['siliconflow', 'silicon-flow', 'siliconcloud', 'silicon-cloud'];
const MOONSHOT_AUTH_SOURCE_KEYS = ['moonshot', 'moonshotai', 'moonshot-ai', 'kimi'];
const FIREWORKS_AUTH_SOURCE_KEYS = ['fireworks', 'fireworksai', 'fireworks-ai', 'fire-works'];
const OPENCODE_AUTH_PATH = process.env.OPENCODE_AUTH_PATH || join(homedir(), '.local', 'share', 'opencode', 'auth.json');
const OPENCODE_PLUS_SECRETS_DIR = process.env.OPENCODE_PLUS_SECRETS_DIR || '/config/persist/opencode-plus-secrets';
const OPENCODE_PLUS_SECRETS_KEY_PATH = process.env.OPENCODE_PLUS_SECRETS_KEY_PATH || join(OPENCODE_PLUS_SECRETS_DIR, 'master.key');
const OPENCODE_PLUS_SECRETS_VAULT_PATH = process.env.OPENCODE_PLUS_SECRETS_VAULT_PATH || join(OPENCODE_PLUS_SECRETS_DIR, 'providers.enc.json');
const OPENCODE_PLUS_CONFIG_FILE = process.env.OPENCODE_PLUS_CONFIG_FILE || '/config/persist/opencode-plus-config.json';
const GEMINI_OPENCODE_AUTH_SOURCE_KEYS = ['gemini', 'google', 'google-gemini', 'gemini-cli', 'vertex', 'vertexai', 'google-vertex'];
const XAI_MANAGEMENT_URL = 'https://management-api.x.ai';

let cache = null;
let geminiCliOAuthClientPromise = null;
const execFileAsync = promisify(execFile);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(payload);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = PROVIDER_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: options.signal || controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function formatReset(resetTimeIso) {
  if (!resetTimeIso) return undefined;
  const ms = new Date(resetTimeIso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'soon';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function windowEntry(label, quotaWindow) {
  if (!quotaWindow) return null;
  return {
    label,
    percentRemaining: Math.max(0, Math.min(100, Math.round(quotaWindow.percentRemaining ?? 0))),
    resetTimeIso: quotaWindow.resetTimeIso,
    resetsIn: formatReset(quotaWindow.resetTimeIso),
  };
}

async function getQuotaPayload() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return { ...cache.payload, cached: true };

  const payload = {
    updatedAt: new Date().toISOString(),
    providers: [],
  };

  payload.providers.push(await getOpenAiProvider());
  payload.providers.push(await getOpenRouterProvider());
  payload.providers.push(await getGeminiProvider());
  payload.providers.push(await getClaudeProvider());
  payload.providers.push(await getDeepSeekProvider());
  payload.providers.push(await getSiliconFlowProvider());
  payload.providers.push(await getMoonshotProvider());
  payload.providers.push(await getFireworksProvider());
  payload.providers.push(await getXaiProvider());

  cache = { at: now, payload };
  return payload;
}

async function readProviderSecrets() {
  try {
    const key = Buffer.from((await readFile(OPENCODE_PLUS_SECRETS_KEY_PATH, 'utf8')).trim(), 'base64');
    if (key.length !== 32) return null;

    const vault = JSON.parse(await readFile(OPENCODE_PLUS_SECRETS_VAULT_PATH, 'utf8'));
    if (vault.version !== 1 || vault.algorithm !== 'AES-256-GCM') return null;

    const nonce = Buffer.from(vault.nonce || '', 'base64');
    const sealed = Buffer.from(vault.ciphertext || '', 'base64');
    if (!nonce.length || sealed.length <= 16) return null;

    const tag = sealed.subarray(sealed.length - 16);
    const ciphertext = sealed.subarray(0, sealed.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    return null;
  }
}

async function readPlusConfig() {
  try {
    const config = JSON.parse(await readFile(OPENCODE_PLUS_CONFIG_FILE, 'utf8'));
    return {
      geminiAuthSource: normalizeGeminiAuthSource(config.gemini_auth_source || config.geminiAuthSource),
      openAiAuthSource: normalizeOpenAiAuthSource(config.openai_auth_source || config.openAiAuthSource),
      anthropicAuthSource: normalizeAnthropicAuthSource(config.anthropic_auth_source || config.anthropicAuthSource),
    };
  } catch {
    return { geminiAuthSource: 'auto', openAiAuthSource: 'auto', anthropicAuthSource: 'auto' };
  }
}

function normalizeGeminiAuthSource(source) {
  const normalized = String(source || '').trim().toLowerCase().replace(/-/g, '_');
  if (!normalized || normalized === 'auto') return 'auto';
  if (normalized === 'cli' || normalized === 'gemini_cli') return 'gemini_cli';
  if (normalized === 'opencode' || normalized === 'opencode_provider') return 'opencode_provider';
  return 'auto';
}

function normalizeOpenAiAuthSource(source) {
  const normalized = String(source || '').trim().toLowerCase().replace(/-/g, '_');
  if (!normalized || normalized === 'auto') return 'auto';
  if (normalized === 'chatgpt' || normalized === 'chatgpt_subscription' || normalized === 'subscription') return 'chatgpt_subscription';
  if (normalized === 'admin' || normalized === 'admin_api') return 'admin_api';
  if (normalized === 'opencode' || normalized === 'opencode_provider' || normalized === 'api') return 'opencode_provider';
  return 'auto';
}

function normalizeAnthropicAuthSource(source) {
  const normalized = String(source || '').trim().toLowerCase().replace(/-/g, '_');
  if (!normalized || normalized === 'auto') return 'auto';
  if (normalized === 'claude' || normalized === 'claude_subscription' || normalized === 'subscription') return 'claude_subscription';
  if (normalized === 'admin' || normalized === 'admin_api') return 'admin_api';
  if (normalized === 'opencode' || normalized === 'opencode_provider' || normalized === 'api') return 'opencode_provider';
  return 'auto';
}

async function getOpenAiProvider() {
  const source = (await readPlusConfig()).openAiAuthSource;
  if (source === 'chatgpt_subscription') return getOpenAiChatGptProvider();
  if (source === 'admin_api') return getOpenAiAdminProvider();
  if (source === 'opencode_provider') return getOpenAiOpenCodeProvider();

  const chatGpt = await getOpenAiChatGptProvider();
  if (chatGpt.status === 'ok') return chatGpt;
  const admin = await getOpenAiAdminProvider();
  if (admin.status === 'ok') return admin;
  const provider = await getOpenAiOpenCodeProvider();
  if (provider.status === 'ok') return provider;
  return chatGpt.status === 'not_configured' ? admin.status === 'not_configured' ? provider : admin : chatGpt;
}

async function getOpenAiChatGptProvider() {
  try {
    const auth = await readOpenCodeAuth();
    const resolvedAuth = resolveOpenAiAuth(auth);
    if (!resolvedAuth) return { id: 'openai', label: 'OpenAI', status: 'not_configured', windows: [] };
    if (resolvedAuth.expiresAt && resolvedAuth.expiresAt < Date.now()) {
      return { id: 'openai', label: 'OpenAI', status: 'error', error: 'Token expired', windows: [] };
    }

    const headers = {
      Authorization: `Bearer ${resolvedAuth.accessToken}`,
      'User-Agent': 'OpenCode-Plus-Quota-Bridge/1.0',
    };
    if (resolvedAuth.accountId) headers['ChatGPT-Account-Id'] = resolvedAuth.accountId;

    const response = await fetchWithTimeout(OPENAI_USAGE_URL, { headers });
    const bodyText = await response.text();
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      return {
        id: 'openai',
        label: 'OpenAI',
        status: response.status === 401 || response.status === 403 ? 'not_configured' : 'error',
        error: `OpenAI usage failed: ${response.status}${bodyText ? ` ${bodyText.slice(0, 120)}` : ''}`,
        windows: [],
      };
    }

    const primary = body.rate_limit?.primary_window;
    if (!primary) return { id: 'openai', label: 'OpenAI', status: 'error', error: 'No quota data', windows: [] };
    const secondary = body.rate_limit?.secondary_window;
    const codeReview = body.code_review_rate_limit?.primary_window;

    return {
      id: 'openai',
      label: deriveOpenAiPlanLabel(body.plan_type),
      status: 'ok',
      email: resolvedAuth.email,
      windows: [
        openAiWindowEntry('H', primary),
        openAiWindowEntry('W', secondary),
        openAiWindowEntry('R', codeReview),
      ].filter(Boolean),
    };
  } catch (error) {
    return { id: 'openai', label: 'OpenAI', status: 'error', error: error instanceof Error ? error.message : String(error), windows: [] };
  }
}

async function getOpenAiAdminProvider() {
  const key = await getOpenAiAdminKey();
  if (!key) return { id: 'openai', label: 'OpenAI Admin', status: 'not_configured', windows: [], values: [{ label: 'Auth', value: 'not set' }] };

  try {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 7 * 24 * 60 * 60;
    const response = await fetchWithTimeout(`${OPENAI_ADMIN_COSTS_URL}?start_time=${start}&end_time=${end}&bucket_width=1d&limit=31`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        id: 'openai',
        label: 'OpenAI Admin',
        status: response.status === 401 || response.status === 403 ? 'not_configured' : 'error',
        error: body.error?.message || `OpenAI costs failed: ${response.status}`,
        windows: [],
      };
    }

    const buckets = Array.isArray(body.data) ? body.data : [];
    const total = buckets.reduce((sum, bucket) => sum + openAiCostBucketTotal(bucket), 0);
    return {
      id: 'openai',
      label: 'OpenAI Admin',
      status: 'ok',
      windows: [],
      values: [
        { label: '7d', value: formatUsd(total) || String(total) },
        { label: 'API', value: 'admin' },
      ],
    };
  } catch (error) {
    return { id: 'openai', label: 'OpenAI Admin', status: 'error', error: error instanceof Error ? error.message : String(error), windows: [] };
  }
}

function openAiCostBucketTotal(bucket) {
  const results = Array.isArray(bucket?.results) ? bucket.results : [];
  return results.reduce((sum, item) => sum + Number(item.amount?.value ?? item.amount ?? 0), 0);
}

async function getOpenAiAdminKey() {
  if (process.env.OPENAI_ADMIN_KEY) return process.env.OPENAI_ADMIN_KEY;
  const vaultedKey = (await readProviderSecrets())?.openai?.adminKey;
  if (typeof vaultedKey === 'string' && vaultedKey.trim()) return vaultedKey.trim();
  return undefined;
}

async function getOpenAiOpenCodeProvider() {
  const key = resolveApiKeyAuth(await readOpenCodeAuth(), OPENAI_AUTH_SOURCE_KEYS);
  if (!key) return { id: 'openai', label: 'OpenAI API', status: 'not_configured', windows: [], values: [{ label: 'Auth', value: 'not set' }] };
  return { id: 'openai', label: 'OpenAI API', status: 'ok', windows: [], values: [{ label: 'Auth', value: 'API key' }] };
}

async function readOpenCodeAuth() {
  try {
    return JSON.parse(await readFile(OPENCODE_AUTH_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function resolveOpenAiAuth(auth) {
  for (const sourceKey of OPENAI_AUTH_SOURCE_KEYS) {
    const entry = auth?.[sourceKey];
    if (!entry || entry.type !== 'oauth') continue;
    const accessToken = typeof entry.access === 'string' ? entry.access.trim() : '';
    if (!accessToken) continue;
    const jwt = parseJwt(accessToken);
    return {
      sourceKey,
      accessToken,
      expiresAt: typeof entry.expires === 'number' ? entry.expires : undefined,
      email: jwt?.['https://api.openai.com/profile']?.email,
      accountId: jwt?.['https://api.openai.com/auth']?.chatgpt_account_id || entry.accountId,
    };
  }
  return null;
}

function parseJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function openAiResetIso(quotaWindow) {
  const resetAt = Number(quotaWindow?.reset_at);
  if (Number.isFinite(resetAt) && resetAt > 0) return new Date(Math.round(resetAt * 1000)).toISOString();
  const resetAfterSeconds = Number(quotaWindow?.reset_after_seconds);
  if (Number.isFinite(resetAfterSeconds) && resetAfterSeconds > 0) {
    return new Date(Date.now() + Math.round(resetAfterSeconds * 1000)).toISOString();
  }
  return undefined;
}

function openAiWindowEntry(label, quotaWindow) {
  if (!quotaWindow) return null;
  return windowEntry(label, {
    percentRemaining: clampPercent(100 - Number(quotaWindow.used_percent)),
    resetTimeIso: openAiResetIso(quotaWindow),
  });
}

function deriveOpenAiPlanLabel(planType) {
  const raw = String(planType || '').toLowerCase();
  if (raw.includes('pro')) return 'OpenAI (Pro)';
  if (raw.includes('plus')) return 'OpenAI (Plus)';
  return planType ? `OpenAI (${planType})` : 'OpenAI';
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return undefined;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}

async function getOpenRouterProvider() {
  const key = await getOpenRouterKey();
  if (!key) return { id: 'openrouter', label: 'OpenRouter', status: 'not_configured', windows: [] };

  try {
    const response = await fetchWithTimeout('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        id: 'openrouter',
        label: 'OpenRouter',
        status: response.status === 401 || response.status === 403 ? 'not_configured' : 'error',
        error: body.error?.message || `OpenRouter credits failed: ${response.status}`,
        windows: [],
      };
    }

    const total = Number(body.data?.total_credits);
    const used = Number(body.data?.total_usage);
    const remaining = total - used;
    return {
      id: 'openrouter',
      label: 'OpenRouter',
      status: 'ok',
      windows: [],
      values: [
        { label: 'Left', value: formatUsd(remaining) || String(remaining) },
        { label: 'Used', value: formatUsd(used) || String(used) },
      ],
    };
  } catch (error) {
    return { id: 'openrouter', label: 'OpenRouter', status: 'error', error: error instanceof Error ? error.message : String(error), windows: [] };
  }
}

async function getOpenRouterKey() {
  if (process.env.OPENROUTER_MANAGEMENT_KEY) return process.env.OPENROUTER_MANAGEMENT_KEY;
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const secrets = await readProviderSecrets();
  const vaultedKey = secrets?.openrouter?.managementKey;
  if (typeof vaultedKey === 'string' && vaultedKey.trim()) return vaultedKey.trim();
  const providerKey = resolveOpenRouterAuth(await readOpenCodeAuth());
  if (providerKey) return providerKey;
  try {
    const { stdout } = await execFileAsync('op', [
      'item', 'get', 'OpenRouter.ai Management Key',
      '--vault', 'Private',
      '--fields', 'notesPlain',
      '--reveal',
    ], { timeout: 5000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveOpenRouterAuth(auth) {
  for (const sourceKey of OPENROUTER_AUTH_SOURCE_KEYS) {
    const entry = auth?.[sourceKey];
    if (!entry || entry.type !== 'api') continue;
    const key = typeof entry.key === 'string' ? entry.key.trim() : typeof entry.apiKey === 'string' ? entry.apiKey.trim() : typeof entry.api_key === 'string' ? entry.api_key.trim() : '';
    if (key) return key;
  }
  return undefined;
}

async function getDeepSeekProvider() {
  const key = resolveApiKeyAuth(await readOpenCodeAuth(), DEEPSEEK_AUTH_SOURCE_KEYS);
  if (!key) return { id: 'deepseek', label: 'DeepSeek', status: 'not_configured', windows: [], values: [{ label: 'Auth', value: 'not set' }] };

  try {
    const response = await fetchWithTimeout('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        id: 'deepseek',
        label: 'DeepSeek',
        status: response.status === 401 || response.status === 403 ? 'not_configured' : 'error',
        error: body.error?.message || `DeepSeek balance failed: ${response.status}`,
        windows: [],
      };
    }

    const balances = Array.isArray(body.balance_infos) ? body.balance_infos : [];
    const totalUsd = balances
      .filter((item) => String(item.currency || '').toUpperCase() === 'USD')
      .reduce((sum, item) => sum + Number(item.total_balance || 0), 0);
    const anyAvailable = body.is_available ?? balances.some((item) => Number(item.total_balance || 0) > 0);
    return {
      id: 'deepseek',
      label: 'DeepSeek',
      status: 'ok',
      windows: [],
      values: [
        { label: 'Bal', value: formatUsd(totalUsd) || String(totalUsd) },
        { label: 'API', value: anyAvailable ? 'ready' : 'empty' },
      ],
    };
  } catch (error) {
    return { id: 'deepseek', label: 'DeepSeek', status: 'error', error: error instanceof Error ? error.message : String(error), windows: [] };
  }
}

async function getSiliconFlowProvider() {
  const key = resolveApiKeyAuth(await readOpenCodeAuth(), SILICONFLOW_AUTH_SOURCE_KEYS);
  if (!key) return { id: 'siliconflow', label: 'SiliconFlow', status: 'not_configured', windows: [], values: [{ label: 'Auth', value: 'not set' }] };

  try {
    const response = await fetchWithTimeout('https://api.siliconflow.com/v1/user/info', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.status === false) {
      return {
        id: 'siliconflow',
        label: 'SiliconFlow',
        status: response.status === 401 || response.status === 403 ? 'not_configured' : 'error',
        error: body.message || `SiliconFlow user info failed: ${response.status}`,
        windows: [],
      };
    }

    return {
      id: 'siliconflow',
      label: 'SiliconFlow',
      status: 'ok',
      windows: [],
      values: [
        { label: 'Bal', value: String(body.data?.totalBalance ?? body.data?.balance ?? 'unknown') },
        { label: 'API', value: String(body.data?.status || 'ready') },
      ],
    };
  } catch (error) {
    return { id: 'siliconflow', label: 'SiliconFlow', status: 'error', error: error instanceof Error ? error.message : String(error), windows: [] };
  }
}

async function getMoonshotProvider() {
  const key = resolveApiKeyAuth(await readOpenCodeAuth(), MOONSHOT_AUTH_SOURCE_KEYS);
  if (!key) return { id: 'moonshot', label: 'Kimi/Moonshot', status: 'not_configured', windows: [], values: [{ label: 'Auth', value: 'not set' }] };

  try {
    const response = await fetchWithTimeout('https://api.moonshot.ai/v1/users/me/balance', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.status === false) {
      return {
        id: 'moonshot',
        label: 'Kimi/Moonshot',
        status: response.status === 401 || response.status === 403 ? 'not_configured' : 'error',
        error: body.message || `Moonshot balance failed: ${response.status}`,
        windows: [],
      };
    }

    return {
      id: 'moonshot',
      label: 'Kimi/Moonshot',
      status: 'ok',
      windows: [],
      values: [
        { label: 'Avail', value: String(body.data?.available_balance ?? 'unknown') },
        { label: 'Cash', value: String(body.data?.cash_balance ?? 'unknown') },
      ],
    };
  } catch (error) {
    return { id: 'moonshot', label: 'Kimi/Moonshot', status: 'error', error: error instanceof Error ? error.message : String(error), windows: [] };
  }
}

async function getXaiProvider() {
  const secrets = await readProviderSecrets();
  const managementKey = process.env.XAI_MANAGEMENT_KEY || secrets?.xai?.managementKey;
  if (!managementKey) return { id: 'xai', label: 'xAI/Grok', status: 'not_configured', windows: [], values: [{ label: 'Auth', value: 'not set' }] };

  try {
    const validation = await xaiManagementJson('/auth/management-keys/validation', managementKey);
    const teamId = process.env.XAI_TEAM_ID || secrets?.xai?.teamId || validation.teamId || validation.scopeId;
    if (!teamId) {
      return { id: 'xai', label: 'xAI/Grok', status: 'error', error: 'xAI management key validation did not return a team ID', windows: [] };
    }

    const balance = await xaiManagementJson(`/v1/billing/teams/${encodeURIComponent(teamId)}/prepaid/balance`, managementKey);
    const totalCents = Number(balance.total?.amount ?? balance.total?.value ?? balance.total ?? 0);
    return {
      id: 'xai',
      label: 'xAI/Grok',
      status: 'ok',
      windows: [],
      values: [
        { label: 'Pre', value: formatUsd(totalCents / 100) || String(totalCents) },
        { label: 'Team', value: String(teamId).slice(0, 6) },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: 'xai', label: 'xAI/Grok', status: /401|403|unauthorized|forbidden/i.test(message) ? 'not_configured' : 'error', error: message, windows: [] };
  }
}

async function getFireworksProvider() {
  const key = resolveApiKeyAuth(await readOpenCodeAuth(), FIREWORKS_AUTH_SOURCE_KEYS);
  if (!key) return { id: 'fireworks', label: 'Fireworks AI', status: 'not_configured', windows: [], values: [{ label: 'Auth', value: 'not set' }] };

  try {
    const accounts = await fireworksApiJson('/v1/accounts?pageSize=1', key);
    const account = Array.isArray(accounts.accounts) ? accounts.accounts[0] : null;
    const accountId = accountIdFromFireworksName(account?.name);
    if (!accountId) return { id: 'fireworks', label: 'Fireworks AI', status: 'error', error: 'No Fireworks account returned for API key', windows: [] };

    const quotas = await fireworksApiJson(`/v1/accounts/${encodeURIComponent(accountId)}/quotas?pageSize=200`, key);
    const quotaItems = Array.isArray(quotas.quotas) ? quotas.quotas : [];
    const spendQuota = quotaItems.find((quota) => /monthly.*spend|spend.*usd|monthly-spend/i.test(String(quota.name || '')));
    const usage = Number(spendQuota?.usage);
    const limit = Number(spendQuota?.value ?? spendQuota?.maxValue);
    const values = [];
    if (Number.isFinite(usage)) values.push({ label: 'Spend', value: formatUsd(usage) || String(usage) });
    if (Number.isFinite(limit)) values.push({ label: 'Limit', value: formatUsd(limit) || String(limit) });
    if (values.length === 0) {
      values.push({ label: 'Qta', value: String(quotas.totalSize ?? quotaItems.length) });
      values.push({ label: 'Acct', value: String(account.state || account.suspendState || 'ready').replace(/^STATE_/, '').toLowerCase() });
    }

    return {
      id: 'fireworks',
      label: 'Fireworks AI',
      status: 'ok',
      windows: [],
      values,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: 'fireworks', label: 'Fireworks AI', status: /401|403|unauthenticated|permission_denied|forbidden/i.test(message) ? 'not_configured' : 'error', error: message, windows: [] };
  }
}

function accountIdFromFireworksName(name) {
  const match = String(name || '').match(/^accounts\/([^/]+)$/);
  return match?.[1] || '';
}

async function fireworksApiJson(path, key) {
  const response = await fetchWithTimeout(`https://api.fireworks.ai${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.message || `Fireworks API failed: ${response.status}`);
  return body;
}

async function xaiManagementJson(path, managementKey) {
  const response = await fetchWithTimeout(`${XAI_MANAGEMENT_URL}${path}`, {
    headers: { Authorization: `Bearer ${managementKey}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.message || `xAI management failed: ${response.status}`);
  return body;
}

function resolveApiKeyAuth(auth, sourceKeys) {
  for (const sourceKey of sourceKeys) {
    const entry = auth?.[sourceKey];
    if (!entry || typeof entry !== 'object') continue;
    const key = getSecretValue(entry);
    if (key) return key;
  }
  return undefined;
}

async function getGeminiCodeAssistToken(source) {
  const candidates = [];
  if (source === 'auto' || source === 'gemini_cli') {
    candidates.push({ name: 'OpenCode Plus vault', load: async () => (await readProviderSecrets())?.gemini?.oauthCreds });
    candidates.push({ name: 'Gemini CLI auth', load: async () => JSON.parse(await readFile(GEMINI_OAUTH_CREDS_PATH, 'utf8')) });
  }

  const errors = [];
  for (const candidate of candidates) {
    try {
      const creds = await candidate.load();
      if (!creds) {
        errors.push(`${candidate.name}: not found`);
        continue;
      }
      return refreshGeminiAccessToken(creds, candidate.name);
    } catch (error) {
      errors.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No usable Gemini auth for source ${source}: ${errors.join('; ')}`);
}

async function refreshGeminiAccessToken(creds, sourceName) {
  if (creds.access_token && creds.expiry_date && creds.expiry_date > Date.now() + 60000) {
    return creds.access_token;
  }
  if (!creds.refresh_token) throw new Error(`${sourceName} has no refresh token`);
  const bundledClient = await getGeminiCliOAuthClient();
  const clientId = creds.client_id || creds.clientId || GEMINI_OAUTH_CLIENT_ID || bundledClient?.clientId;
  const clientSecret = creds.client_secret || creds.clientSecret || GEMINI_OAUTH_CLIENT_SECRET || bundledClient?.clientSecret;
  if (!clientId || !clientSecret) throw new Error(`${sourceName} has no OAuth client credentials`);

  const response = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error(`Gemini token refresh failed: ${body.error_description || body.error || response.status}`);
  }
  return body.access_token;
}

async function getGeminiCliOAuthClient() {
  if (!geminiCliOAuthClientPromise) geminiCliOAuthClientPromise = readGeminiCliOAuthClient().catch(() => null);
  return geminiCliOAuthClientPromise;
}

async function readGeminiCliOAuthClient() {
  const entries = await readdir(GEMINI_CLI_BUNDLE_DIR, { withFileTypes: true });
  const chunkFiles = entries
    .filter((entry) => entry.isFile() && /^chunk-[A-Z0-9]+\.js$/.test(entry.name))
    .map((entry) => entry.name);

  for (const fileName of chunkFiles) {
    const source = await readFile(join(GEMINI_CLI_BUNDLE_DIR, fileName), 'utf8');
    const clientId = source.match(/var\s+OAUTH_CLIENT_ID\s*=\s*(['"])([^'"]+)\1/)?.[2];
    const clientSecret = source.match(/var\s+OAUTH_CLIENT_SECRET\s*=\s*(['"])([^'"]+)\1/)?.[2];
    if (clientId && clientSecret) return { clientId, clientSecret };
  }

  return null;
}

function resolveGeminiOpenCodeOAuth(auth) {
  for (const sourceKey of GEMINI_OPENCODE_AUTH_SOURCE_KEYS) {
    const entry = auth?.[sourceKey];
    if (!entry || entry.type !== 'oauth') continue;
    const refreshToken = typeof entry.refresh === 'string' ? entry.refresh.trim() : typeof entry.refresh_token === 'string' ? entry.refresh_token.trim() : '';
    const accessToken = typeof entry.access === 'string' ? entry.access.trim() : typeof entry.access_token === 'string' ? entry.access_token.trim() : '';
    if (!refreshToken && !accessToken) continue;
    return {
      refresh_token: refreshToken,
      access_token: accessToken,
      expiry_date: typeof entry.expires === 'number' ? entry.expires : typeof entry.expiry_date === 'number' ? entry.expiry_date : undefined,
    };
  }
  return null;
}

function getSecretValue(entry) {
  for (const key of ['key', 'apiKey', 'api_key', 'token', 'access', 'access_token']) {
    if (typeof entry?.[key] === 'string' && entry[key].trim()) return entry[key].trim();
  }
  return '';
}

function describeGeminiOpenCodeProvider(auth) {
  for (const sourceKey of GEMINI_OPENCODE_AUTH_SOURCE_KEYS) {
    const entry = auth?.[sourceKey];
    if (!entry || typeof entry !== 'object') continue;
    const type = String(entry.type || '').toLowerCase();
    const providerLabel = /vertex/i.test(sourceKey) || /vertex/i.test(String(entry.provider || entry.id || '')) ? 'Vertex' : 'API';
    if (type === 'api' && getSecretValue(entry)) {
      return {
        label: providerLabel === 'Vertex' ? 'Gemini (Vertex)' : 'Gemini API',
        values: [{ label: 'Auth', value: providerLabel === 'Vertex' ? 'Vertex' : 'API key' }],
      };
    }
    if (type === 'oauth') {
      const oauth = resolveGeminiOpenCodeOAuth({ [sourceKey]: entry });
      if (oauth) {
        return {
          label: providerLabel === 'Vertex' ? 'Gemini (Vertex)' : 'Gemini OAuth',
          oauth,
          values: [{ label: 'Auth', value: providerLabel === 'Vertex' ? 'Vertex OAuth' : 'OAuth' }],
        };
      }
    }
    if (type && (entry.project || entry.projectId || entry.location || entry.region)) {
      return {
        label: 'Gemini (Vertex)',
        values: [{ label: 'Auth', value: 'Vertex' }],
      };
    }
  }
  return null;
}

async function postGeminiCodeAssist(method, token, body) {
  const response = await fetchWithTimeout(`${GEMINI_CODE_ASSIST_URL}:${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Gemini ${method} failed: ${responseBody.error?.message || response.status}`);
  }
  return responseBody;
}

function geminiTierForModel(modelId) {
  if (/flash-lite/i.test(modelId)) return { id: 'flashLite', label: 'Lite' };
  if (/flash/i.test(modelId)) return { id: 'flash', label: 'Flash' };
  if (/pro/i.test(modelId)) return { id: 'pro', label: 'Pro' };
  return { id: modelId, label: modelId.replace(/^gemini-/, '') };
}

function summarizeGeminiBuckets(buckets = []) {
  const grouped = new Map();
  for (const bucket of buckets) {
    if (!bucket.modelId || typeof bucket.remainingFraction !== 'number') continue;
    const tier = geminiTierForModel(bucket.modelId);
    const percentRemaining = Math.round(Math.max(0, Math.min(1, bucket.remainingFraction)) * 100);
    const existing = grouped.get(tier.id);
    if (!existing || percentRemaining < existing.percentRemaining) {
      grouped.set(tier.id, {
        label: tier.label,
        percentRemaining,
        resetTimeIso: bucket.resetTime,
      });
    }
  }
  const order = { pro: 0, flash: 1, flashLite: 2 };
  return Array.from(grouped.entries())
    .sort(([a], [b]) => (order[a] ?? 99) - (order[b] ?? 99))
    .map(([, quotaWindow]) => ({
      ...quotaWindow,
      resetsIn: formatReset(quotaWindow.resetTimeIso),
    }));
}

async function getGeminiProvider() {
  const source = (await readPlusConfig()).geminiAuthSource;
  if (source === 'opencode_provider') return getGeminiOpenCodeProvider();

  try {
    const token = await getGeminiCodeAssistToken(source);
    const metadata = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
    const load = await postGeminiCodeAssist('loadCodeAssist', token, { metadata });
    const project = load.cloudaicompanionProject || load.response?.cloudaicompanionProject?.id;
    if (!project) return { id: 'gemini', label: 'Gemini', status: 'not_configured', windows: [] };

    const quota = await postGeminiCodeAssist('retrieveUserQuota', token, { project });
    return {
      id: 'gemini',
      label: 'Gemini',
      status: 'ok',
      windows: summarizeGeminiBuckets(quota.buckets),
      values: load.paidTier?.name ? [{ label: 'Tier', value: load.paidTier.name }] : [],
    };
  } catch (error) {
    if (source === 'auto') {
      const provider = await getGeminiOpenCodeProvider();
      if (provider.status === 'ok') return provider;
    }
    return { id: 'gemini', label: 'Gemini', status: 'error', error: error instanceof Error ? error.message : String(error), windows: [] };
  }
}

async function getGeminiOpenCodeProvider() {
  const provider = describeGeminiOpenCodeProvider(await readOpenCodeAuth());
  if (!provider) return { id: 'gemini', label: 'Gemini', status: 'not_configured', windows: [], values: [{ label: 'Auth', value: 'not set' }] };
  if (provider.oauth) {
    try {
      const token = await refreshGeminiAccessToken(provider.oauth, 'OpenCode provider auth');
      const metadata = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
      const load = await postGeminiCodeAssist('loadCodeAssist', token, { metadata });
      const project = load.cloudaicompanionProject || load.response?.cloudaicompanionProject?.id;
      if (project) {
        const quota = await postGeminiCodeAssist('retrieveUserQuota', token, { project });
        return {
          id: 'gemini',
          label: 'Gemini Code Assist',
          status: 'ok',
          windows: summarizeGeminiBuckets(quota.buckets),
          values: load.paidTier?.name ? [{ label: 'Tier', value: load.paidTier.name }] : provider.values,
        };
      }
    } catch {
      // OAuth may be valid for API/Vertex but not Code Assist; still report auth status below.
    }
  }
  return { id: 'gemini', label: provider.label, status: 'ok', windows: [], values: provider.values };
}

async function getClaudeProvider() {
  const source = (await readPlusConfig()).anthropicAuthSource;
  if (source === 'claude_subscription') return getClaudeSubscriptionProvider();
  if (source === 'admin_api') return getAnthropicAdminProvider();
  if (source === 'opencode_provider') return getAnthropicOpenCodeProvider();

  const subscription = await getClaudeSubscriptionProvider();
  if (subscription.status === 'ok') return subscription;
  const admin = await getAnthropicAdminProvider();
  if (admin.status === 'ok') return admin;
  const provider = await getAnthropicOpenCodeProvider();
  if (provider.status === 'ok') return provider;
  return subscription.status === 'not_configured' ? admin.status === 'not_configured' ? provider : admin : subscription;
}

async function getClaudeSubscriptionProvider() {
  return { id: 'claude', label: 'Claude', status: 'not_configured', windows: [], values: [{ label: 'Sub', value: 'not supported' }] };
}

async function getAnthropicAdminProvider() {
  const key = await getAnthropicAdminKey();
  if (!key) return { id: 'claude', label: 'Anthropic Admin', status: 'not_configured', windows: [], values: [{ label: 'Auth', value: 'not set' }] };

  try {
    const ending = new Date();
    const starting = new Date(ending.getTime() - 7 * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      starting_at: starting.toISOString(),
      ending_at: ending.toISOString(),
    });
    params.append('group_by[]', 'description');
    const response = await fetchWithTimeout(`${ANTHROPIC_COST_URL}?${params}`, {
      headers: { 'anthropic-version': '2023-06-01', 'x-api-key': key },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        id: 'claude',
        label: 'Anthropic Admin',
        status: response.status === 401 || response.status === 403 ? 'not_configured' : 'error',
        error: body.error?.message || body.message || `Anthropic costs failed: ${response.status}`,
        windows: [],
      };
    }
    const totalCents = sumAnthropicCosts(body);
    return {
      id: 'claude',
      label: 'Anthropic Admin',
      status: 'ok',
      windows: [],
      values: [
        { label: '7d', value: formatUsd(totalCents / 100) || String(totalCents) },
        { label: 'API', value: 'admin' },
      ],
    };
  } catch (error) {
    return { id: 'claude', label: 'Anthropic Admin', status: 'error', error: error instanceof Error ? error.message : String(error), windows: [] };
  }
}

function sumAnthropicCosts(body) {
  const buckets = Array.isArray(body.data) ? body.data : Array.isArray(body.buckets) ? body.buckets : [];
  let total = 0;
  for (const bucket of buckets) {
    const results = Array.isArray(bucket.results) ? bucket.results : Array.isArray(bucket.costs) ? bucket.costs : [];
    for (const item of results) total += Number(item.amount ?? item.cost ?? item.cost_cents ?? item.total ?? 0);
  }
  return total;
}

async function getAnthropicAdminKey() {
  if (process.env.ANTHROPIC_ADMIN_KEY) return process.env.ANTHROPIC_ADMIN_KEY;
  const vaultedKey = (await readProviderSecrets())?.anthropic?.adminKey;
  if (typeof vaultedKey === 'string' && vaultedKey.trim()) return vaultedKey.trim();
  return undefined;
}

async function getAnthropicOpenCodeProvider() {
  const key = resolveApiKeyAuth(await readOpenCodeAuth(), ANTHROPIC_AUTH_SOURCE_KEYS);
  if (!key) return { id: 'claude', label: 'Anthropic API', status: 'not_configured', windows: [], values: [{ label: 'Auth', value: 'not set' }] };
  return { id: 'claude', label: 'Anthropic API', status: 'ok', windows: [], values: [{ label: 'Auth', value: 'API key' }] };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'opencode-webui-sidecar-bridge' });
      return;
    }

    if (url.pathname === '/quota') {
      sendJson(res, 200, await getQuotaPayload());
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OpenCode WebUI Sidecar bridge listening on http://${HOST}:${PORT}`);
});
