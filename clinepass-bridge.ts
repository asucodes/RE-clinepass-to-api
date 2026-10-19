#!/usr/bin/env bun
/**
 * ClinePass → OpenAI-compatible dumb proxy.
 *
 * OpenCode talks to this bridge; the bridge forwards requests VERBATIM to
 * https://api.cline.bot/api/v1/chat/completions with the ClinePass
 * subscription credential and returns the response untouched.
 *
 * - No agent, no tools, no sessions on this side. OpenCode owns all
 *   execution (tools, MCP, integrations). tool_calls pass through.
 * - Auth: Cline-issued OAuth credentials from ~/.cline providers.json.
 *   Bearer token = "workos:<cline-access-token>" (the prefix is required -
 *   it distinguishes subscription OAuth from workspace API keys).
 *   Expired tokens are refreshed via POST /api/v1/auth/refresh and
 *   written back to providers.json.
 * - stream=true  → upstream SSE bytes piped through untouched.
 * - stream=false → upstream wraps the completion in {data, success};
 *   the bridge unwraps `data` before returning.
 *
 * Run: bun clinepass-bridge.ts
 * Then configure OpenCode with baseURL: http://localhost:8081/v1
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const PORT = 8081;
const API_BASE = "https://api.cline.bot";
const HOME_DIR =
  process.env.USERPROFILE || process.env.HOME || "C:\\Users\\asuuuu";
const PROVIDERS_PATH = `${HOME_DIR}/.cline/data/settings/providers.json`;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const WORKOS_PREFIX = "workos:";

const CLIENT_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "Cline",
  "X-IS-MULTIROOT": "false",
  "X-CLIENT-TYPE": "clinepass-bridge",
  "X-CLIENT-VERSION": "0.0.92",
  "X-PLATFORM": "opencode",
  "X-PLATFORM-VERSION": "0.0.92",
  "User-Agent": "Cline/0.0.92",
};

interface StoredAuth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  [k: string]: unknown;
}

function loadStore(): { raw: any; auth: StoredAuth } {
  if (!existsSync(PROVIDERS_PATH)) {
    throw new Error(`providers.json not found at ${PROVIDERS_PATH}`);
  }
  const raw = JSON.parse(readFileSync(PROVIDERS_PATH, "utf8"));
  // cline-pass shares storage id "cline" (see SDK provider-auth-registry).
  const auth: StoredAuth =
    raw?.providers?.cline?.settings?.auth ??
    raw?.providers?.["cline-pass"]?.settings?.auth ??
    {};
  return { raw, auth };
}

function stripPrefix(token: string): string {
  const t = token.trim();
  return t.toLowerCase().startsWith(WORKOS_PREFIX)
    ? t.slice(WORKOS_PREFIX.length)
    : t;
}

function withPrefix(token: string): string {
  const t = token.trim();
  return t.toLowerCase().startsWith(WORKOS_PREFIX) ? t : `${WORKOS_PREFIX}${t}`;
}

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}> {
  const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...CLIENT_HEADERS },
    body: JSON.stringify({ refreshToken, grantType: "refresh_token" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    success: boolean;
    data?: {
      accessToken: string;
      refreshToken?: string;
      expiresAt: string;
    };
  };
  if (!json.success || !json.data?.accessToken) {
    throw new Error("Invalid token refresh response");
  }
  return {
    accessToken: json.data.accessToken,
    refreshToken: json.data.refreshToken ?? refreshToken,
    expiresAt: Date.parse(json.data.expiresAt),
  };
}

// Single-flight refresh: concurrent requests share one refresh call.
let refreshPromise: Promise<string> | null = null;

async function getBearer(forceRefresh = false): Promise<string> {
  const { raw, auth } = loadStore();
  if (!auth.accessToken || !auth.refreshToken) {
    throw new Error(
      "No Cline OAuth credentials stored. Run: cline auth --provider cline-pass"
    );
  }
  const stillValid =
    typeof auth.expiresAt === "number" &&
    auth.expiresAt - Date.now() > REFRESH_BUFFER_MS;

  if (!forceRefresh && stillValid) {
    return withPrefix(auth.accessToken);
  }

  if (!refreshPromise) {
    refreshPromise = (async () => {
      console.log("[bridge] Refreshing Cline access token...");
      // Re-read to avoid racing a concurrent write.
      const { auth: fresh } = loadStore();
      const rotated = await refreshAccessToken(fresh.refreshToken!.trim());
      const { raw: latest } = loadStore();
      const slot =
        latest?.providers?.cline?.settings ??
        latest?.providers?.["cline-pass"]?.settings;
      if (slot?.auth) {
        slot.auth.accessToken = withPrefix(rotated.accessToken);
        slot.auth.refreshToken = rotated.refreshToken;
        slot.auth.expiresAt = rotated.expiresAt;
        writeFileSync(PROVIDERS_PATH, JSON.stringify(latest, null, 2));
      }
      console.log("[bridge] Token refreshed, expires:", new Date(rotated.expiresAt).toISOString());
      return withPrefix(rotated.accessToken);
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function forwardChat(bodyText: string, bearer: string): Promise<Response> {
  // Cline's upstream 500s ("empty response content") when max_tokens is set on
  // reasoning models, so drop it and let the provider apply its own cap.
  // Everything else is forwarded verbatim.
  let payload = bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      let changed = false;
      for (const key of ["max_tokens", "max_completion_tokens"]) {
        if (key in parsed) {
          delete parsed[key];
          changed = true;
        }
      }
      if (changed) payload = JSON.stringify(parsed);
    }
  } catch {
    // not JSON: forward as-is
  }
  return fetch(`${API_BASE}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
      ...CLIENT_HEADERS,
    },
    body: payload,
    signal: AbortSignal.timeout(300_000),
  });
}

const STARTED_AT = Date.now();
let lastModelsCount: number | null = null;

// Official ClinePass lineup (docs.cline.bot/getting-started/clinepass).
// Reference $/1M tokens - the subscription is flat-rate, these show how
// usage is measured against quota.
const CLINE_PASS_MODELS: Array<{
  id: string;
  name: string;
  blurb: string;
  input: number;
  output: number;
}> = [
  { id: "cline-pass/glm-5.3", name: "GLM-5.3", blurb: "Flagship reasoning", input: 1.4, output: 4.4 },
  { id: "cline-pass/glm-5.3-flash", name: "GLM-5.3 Flash", blurb: "Fast & cheap daily driver", input: 0.15, output: 0.5 },
  { id: "cline-pass/kimi-k3", name: "Kimi K3", blurb: "Agentic coding", input: 3.0, output: 15.0 },
  { id: "cline-pass/deepseek-v4-pro", name: "DeepSeek V4 Pro", blurb: "Deep reasoning", input: 1.32, output: 3.96 },
  { id: "cline-pass/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", blurb: "Fast coding", input: 0.3, output: 1.2 },
  { id: "cline-pass/mimo-v2.5", name: "MiMo-V2.5", blurb: "Lightweight", input: 0.14, output: 0.28 },
  { id: "cline-pass/mimo-v2.5-pro", name: "MiMo-V2.5-Pro", blurb: "Lightweight pro", input: 1.74, output: 3.48 },
  { id: "cline-pass/minimax-m3", name: "MiniMax M3", blurb: "Balanced coding", input: 0.3, output: 1.2 },
  { id: "cline-pass/muse-spark-1.3-contributor", name: "Muse Spark 1.3", blurb: "Budget contributor tier", input: 0.1, output: 0.2 },
  { id: "cline-pass/qwen3.8-max", name: "Qwen3.8 Max", blurb: "Qwen flagship", input: 2.0, output: 6.0 },
  { id: "cline-pass/qwen3.7-max", name: "Qwen3.7 Max", blurb: "Qwen large", input: 2.5, output: 7.5 },
  { id: "cline-pass/qwen3.7-plus", name: "Qwen3.7 Plus", blurb: "Qwen value", input: 0.4, output: 1.6 },
];

const OPENCODE_CONFIG_PATH = `${HOME_DIR}/.config/opencode/opencode.json`;

/**
 * One-click harness install: adds/updates the `clinepass` provider in the
 * user's OpenCode config, preserving all existing entries. Idempotent.
 */
