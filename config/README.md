# Runtime config. Copy one sample to config.json and edit it.

`config.json` lives in the plugin root (next to `src/` and `bin/`). On startup `src/server.mjs`
looks for `WB_PROXY_CONFIG`, then `src/config.json`, then falls back to the plugin-root
`config.json`.

## Samples in this directory

| file | mode | use |
|---|---|---|
| `config.credits.json` | `wbipc` | borrow the WorkBuddy local broker to spend credits, fall back to balance |
| `config.relay.json` | `http` + `openai` | point at any OpenAI-compatible relay (e.g. workbuddy2api on 8790) with an `sk-` key |
| `config.sandbox.json` | `wbipc` variant | local smoke test: no key, `fallback: false` |

```powershell
Copy-Item config\config.credits.json config.json
```

## Field reference

| field | meaning |
|---|---|
| `listen.host` / `listen.port` | default `127.0.0.1:8787`. `0.0.0.0` only on a trusted network: `clientToken` is the sole gate, and the credit channel bills real quota |
| `clientToken` | required. When empty, the proxy generates a random token at startup and prints it once to stderr; it is never disabled. Only `x-api-key` / `Authorization: Bearer` are accepted (`?token=` was removed because it leaks into access logs and Referer) |
| `upstream.mode` | `wbipc` (credits) / `direct` (memory token) / `http` (key) |
| `upstream.type` | `anthropic` (native passthrough) or `openai` (translate via `/chat/completions`) |
| `upstream.baseURL` | `https://api.deepseek.com/anthropic` for anthropic mode; a root URL for openai mode |
| `upstream.apiKey` / `apiKeys` | upstream keys; `WB_DEEPSEEK_KEY` overrides without writing to disk |
| `upstream.fallback` | fall back to the key channel when the credit channel fails |
| `upstream.timeoutMs` / `maxRetries` | first-byte timeout / retries on 429 and 5xx |
| `wbipc.maxInputTokens` | estimated input beyond this skips the credit channel |
| `wbipc.requestTimeoutMs` | broker call timeout, keep it at or below 52s |
| `direct.baseURL` | direct gateway, default `https://copilot.tencent.com` |
| `modelMap` | DSH model id -> upstream model id; switch upstreams here only |
| `catalog` | what `/v1/models` advertises; `/healthz` returns only `{ok:true}`, and the authenticated `/healthz/details` carries the mode and catalog |
| `log.dir` / `log.enabled` | JSONL request log, relative to the plugin root; written through an async queue, rotated at 20MB and pruned after 7 days |

Environment overrides: `WB_PROXY_HOST`, `WB_PROXY_PORT`, `WB_UPSTREAM_BASE`, `WB_UPSTREAM_TYPE`,
`WB_DEEPSEEK_KEY`, `WB_CLIENT_TOKEN`, `WB_PROXY_CONFIG`, `WB_PROXY_VERBOSE=1`.

## Paths in the plugin layout

| purpose | path |
|---|---|
| runtime config | `<plugin>\config.json` |
| request log | `<plugin>\logs\proxy-YYYY-MM-DD.jsonl` |
| direct-mode token cache | `<plugin>\logs\token.json` (contains a full JWT - high sensitivity, ACL-locked to the current user) |
| token scan script | `<plugin>\src\scan-token.ps1` |
| WorkBuddy broker ticket | `~/.workbuddy/wbipc/endpoint.json` |
