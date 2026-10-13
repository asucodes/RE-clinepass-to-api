# ClinePass Bridge (dumb proxy + dashboard)

Routes any OpenAI-compatible harness through a ClinePass subscription.
The bridge is a **pure pass-through**: the harness owns 100% of execution
(tools, MCP, integrations). Cline is used just like a model API.

Routes OpenCode requests through a ClinePass subscription. The bridge is a
**pure pass-through**: OpenCode owns 100% of execution (tools, MCP,
integrations). Cline is used just like a model API.

## How it works

```
OpenCode  →  http://localhost:8081/v1  →  clinepass-bridge.ts (Bun)
                                              →  https://api.cline.bot/api/v1/chat/completions
```

- OpenCode's request body (messages, tools, tool_choice, temperature, …)
  is forwarded **verbatim** upstream. `tool_calls` come back untouched,
  so OpenCode's tool loop works normally.
- The bridge only adds auth + client headers, and normalizes responses:
  - `stream=true` → upstream SSE bytes piped through byte-for-byte
    (upstream streaming is standard OpenAI shape).
  - `stream=false` → upstream wraps the completion in `{data, success}`
    (known quirk, cline/cline#12647); the bridge unwraps `data`.
- No agent, no sessions, no Cline SDK. Each request is one stateless
  HTTP call (~seconds, not minutes) and costs exactly one model call.

### Auth (reverse-engineered from cline/cline source)

- Credentials live in `~/.cline/data/settings/providers.json`, provider
  key `cline` (cline-pass shares storage id `cline`).
- Stored: `auth.accessToken = "workos:<cline-access-token>"`,
  `auth.refreshToken` (Cline-issued), `auth.expiresAt` (epoch ms).
- The **`workos:` prefix is mandatory** in the `Authorization: Bearer`
  header - it distinguishes subscription OAuth from workspace API keys.
  A raw WorkOS JWT 401s.
- Register: `POST /api/v1/auth/register {accessToken, refreshToken}`
  (WorkOS tokens) → Cline-issued `{accessToken, refreshToken, expiresAt}`.
- Refresh: `POST /api/v1/auth/refresh {refreshToken, grantType:
  "refresh_token"}` (Cline-issued refresh token).
- The bridge refreshes when `expiresAt - now < 5 min` (single-flight
  across concurrent requests), writes rotated tokens back to
  providers.json, and on a 401 retries once after a forced refresh.
- If refresh fails → HTTP 503 telling you to re-run
  `cline auth --provider cline-pass` and approve the device code.

## One-click launch

**Fresh device:** copy two files into a folder - `clinepass-bridge.ts` and
the launcher for your OS (`start-bridge.cmd` on Windows,
`start-bridge.sh` on macOS/Linux). Nothing to `npm install` - the bridge
has zero npm dependencies (only Bun itself).

The launcher is self-bootstrapping: it installs **Bun** and the **Cline
CLI** if missing, walks you through the **ClinePass device login** on
first run, then frees port 8081, starts the bridge with auto-restart, and
opens the dashboard. Close its window to stop. The one thing it cannot
install for you is **Node.js LTS** (needed for `npm i -g cline`) - it
tells you exactly that if npm is absent.

If the dashboard ever shows the red "No ClinePass login found" banner,
re-run the launcher (it re-logs you in when credentials are gone) or run
`cline auth --provider cline-pass` manually.

Manual equivalent: `bun clinepass-bridge.ts` in this directory.

## Web dashboard (http://localhost:8081/)

- **Status**: bridge uptime, credential VALID/INVALID, token expiry
  countdown (auto-refreshes every 30s). No secrets are ever displayed.
- **Force token refresh** button (also auto-refreshes before expiry).
- **End-to-end tests**: text completion, tool-call round-trip, streaming
  - results render inline. Each spends a little ClinePass quota.
- **Link a harness**: copy-paste snippets for OpenCode, LiteLLM, and
  generic OpenAI clients / curl. Any harness works with:
  - Base URL: `http://localhost:8081/v1`
  - API key: any non-empty string (e.g. `clinepass-local`)
  - Model: `cline-pass/glm-5.3` or any id from `GET /v1/models`

## Reproduce from scratch

Prerequisites: Bun installed, `cline auth --provider cline-pass` done once.

1. In this directory: `bun clinepass-bridge.ts` (or double-click
   `start-bridge.cmd`)
   (listens on `http://localhost:8081`, reads `~/.cline` credentials -
   home dir resolves via `USERPROFILE` on Windows).
2. `~/.config/opencode/opencode.json` (keep existing entries):
   ```json
   "clinepass": {
     "npm": "@ai-sdk/openai-compatible",
     "name": "ClinePass",
     "options": {
       "baseURL": "http://localhost:8081/v1",
       "apiKey": "clinepass-local"
     },
     "models": {
       "cline-pass/glm-5.3": { "name": "ClinePass GLM 5.3" }
     }
   }
   ```
3. In OpenCode, select model `clinepass / cline-pass/glm-5.3`.

## Test procedure

Bridge must be running.

1. Health: `curl.exe -sS http://localhost:8081/health` → `{"status":"ok"}`
2. Models: `curl.exe -sS http://localhost:8081/v1/models` → live upstream
   catalog (proxied with auth).
3. Non-streaming:
   ```powershell
   $body = @{ model = "cline-pass/glm-5.3";
     messages = @(@{ role = "user"; content = "Reply with exactly: PROXY_OK and nothing else." }) } | ConvertTo-Json -Depth 5
   Set-Content "$env:TEMP\\t.json" $body -NoNewline -Encoding UTF8
   curl.exe -sS -X POST "http://localhost:8081/v1/chat/completions" `
     -H "Content-Type: application/json" --data-binary "@$env:TEMP\\t.json" --max-time 180
   ```
   Expected: top-level `choices[0].message.content == "PROXY_OK"`.
   NOTE: omit `max_tokens` - this model 500s ("empty response content")
   when it is set; root cause unknown, likely reasoning-token accounting.
4. Streaming: same with `stream = $true` → standard SSE chunks + `data: [DONE]`.
5. Tools: include `tools` + forced `tool_choice` → `finish_reason ==
   "tool_calls"` with `message.tool_calls[].function{name, arguments}`.
6. OpenCode: pick the `clinepass` model, send a message, use a tool.
   Bridge log shows one `chat/completions stream=...` line per call.

## Troubleshooting

- `EADDRINUSE` on 8081: kill the stale listener:
  ```powershell
  Get-Process -Id (Get-NetTCPConnection -LocalPort 8081 -State Listen).OwningProcess | Stop-Process -Force
  ```
- 503 "re-authentication required": `cline auth --provider cline-pass`.
- Upstream 500 "empty response content": retry without `max_tokens`.
- OpenCode errors but no `chat/completions` line in bridge log: OpenCode
  isn't hitting the bridge - check `baseURL` / port.

## Caveats

- Localhost only; the `apiKey` value is a placeholder (bridge ignores it).
- Model id is passed through; use ids the subscription allows
  (`cline-pass/...` prefix works, bare upstream ids like `z-ai/glm-5.3`
  should also work but are untested here).
- No conversation memory in the bridge - but OpenCode manages its own
  history, so multi-turn works via OpenCode sending full history.

## Files

- `clinepass-bridge.ts` - the proxy + dashboard (no deps beyond Bun
  stdlib - `@cline/*` packages in package.json are leftover from the
  previous agent-based design and no longer imported).
- `start-bridge.cmd` - thin Windows stub (runs the `.ps1` below, then
  pauses so the window never vanishes on error).
- `start-bridge.ps1` - self-bootstrapping Windows launcher (installs
  Bun + Cline CLI if missing, device login on first run, frees port,
  starts the bridge, waits for the health check, THEN opens the
  dashboard; everything logged to `setup.log`, server output to
  `bridge.log`). Must be UTF-8 **with BOM** and pure ASCII -
  Windows PowerShell misdecodes BOM-less non-ASCII (stray `"` chars
  break parsing).
- `start-bridge.sh` - same for macOS/Linux (`chmod +x
  start-bridge.sh && ./start-bridge.sh`). Syntax-checked with
  `bash -n`.