async function installToOpenCode(): Promise<{ ok: boolean; message: string; models?: string[] }> {
  let config: any = {};
  if (existsSync(OPENCODE_CONFIG_PATH)) {
    config = JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, "utf8"));
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("opencode.json is not a JSON object");
  }
  config.provider ??= {};
  config.provider.clinepass = {
    npm: "@ai-sdk/openai-compatible",
    name: "ClinePass",
    options: {
      baseURL: `http://localhost:${PORT}/v1`,
      apiKey: "clinepass-local",
    },
    models: Object.fromEntries(
      CLINE_PASS_MODELS.map((m) => [
        m.id,
        {
          name: `ClinePass ${m.name}`,
          limit: { context: 1_000_000, output: 128_000 },
        },
      ])
    ),
  };
  writeFileSync(OPENCODE_CONFIG_PATH, JSON.stringify(config, null, 2));
  return {
    ok: true,
    message: `Updated ${OPENCODE_CONFIG_PATH} - restart OpenCode, then pick a ClinePass model.`,
    models: CLINE_PASS_MODELS.map((m) => m.id),
  };
}

interface DashboardStatus {
  ok: boolean;
  uptimeSec: number;
  credentialExpiresAt: number | null;
  credentialExpiresIn: string | null;
  credentialValid: boolean;
  providersPath: string;
  lastModelsCount: number | null;
  authError?: string;
}

