# wb-proxy plugin - not to be confused with the dev scratch area

A zero-dependency local reverse proxy that turns the WorkBuddy credit channel into an
Anthropic Messages endpoint that DeepSeek Harness (DSH) can consume natively.

```
DSH (deepseek-official route)
   |  POST http://127.0.0.1:8787/v1/messages      x-api-key: local-proxy
   v
wb-proxy
   |- direct  in-memory token -> copilot.tencent.com/v2/chat/completions   (credits, true streaming)
   |- wbipc   WorkBuddy local broker -> same gateway                       (credits, 50s / 640KB caps)
   '- http    sk- key -> api.deepseek.com/anthropic or any OpenAI relay    (balance / relay)
```

## 1. Layout

```
wb-proxy-plugin/
  setup.mjs                 one-shot install: runtime dir + DSH profile + autostart
  package.json              plugin manifest (dsh.plugin section)
  src/
    server.mjs              proxy main process (:8787, three upstream channels, gates, breaker)
    direct-upstream.mjs     direct credit channel (memory token + fingerprint sanitize)
    wbipc-client.mjs        WorkBuddy broker handshake + JSON-RPC
    wbipc-upstream.mjs      Anthropic -> WorkBuddy chat completion, SSE back-translation
    openai-bridge.mjs       Anthropic <-> OpenAI Chat Completions translation
    empty-guard.mjs         empty-stream detection
    scan-token.ps1          read-only scan of the WorkBuddy process for the OIDC token
  bin/
    start.ps1 stop.ps1 status.ps1                 start / stop / status (idempotent)
    install-autostart.ps1 uninstall-autostart.ps1 logon + 1-minute watchdog task
    balance.ps1                                    query balance, append history
    start.cmd                                      double-click launcher
  config/
    config.credits.json     credit mode sample
    config.relay.json       relay (openai protocol) sample
    config.sandbox.json     local smoke sample (no key)
  patch/cordis.patch.snippet.yml    DSH profile patch fragment
  scripts/
    pack.mjs                zip to Desktop (--verify runs a self-check)
    repair-encoding.mjs     detect / repair GBK mojibake
  tests/smoke.mjs           assembly self-check (--live starts a temp port)
  logs/                     created at runtime
```

## 2. Install (3 steps)

```powershell
# 0) unzip anywhere, e.g. C:\Tools\wb-proxy-plugin
cd C:\Tools\wb-proxy-plugin

# 1) prepare the runtime config
Copy-Item config\config.credits.json config.json
#    edit config.json: at least listen.port / clientToken / upstream.*

# 2) install: deploy to %USERPROFILE%\.dsh\wb-proxy, patch DSH profile, register autostart
node setup.mjs --dry-run
node setup.mjs

# 3) run
powershell -NoProfile -ExecutionPolicy Bypass -File bin\start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File bin\status.ps1
```

setup.mjs steps (each can be disabled):

| step | flag | what it does |
|---|---|---|
| deploy runtime | `--runtime <dir>` | default `~/.dsh/wb-proxy`; copies src/bin/config, writes config.json |
| patch `cordis.patch.yml` | `--no-patch` | appends the `llm-deepseek` block pointing baseURL at the proxy |
| patch `.credentials.yaml` | `--no-patch` | `refs.DEEPSEEK_PROXY_KEY: local-proxy` |
| register scheduled task | `--no-autostart` | `WbDeepseekProxy`, at logon + every minute |

Other flags: `--port 8787`, `--host 127.0.0.1`, `--mode wbipc|direct|http`, `--token local-proxy`,
`--profile desktop`. Every file it touches is backed up first as `<file>.bak-wbplugin-<timestamp>`.

`start.ps1` is idempotent: when the port is already listening it returns immediately, so the
one-minute watchdog never spawns a second process.

## 3. What changes on the DSH side

`~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    baseURL: http://127.0.0.1:8787
    apiKeyEnv: DEEPSEEK_PROXY_KEY
    reasoningEffort: high
    models:
      - id: deepseek-flash
        name: DeepSeek-V4.1-Flash (WB proxy)
        contextWindow: 1048576
        inputModalities: [ text, image ]
        systemPromptUpdate: in-history
        toolUpdate: addition-only
      - id: deepseek-v4-pro
        name: DeepSeek-V4-Pro (WB proxy)
        contextWindow: 1048576
        inputModalities: [ text ]
```

`~/.dsh/.credentials.yaml`:

```yaml
version: 1
refs:
  DEEPSEEK_PROXY_KEY: local-proxy
records: { }
```

`local-proxy` is only the handshake between DSH and this process; the real upstream key lives in
`config.json`. Restart DSH and two models tagged `(WB proxy)` show up in the model picker. The
account route (`deepseek-account`) is untouched, so both channels coexist.

## 4. Upstream channels

| mode | path | pros | limits |
|---|---|---|---|
| `direct` | OIDC token read from the WorkBuddy process, straight HTTPS to `copilot.tencent.com` | true streaming, no 50s / 640KB caps | needs WorkBuddy running and logged in; token refresh rescans memory (~2 min) |
| `wbipc` | WorkBuddy local broker `wb.request/http.fetch` | never touches process memory | broker enforces 50s timeout, 640KB body, buffered response |
| `http` | `sk-` key against `baseURL` | stable, any relay works | spends balance |

Fallback rules in `server.mjs`:

1. estimated input > `wbipc.maxInputTokens` (default 20000) -> skip the credit channel;
2. 2 consecutive failures -> 10 minute cooldown;
3. timeout (`rpc timeout`) -> 504, no fallback (never pay twice for one request);
4. other failures with `upstream.fallback: true` -> fall back to the key channel.

Account switching: `logs/token.json` stores `sub` (the WorkBuddy uid). Every token read compares it
with `primary.uid` in `~/.workbuddy/storage/skeleton/account-snapshot.json`; on mismatch or near
expiry the token is rescanned automatically, so switching accounts needs no config change.

## 5. HTTP API

| method | path | notes |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages, streaming and non-streaming |
| POST | `/v1/messages/count_tokens` | passthrough (returns 0 in openai mode) |
| GET | `/v1/models`, `/models` | local catalog, OpenAI shape |
| GET | `/healthz` | upstream type, key count, model list, whether a token is required |

Auth: `x-api-key: <clientToken>`, `Authorization: Bearer <clientToken>`, or `?token=`.

## 6. Troubleshooting

| symptom | fix |
|---|---|
| DSH reports `MISSING_CREDENTIAL` | `refs.DEEPSEEK_PROXY_KEY` was rewritten by the UI; restore `local-proxy` |
| DSH reports `TRANSPORT` / connection failed | proxy is down: check `bin\status.ps1`, or `Start-ScheduledTask -TaskName WbDeepseekProxy` |
| 401 `invalid proxy token` | DSH key differs from `clientToken` |
| `keys: 0` in healthz | normal in credit mode; `http` mode needs `upstream.apiKey` |
| 402 / 429 | quota or rate limit: add keys to `upstream.apiKeys`; the `status` field in the log shows it |
| log `upstream_error` with `Thinking mode does not support this tool_choice` | upstream limitation, not a proxy bug |
| thinking blocks vanish in openai mode | by design: a relay cannot supply the Anthropic `signature` |
| streaming stalls | `upstream.timeoutMs` covers the first byte; inspect `logs/proxy-*.jsonl` |
| mojibake in source comments | `node scripts/repair-encoding.mjs --scan src\*.mjs`, then `--fix` |

## 7. Package / uninstall

```powershell
node scripts\pack.mjs                          # -> Desktop\dsh-plugin-wb-proxy-<version>.zip
node scripts\pack.mjs --out D:\dist --verify   # custom dir + unpack-and-self-check
node tests\smoke.mjs --live                    # self-check only (temp port, no upstream calls)
```

Rollback:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File bin\uninstall-autostart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File bin\stop.ps1
# restore the timestamped backups
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-wbplugin-*" "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force
Copy-Item "$env:USERPROFILE\.dsh\.credentials.yaml.bak-wbplugin-*" "$env:USERPROFILE\.dsh\.credentials.yaml" -Force
# restart DSH
```

To keep the proxy but drop the default-model switch, point `agent-default-model.provider` back at
`deepseek-account`.

## 8. Known limits

1. broker hard timeout is 50s, so large inputs must use `direct` or `http`;
2. broker response body caps at 640KB;
3. `wbipc` and `direct` both require a running, logged-in WorkBuddy process;
4. `scan-token.ps1` needs same-user rights to read WorkBuddy memory and may trip AV heuristics;
5. no npm dependencies: Node >= 18 is enough; the optional `workbuddy2api` Python relay is extra.