function formatDuration(ms: number): string {
  if (ms < 0) return "expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function getStatus(): DashboardStatus {
  try {
    const { auth } = loadStore();
    const exp = typeof auth.expiresAt === "number" ? auth.expiresAt : null;
    const valid = exp !== null && exp - Date.now() > 0 && !!auth.accessToken && !!auth.refreshToken;
    return {
      ok: true,
      uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
      credentialExpiresAt: exp,
      credentialExpiresIn: exp !== null ? formatDuration(exp - Date.now()) : null,
      credentialValid: valid,
      providersPath: PROVIDERS_PATH,
      lastModelsCount,
    };
  } catch (err) {
    return {
      ok: false,
      uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
      credentialExpiresAt: null,
      credentialExpiresIn: null,
      credentialValid: false,
      providersPath: PROVIDERS_PATH,
      lastModelsCount,
      authError: String(err),
    };
  }
}
function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "api_error" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClinePass Bridge</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    color-scheme: dark;
    --bg: #0a0e14;
    --panel: #111620;
    --panel-hover: #171e2b;
    --border: #1e2635;
    --border-active: #2d3a4e;
    --text: #d4dce8;
    --text-muted: #6b7789;
    --text-dim: #4a5568;
    --accent: #4f8cff;
    --accent-hover: #6ba1ff;
    --green: #34d399;
    --red: #f87171;
    --yellow: #fbbf24;
    --mono: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  }
  body { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; font-size: 14px; line-height: 1.5; }
  .container { max-width: 860px; margin: 0 auto; padding: 40px 24px 90px; }

  .header { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
  .logo { width: 44px; height: 44px; border-radius: 12px; background: linear-gradient(135deg, #4f8cff 0%, #8b5cf6 100%); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 17px; color: #fff; flex-shrink: 0; }
  .header-info h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.3px; }
  .header-info p { color: var(--text-muted); font-size: 13px; margin-top: 2px; }

  .section { margin-top: 34px; }
  .section-title { font-size: 11px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: var(--text-dim); margin-bottom: 14px; padding-left: 2px; }
  .section-title .hint { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--text-dim); }

  /* Explainer */
  .explainer { margin-top: 18px; }
  .explainer summary {
    list-style: none; cursor: pointer; user-select: none;
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--accent); font-size: 13px; font-weight: 500;
  }
  .explainer summary::-webkit-details-marker { display: none; }
  .explainer summary .chev { transition: transform .2s; display: inline-block; }
  .explainer[open] summary .chev { transform: rotate(90deg); }
  .explainer-body { margin-top: 14px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; }
  .flow { display: flex; align-items: stretch; gap: 0; flex-wrap: wrap; margin-bottom: 16px; }
  .flow-node { flex: 1; min-width: 150px; background: #0d1117; border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; text-align: center; position: relative; }
  .flow-node b { display: block; font-size: 13px; margin-bottom: 2px; }
  .flow-node span { font-size: 11px; color: var(--text-dim); }
  .flow-node.bridge b { color: var(--accent); }
  .flow-arrow { display: flex; align-items: center; padding: 0 8px; color: var(--text-dim); font-size: 16px; }
  .explainer-body ul { margin: 0 0 0 18px; color: var(--text-muted); font-size: 13px; }
  .explainer-body li { margin-bottom: 6px; }
  .explainer-body li b { color: var(--text); font-weight: 600; }

  /* Status */
  .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .status-card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .status-card .label { font-size: 10px; font-weight: 600; letter-spacing: .8px; text-transform: uppercase; color: var(--text-dim); margin-bottom: 8px; }
  .status-card .value { font-size: 17px; font-weight: 600; }
  .status-card .value.green { color: var(--green); } .status-card .value.red { color: var(--red); } .status-card .value.accent { color: var(--accent); }
  .status-card .sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }

  .btn { display: inline-flex; align-items: center; gap: 6px; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all .15s ease; font-family: inherit; }
  .btn:hover { background: var(--panel-hover); border-color: var(--border-active); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { background: var(--accent-hover); }
  .btn.big { padding: 11px 20px; font-size: 14px; border-radius: 9px; }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }

  .test-panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .test-output { background: #0d1117; border-top: 1px solid var(--border); padding: 14px 16px; font-family: var(--mono); font-size: 12px; color: var(--text-muted); white-space: pre-wrap; word-break: break-word; min-height: 48px; max-height: 300px; overflow-y: auto; }
  .test-output.success { color: var(--green); } .test-output.error { color: var(--red); } .test-output.active { color: var(--yellow); }

  /* Models */
  .model-search { position: relative; margin-bottom: 14px; }
  .model-search input { width: 100%; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px 10px 36px; font-size: 13px; font-family: inherit; outline: none; transition: border-color .15s; }
  .model-search input:focus { border-color: var(--accent); }
  .model-search input::placeholder { color: var(--text-dim); }
  .model-search .icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-dim); pointer-events: none; }
  .model-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
  .model-item { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; cursor: pointer; transition: all .12s ease; position: relative; }
  .model-item:hover { border-color: var(--accent); background: var(--panel-hover); }
  .model-item .m-name { font-size: 13.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .model-item .m-blurb { font-size: 11.5px; color: var(--text-muted); margin-top: 2px; }
  .model-item .m-id { font-family: var(--mono); font-size: 11px; color: var(--accent); margin-top: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model-item .m-price { position: absolute; top: 12px; right: 12px; font-size: 10px; color: var(--text-dim); font-family: var(--mono); }
  .model-item .m-copy { position: absolute; bottom: 10px; right: 12px; font-size: 9px; letter-spacing: .8px; color: var(--text-dim); opacity: 0; transition: opacity .12s; }
  .model-item:hover .m-copy { opacity: 1; }
  .badge { font-size: 9px; font-weight: 700; letter-spacing: .5px; padding: 2px 7px; border-radius: 99px; }
  .badge.default { background: rgba(79,140,255,.15); color: var(--accent); }
  .badge.fast { background: rgba(52,211,153,.12); color: var(--green); }
  .model-empty { color: var(--text-dim); font-size: 13px; padding: 20px 0; text-align: center; grid-column: 1 / -1; }

  /* Guide */
  .guide-step { display: flex; gap: 16px; padding: 18px 0; border-bottom: 1px solid var(--border); }
  .guide-step:last-child { border-bottom: none; }
  .guide-num { width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; margin-top: 2px; }
  .guide-content { flex: 1; min-width: 0; }
  .guide-content h3 { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .guide-content h3 .tag { font-weight: 400; color: var(--text-dim); font-size: 12px; }
  .guide-content p { color: var(--text-muted); font-size: 13px; margin-bottom: 8px; }
  .guide-content p:last-child { margin-bottom: 0; }
  .guide-content code { background: #0d1117; border: 1px solid var(--border); padding: 4px 10px; border-radius: 6px; font-family: var(--mono); font-size: 12px; color: var(--accent); display: inline-block; cursor: pointer; }
  .guide-content code:hover { border-color: var(--accent); }

  /* Snippets */
  .snippet { margin-bottom: 16px; }
  .snippet-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .snippet-header .name { font-size: 13px; font-weight: 600; flex: 1; }
  .snippet-header .path { font-size: 11px; color: var(--text-dim); font-family: var(--mono); }
  .snippet pre { background: #0d1117; border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; font-family: var(--mono); font-size: 12px; line-height: 1.6; color: var(--text-muted); overflow-x: auto; }
  .usage-steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-top: 14px; }
  .usage-step { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .usage-step .n { font-size: 10px; font-weight: 700; color: var(--accent); letter-spacing: .5px; margin-bottom: 4px; }
  .usage-step p { font-size: 12.5px; color: var(--text-muted); }
  .usage-step p b { color: var(--text); }

  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(80px); background: var(--panel-hover); border: 1px solid var(--border-active); color: var(--text); border-radius: 8px; padding: 10px 20px; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.4); transition: transform .25s cubic-bezier(.2,.8,.3,1); z-index: 100; pointer-events: none; }
  .toast.show { transform: translateX(-50%) translateY(0); }

  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--border-active); }

  @media (max-width: 640px) {
    .container { padding: 24px 16px 70px; }
    .status-grid { grid-template-columns: 1fr 1fr; }
    .flow-arrow { transform: rotate(90deg); width: 100%; justify-content: center; padding: 4px 0; }
  }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <div class="logo">CP</div>
    <div class="header-info">
      <h1>ClinePass Bridge</h1>
      <p>Use your ClinePass subscription from any OpenAI-compatible tool</p>
    </div>
  </div>

  <div id="setup-banner" style="display:none;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.35);border-radius:10px;padding:14px 18px;margin-top:18px;font-size:13px">
    <b style="color:var(--red)">No ClinePass login found.</b>
    <span style="color:var(--text-muted)"> Run </span>
    <code style="background:#0d1117;border:1px solid var(--border);padding:2px 8px;border-radius:6px;font-family:var(--mono);font-size:12px;color:var(--accent);cursor:pointer" onclick="copy(this)" title="Click to copy">cline auth --provider cline-pass</code>
    <span style="color:var(--text-muted)"> and approve the device code, then hit Reload below. (The launcher script does this for you automatically.)</span>
  </div>

  <details class="explainer">
    <summary><span class="chev">&#9656;</span> How does this work? <span style="color:var(--text-dim)">(click to open)</span></summary>
    <div class="explainer-body">
      <div class="flow">
        <div class="flow-node"><b>Your harness</b><span>OpenCode, LiteLLM, scripts&hellip;</span></div>
        <div class="flow-arrow">&#8594;</div>
        <div class="flow-node bridge"><b>This bridge</b><span>localhost:8081</span></div>
        <div class="flow-arrow">&#8594;</div>
        <div class="flow-node"><b>api.cline.bot</b><span>ClinePass models</span></div>
      </div>
      <ul>
        <li><b>Your tool keeps full control.</b> The bridge never runs tools or agents itself - it forwards requests and returns the model's reply, including tool calls. All execution happens in your harness.</li>
        <li><b>Auth is automatic.</b> Your Cline login is stored locally by the Cline CLI. The bridge injects it into every request and silently refreshes the token when it expires (~1h). No API keys to manage.</li>
        <li><b>Standard OpenAI protocol.</b> Chat Completions in, Chat Completions out (streaming included) - that's why any OpenAI-compatible client can use it.</li>
        <li><b>Local only.</b> Everything runs on your machine. No data leaves except the model calls themselves, which go to Cline's API exactly as the Cline app would send them.</li>
      </ul>
    </div>
  </details>

  <div class="section">
    <div class="section-title">Status</div>
    <div class="status-grid">
      <div class="status-card"><div class="label">Bridge</div><div class="value" id="st-bridge">&hellip;</div></div>
      <div class="status-card"><div class="label">Credential</div><div class="value" id="st-cred">&hellip;</div></div>
      <div class="status-card"><div class="label">Token Expires</div><div class="value accent" id="st-exp">&hellip;</div><div class="sub" id="st-exp-sub"></div></div>
      <div class="status-card"><div class="label">Uptime</div><div class="value accent" id="st-uptime">&hellip;</div></div>
    </div>
    <div class="btn-row">
      <button class="btn" onclick="doRefresh()" id="btn-refresh">&#8635; Force token refresh</button>
      <button class="btn" onclick="loadStatus()">Reload</button>
    </div>
  </div>

  <div class="section">
    <div class="section-title">End-to-End Tests <span class="hint">- each spends a little ClinePass quota</span></div>
    <div class="btn-row" style="margin-top:0">
      <button class="btn primary" onclick="runTest('text')">Text completion</button>
      <button class="btn primary" onclick="runTest('tools')">Tool-call round-trip</button>
      <button class="btn primary" onclick="runStreamTest()">Streaming</button>
    </div>
    <div class="test-panel" style="margin-top:12px">
      <div class="test-output" id="log">Run a test to see results here.</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">ClinePass Models <span class="hint">- click a card to copy its id</span></div>
    <div class="model-search">
      <span class="icon">&#9906;</span>
      <input type="text" id="model-filter" placeholder="Filter models&hellip;" oninput="renderModels()">
    </div>
    <div class="model-grid" id="model-list"></div>
    <p style="font-size:11.5px;color:var(--text-dim);margin-top:10px">Reference $/1M tokens (in/out). ClinePass is a flat subscription - these show how usage counts toward your quota. Source: docs.cline.bot</p>
  </div>

  <div class="section">
    <div class="section-title">Link Your Harness</div>
    <div class="guide-step" style="padding-top:4px">
      <div class="guide-num">&#9881;</div>
      <div class="guide-content">
        <h3>OpenCode <span class="tag">- one click</span></h3>
        <p>Adds the ClinePass provider with all 12 models to your OpenCode config. Existing providers are kept untouched. Safe to click again (it just updates the entry).</p>
        <button class="btn primary big" id="btn-install" onclick="installOpenCode()">&#43; Install into OpenCode</button>
        <div class="usage-steps" id="opencode-usage" style="display:none">
          <div class="usage-step"><div class="n">THEN 1</div><p><b>Restart OpenCode</b> so it picks up the new provider.</p></div>
          <div class="usage-step"><div class="n">THEN 2</div><p>Open the <b>model picker</b> and choose any <b>ClinePass &hellip;</b> model.</p></div>
          <div class="usage-step"><div class="n">THEN 3</div><p>Just chat - requests now run through your ClinePass subscription, with tools &amp; MCP fully handled by OpenCode.</p></div>
        </div>
      </div>
    </div>
    <div class="guide-step">
      <div class="guide-num">&#8226;</div>
      <div class="guide-content">
        <h3>Anything else <span class="tag">- copy a snippet</span></h3>
        <p>Point any OpenAI-compatible client at this base URL, with any non-empty API key:</p>
        <p style="margin-bottom:0">Base URL <code onclick="copy(this)" title="Click to copy" id="base-url"></code>&ensp;&middot;&ensp;API key <code onclick="copy(this)" title="Click to copy">clinepass-local</code></p>
      </div>
    </div>
    <div class="snippet" style="margin-top:18px">
      <div class="snippet-header"><span class="name">LiteLLM</span><span class="path">config.yaml</span><button class="btn" onclick="copyById('snippet-litellm')">Copy</button></div>
      <pre><code id="snippet-litellm"></code></pre>
    </div>
    <div class="snippet">
      <div class="snippet-header"><span class="name">curl / any OpenAI client</span><span></span><button class="btn" onclick="copyById('snippet-curl')">Copy</button></div>
      <pre><code id="snippet-curl"></code></pre>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Setup <span class="hint">- from scratch, on a new machine</span></div>
    <div class="guide-step">
      <div class="guide-num">1</div>
      <div class="guide-content">
        <h3>Copy two files <span class="tag">- once per machine</span></h3>
        <p>Put <b>clinepass-bridge.ts</b> plus the launcher for your OS (<b>start-bridge.cmd</b> on Windows, <b>start-bridge.sh</b> on macOS/Linux) in one folder. Nothing to install by hand - the bridge has zero npm dependencies.</p>
      </div>
    </div>
    <div class="guide-step">
      <div class="guide-num">2</div>
      <div class="guide-content">
        <h3>Launch <span class="tag">- handles the rest itself</span></h3>
        <p>Windows: double-click <b>start-bridge.cmd</b>. macOS/Linux: <code onclick="copy(this)" title="Click to copy">chmod +x start-bridge.sh && ./start-bridge.sh</code></p>
        <p>The launcher installs <b>Bun</b> and the <b>Cline CLI</b> if missing, walks you through the <b>ClinePass device login</b> on first run, then frees port 8081, starts the bridge with auto-restart, and opens this dashboard. Close its window to stop. Only prerequisite it can't install for you: <b>Node.js LTS</b> (needed for the Cline CLI install) - get it from nodejs.org if the launcher complains about missing npm.</p>
      </div>
    </div>
    <div class="guide-step">
      <div class="guide-num">3</div>
      <div class="guide-content">
        <h3>Link &amp; verify</h3>
        <p>Use <b>Install into OpenCode</b> above or a snippet, then run a test in the Tests section. If a request ever 503s, hit <b>Force token refresh</b>; if that fails, re-run the launcher (it re-logs you in when credentials are gone).</p>
      </div>
    </div>
  </div>

</div>

<div class="toast" id="toast">Copied!</div>

<script>
const base = location.origin + "/v1";
document.getElementById("base-url").textContent = base;
document.getElementById("snippet-litellm").textContent =
  "model_list:\\n" +
  "  - model_name: clinepass-glm\\n" +
  "    litellm_params:\\n" +
  "      model: openai/cline-pass/glm-5.3\\n" +
  "      api_base: " + base + "\\n" +
  "      api_key: clinepass-local\\n";
document.getElementById("snippet-curl").textContent =
  "curl " + base + "/chat/completions \\\\\\n" +
  '  -H "Content-Type: application/json" \\\\\\n' +
  '  -H "Authorization: Bearer clinepass-local" \\\\\\n' +
  "  -d '{\\"model\\":\\"cline-pass/glm-5.3\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"Hi\\"}]}'";

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2000);
}
function setLog(msg, cls) {
  const el = document.getElementById("log");
  el.textContent = msg; el.className = "test-output" + (cls ? " " + cls : "");
}
async function copyText(txt) { await navigator.clipboard.writeText(txt); toast("Copied to clipboard"); }
async function copy(el) { await copyText(el.textContent); }
async function copyById(id) { await copyText(document.getElementById(id).textContent); }

async function loadStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    const b = document.getElementById("st-bridge");
    b.innerHTML = s.ok ? '<span class="green">&#9679; UP</span>' : '<span class="red">&#9679; DOWN</span>';
    b.className = "value";
    const c = document.getElementById("st-cred");
    c.textContent = s.credentialValid ? "VALID" : "INVALID";
    c.className = "value " + (s.credentialValid ? "green" : "red");
    document.getElementById("st-exp").textContent = s.credentialExpiresIn ?? "unknown";
    document.getElementById("st-exp-sub").textContent = s.credentialExpiresAt ? new Date(s.credentialExpiresAt).toLocaleTimeString() : "";
    document.getElementById("st-uptime").textContent = s.uptimeSec > 3600 ? Math.floor(s.uptimeSec/3600) + "h " + Math.floor(s.uptimeSec%3600/60) + "m" : Math.floor(s.uptimeSec/60) + "m";
    document.getElementById("setup-banner").style.display = (!s.ok || !s.credentialValid) ? "block" : "none";
    if (s.authError) setLog("Auth: " + s.authError + " - run: cline auth --provider cline-pass", "error");
  } catch (e) { setLog("Status fetch failed: " + e, "error"); }
}
async function doRefresh() {
  const b = document.getElementById("btn-refresh"); b.disabled = true;
  setLog("Refreshing token…", "active");
  try {
    const r = await (await fetch("/api/refresh", { method: "POST" })).json();
    if (r.ok) { setLog("✓ Refresh OK - new expiry: " + (r.status.credentialExpiresIn ?? "?"), "success"); toast("Token refreshed"); }
    else setLog("✗ Refresh FAILED: " + r.error, "error");
  } catch (e) { setLog("Refresh failed: " + e, "error"); }
  b.disabled = false; loadStatus();
}
async function runTest(kind) {
  setLog("Running " + kind + " test… (up to ~2 min)", "active");
  try {
    const r = await (await fetch("/api/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) })).json();
    if (r.ok) {
      setLog("✓ " + kind + " test passed (" + r.latencyMs + "ms)\\nfinish: " + r.finishReason + "  content: " + (r.content ?? "(tool call)") + (r.toolCalls?.length ? "  tools: " + r.toolCalls.join(", ") : ""), "success");
      toast(kind + " test passed");
    } else setLog("✗ " + kind + " test failed\\n" + JSON.stringify(r, null, 2), "error");
  } catch (e) { setLog("Test failed: " + e, "error"); }
  loadStatus();
}
async function runStreamTest() {
  setLog("Running streaming test…", "active");
  try {
    const res = await fetch("/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "cline-pass/glm-5.3", messages: [{ role: "user", content: "Reply with exactly: STREAM_OK" }], stream: true }) });
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let chunks = 0, done = false, tail = "";
    while (!done) {
      const { value, done: d } = await reader.read(); done = d;
      if (value) { chunks++; tail = dec.decode(value).slice(-300); }
    }
    setLog("✓ Stream complete - " + chunks + " chunks received\\nLast bytes:\\n" + tail, "success");
    toast("Stream test passed");
  } catch (e) { setLog("Stream test failed: " + e, "error"); }
}

async function installOpenCode() {
  const b = document.getElementById("btn-install"); b.disabled = true;
  b.textContent = "Installing…";
  try {
    const r = await (await fetch("/api/install/opencode", { method: "POST" })).json();
    if (r.ok) {
      b.textContent = "✓ Installed";
      toast("Added to OpenCode - restart OpenCode now");
      document.getElementById("opencode-usage").style.display = "grid";
      setLog("✓ " + r.message + " (" + r.models.length + " models added)", "success");
    } else {
      b.textContent = "+ Install into OpenCode";
      setLog("✗ Install failed: " + r.error, "error");
    }
  } catch (e) {
    b.textContent = "+ Install into OpenCode";
    setLog("Install failed: " + e, "error");
  }
  b.disabled = false;
}

const MODELS = [
  { id: "cline-pass/glm-5.3", name: "GLM-5.3", blurb: "Flagship reasoning", in: 1.40, out: 4.40, badge: "DEFAULT", cls: "default" },
  { id: "cline-pass/glm-5.3-flash", name: "GLM-5.3 Flash", blurb: "Fast & cheap daily driver", in: 0.15, out: 0.50, badge: "FAST", cls: "fast" },
  { id: "cline-pass/kimi-k3", name: "Kimi K3", blurb: "Agentic coding", in: 3.00, out: 15.00, badge: "", cls: "" },
  { id: "cline-pass/deepseek-v4-pro", name: "DeepSeek V4 Pro", blurb: "Deep reasoning", in: 1.32, out: 3.96, badge: "", cls: "" },
  { id: "cline-pass/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", blurb: "Fast coding", in: 0.30, out: 1.20, badge: "FAST", cls: "fast" },
  { id: "cline-pass/mimo-v2.5", name: "MiMo-V2.5", blurb: "Lightweight", in: 0.14, out: 0.28, badge: "", cls: "" },
  { id: "cline-pass/mimo-v2.5-pro", name: "MiMo-V2.5-Pro", blurb: "Lightweight pro", in: 1.74, out: 3.48, badge: "", cls: "" },
  { id: "cline-pass/minimax-m3", name: "MiniMax M3", blurb: "Balanced coding", in: 0.30, out: 1.20, badge: "", cls: "" },
  { id: "cline-pass/muse-spark-1.3-contributor", name: "Muse Spark 1.3", blurb: "Budget contributor tier", in: 0.10, out: 0.20, badge: "", cls: "" },
  { id: "cline-pass/qwen3.8-max", name: "Qwen3.8 Max", blurb: "Qwen flagship", in: 2.00, out: 6.00, badge: "", cls: "" },
  { id: "cline-pass/qwen3.7-max", name: "Qwen3.7 Max", blurb: "Qwen large", in: 2.50, out: 7.50, badge: "", cls: "" },
  { id: "cline-pass/qwen3.7-plus", name: "Qwen3.7 Plus", blurb: "Qwen value", in: 0.40, out: 1.60, badge: "", cls: "" },
];
function renderModels() {
  const box = document.getElementById("model-list");
  const q = (document.getElementById("model-filter").value || "").toLowerCase();
  const shown = MODELS.filter(m => (m.name + " " + m.id + " " + m.blurb).toLowerCase().includes(q));
  if (!shown.length) { box.innerHTML = '<div class="model-empty">No matches</div>'; return; }
  box.innerHTML = "";
  shown.forEach(m => {
    const item = document.createElement("div");
    item.className = "model-item"; item.title = "Click to copy model id";
    item.innerHTML =
      '<div class="m-name">' + m.name + (m.badge ? ' <span class="badge ' + m.cls + '">' + m.badge + '</span>' : "") + "</div>" +
      '<div class="m-blurb">' + m.blurb + "</div>" +
      '<div class="m-id">' + m.id + "</div>" +
      '<div class="m-price">$' + m.in.toFixed(2) + " / $" + m.out.toFixed(2) + "</div>" +
      '<div class="m-copy">CLICK TO COPY</div>';
    item.onclick = () => copyText(m.id);
    box.appendChild(item);
  });
}
renderModels();
loadStatus();
setInterval(loadStatus, 30000);
</script>
</body>
</html>`;

async function main() {
  console.log("[bridge] Starting ClinePass dumb proxy...");
  console.log(`[bridge] Credentials: ${PROVIDERS_PATH}`);
  try {
    const { auth } = loadStore();
    console.log(
      `[bridge] Stored token expires: ${
        typeof auth.expiresAt === "number"
          ? new Date(auth.expiresAt).toISOString()
          : "unknown"
      }`
    );
  } catch (err) {
    console.error("[bridge] Credential check failed:", String(err));
  }

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/" && req.method === "GET") {
        return new Response(DASHBOARD_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/status" && req.method === "GET") {
        return new Response(JSON.stringify(getStatus()), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/refresh" && req.method === "POST") {
        try {
          await getBearer(true);
          return new Response(JSON.stringify({ ok: true, status: getStatus() }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(
            JSON.stringify({ ok: false, error: String(err), status: getStatus() }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      if (url.pathname === "/api/install/opencode" && req.method === "POST") {
        try {
          const result = await installToOpenCode();
          console.log(`[bridge] Installed clinepass provider into OpenCode config`);
          return new Response(JSON.stringify(result), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(
            JSON.stringify({ ok: false, error: String(err) }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      if (url.pathname === "/api/test" && req.method === "POST") {
        try {
          const { kind } = (await req.json()) as { kind?: string };
          const started = Date.now();
          const testBody =
            kind === "tools"
              ? {
                  model: "cline-pass/glm-5.3",
                  messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
                  tools: [
                    {
                      type: "function",
                      function: {
                        name: "calculator",
                        description: "Evaluate a math expression",
                        parameters: {
                          type: "object",
                          properties: { expression: { type: "string" } },
                          required: ["expression"],
                        },
                      },
                    },
                  ],
                  tool_choice: { type: "function", function: { name: "calculator" } },
                }
              : {
                  model: "cline-pass/glm-5.3",
                  messages: [{ role: "user", content: "Reply with exactly: DASHBOARD_OK and nothing else." }],
                };
          const res = await forwardChat(JSON.stringify(testBody), await getBearer());
          const latencyMs = Date.now() - started;
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            return new Response(
              JSON.stringify({ ok: false, latencyMs, upstreamStatus: res.status, error: text.slice(0, 300) }),
              { headers: { "Content-Type": "application/json" } }
            );
          }
          const json = (await res.json()) as any;
          const data = json.data ?? json;
          const msg = data?.choices?.[0]?.message ?? {};
          return new Response(
            JSON.stringify({
              ok: true,
              latencyMs,
              finishReason: data?.choices?.[0]?.finish_reason ?? null,
              content: typeof msg.content === "string" ? msg.content.slice(0, 200) : null,
              toolCalls: Array.isArray(msg.tool_calls)
                ? msg.tool_calls.map((t: any) => t?.function?.name ?? t?.type ?? "?")
                : [],
              usage: data?.usage ?? null,
            }),
            { headers: { "Content-Type": "application/json" } }
          );
        } catch (err) {
          return new Response(JSON.stringify({ ok: false, error: String(err) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        try {
          const bearer = await getBearer();
          const res = await fetch(`${API_BASE}/api/v1/models`, {
            headers: { Authorization: `Bearer ${bearer}`, ...CLIENT_HEADERS },
            signal: AbortSignal.timeout(30_000),
          });
          if (res.ok) {
            const text = await res.text();
            try {
              lastModelsCount = (JSON.parse(text) as { data?: unknown[] }).data?.length ?? null;
            } catch {
              lastModelsCount = null;
            }
            return new Response(text, {
              headers: { "Content-Type": "application/json" },
            });
          }
          console.error(`[bridge] Upstream /models -> ${res.status}, using fallback`);
        } catch (err) {
          console.error("[bridge] /models proxy failed, using fallback:", String(err));
        }
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "cline-pass/glm-5.3", object: "model", owned_by: "cline" },
              { id: "cline-pass/kimi-k3", object: "model", owned_by: "cline" },
            ],
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const bodyText = await req.text();
        let wantsStream = false;
        try {
          wantsStream = (JSON.parse(bodyText) as { stream?: boolean }).stream === true;
        } catch {
          return jsonError(400, "Invalid JSON body");
        }
        console.log(`[bridge] chat/completions stream=${wantsStream} bytes=${bodyText.length}`);

        try {
          let res = await forwardChat(bodyText, await getBearer());

          if (res.status === 401) {
            console.log("[bridge] 401 from upstream, refreshing once and retrying...");
            try {
              res = await forwardChat(bodyText, await getBearer(true));
            } catch (refreshErr) {
              return jsonError(
                503,
                `ClinePass re-authentication required: ${String(refreshErr)}. Run: cline auth --provider cline-pass`
              );
            }
            if (res.status === 401) {
              return jsonError(
                503,
                "ClinePass rejected refreshed credentials. Run: cline auth --provider cline-pass"
              );
            }
          }

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            console.error(`[bridge] Upstream error ${res.status}: ${text.slice(0, 500)}`);
            return new Response(text || `Upstream error ${res.status}`, {
              status: res.status,
              headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
            });
          }

          if (wantsStream) {
            // Upstream SSE is standard OpenAI shape - pipe bytes untouched.
            return new Response(res.body, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              },
            });
          }

          // Non-streaming is wrapped as {data, success} - unwrap `data`.
          const json = (await res.json()) as {
            data?: unknown;
            success?: boolean;
            [k: string]: unknown;
          };
          const unwrapped = json.data ?? json;
          return new Response(JSON.stringify(unwrapped), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          console.error("[bridge] Error:", err);
          return jsonError(500, String(err));
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`[bridge] Listening on http://localhost:${PORT}`);
  console.log(`[bridge] OpenCode config: baseURL: "http://localhost:${PORT}/v1"`);

  process.on("SIGINT", () => {
    console.log("\n[bridge] Shutting down...");
    server.stop();
    process.exit(0);
  });
}

main().catch(console.error);
