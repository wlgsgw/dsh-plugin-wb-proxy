# wb-proxy · WorkBuddy 积分反代（DeepSeek Harness 插件）

把 WorkBuddy 侧可用的 DeepSeek（**DeepSeek-V4.1-Flash** / **DeepSeek-V4-Pro**）通道，反向代理成
DeepSeek Harness（DSH）原生可消费的 **Anthropic Messages** 端点。计费优先走 WorkBuddy 积分，
失败自动回落 `sk-` 余额通道。零依赖，Node ≥ 18 即可跑。

```
DSH（deepseek-official 路由）
   │  POST http://127.0.0.1:8787/v1/messages      x-api-key: local-proxy
   ▼
wb-proxy
   ├─ direct  内存 OIDC token ──▶ copilot.tencent.com/v2/chat/completions   （积分，真流式）
   ├─ wbipc   WorkBuddy 本地 broker ──▶ 同上网关                            （积分，50s/640KB 限制）
   └─ http    sk- key ──▶ api.deepseek.com/anthropic 或任意 OpenAI 兼容中继   （余额 / 中继）
```

> 英文版说明见 [`README.md`](README.md)。

## 快速开始

```powershell
# 0) 克隆或解压到任意目录
git clone https://github.com/wlgsgw/dsh-plugin-wb-proxy.git
cd dsh-plugin-wb-proxy

# 1) 备配置：选一份样例，填 upstream 项
Copy-Item config\config.credits.json config.json

# 2) 装配：部署到 %USERPROFILE%\.dsh\wb-proxy，写 DSH profile，注册自启
node setup.mjs --dry-run      # 先看要写什么
node setup.mjs                # 真装

# 3) 起来 + 查看状态
powershell -NoProfile -ExecutionPolicy Bypass -File bin\start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File bin\status.ps1
```

DSH 侧会被写入 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `llm-deepseek` 段（`baseURL` 指向本地反代），
以及 `~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_PROXY_KEY`。改写前都会备份成 `*.bak-wbplugin-<时间戳>`。
重启 DSH 后，模型选择器里出现两条带 `(WB proxy)` 的模型。

## 三条上游通道

| mode | 走什么 | 优点 | 限制 |
|---|---|---|---|
| `direct` | 读 WorkBuddy 进程内存里的 OIDC token，直连 `copilot.tencent.com` | 真流式、无 50s/640KB 限制 | 需要 WorkBuddy 在跑且已登录，token 过期要重扫（约 2 分钟） |
| `wbipc` | 借 WorkBuddy 本地 broker 的 `wb.request/http.fetch` | 不用碰内存 | broker 写死 50s 超时 / 640KB 响应体 / 整段返回 |
| `http` | 用 `sk-` key 打 `baseURL` | 稳定、可接任意中继 | 花余额 |

积分通道的兜底规则：输入估算 > `wbipc.maxInputTokens`（默认 20000）直接跳过积分；连续失败 2 次熔断 10 分钟；
超时回 504 不回落（避免同一请求花两次钱）；其它失败且 `upstream.fallback: true` 时回落 key 通道。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages，流式/非流式 |
| POST | `/v1/messages/count_tokens` | 透传上游（OpenAI 模式返回 0） |
| GET | `/v1/models`、`/models` | 本地目录，OpenAI 形状 |
| GET | `/healthz` | 上游类型、key 数量、模型列表、是否要求 token |

鉴权：`x-api-key: <clientToken>`、`Authorization: Bearer <clientToken>` 或 `?token=`。

## 自检与打包

```powershell
node tests\smoke.mjs --live          # 临时端口真起一次，验 healthz / 401 / models
node scripts\pack.mjs --out dist --verify   # 打包并解压自检
node scripts\repair-encoding.mjs --scan src\*.mjs   # 源码乱码体检（GBK 误读写）
```

## 目录

```
setup.mjs        一键装配（运行目录 + DSH profile + 自启）
src/             server.mjs、direct-upstream、wbipc-client、wbipc-upstream、openai-bridge、empty-guard
bin/             start / stop / status / install-autostart / uninstall-autostart / balance / start.cmd
config/          credits / relay / sandbox 三份样例 + 字段说明
patch/           cordis.patch.snippet.yml（DSH profile 补丁片段）
scripts/         pack.mjs、repair-encoding.mjs
tests/           smoke.mjs
```

## 故障对照（摘要）

| 现象 | 处理 |
|---|---|
| DSH 报 `MISSING_CREDENTIAL` | `.credentials.yaml` 的 `refs.DEEPSEEK_PROXY_KEY` 被 UI 重写，补回 `local-proxy` |
| DSH 报 `TRANSPORT` / 连接失败 | 代理没起：`bin\status.ps1`；或 `Start-ScheduledTask -TaskName WbDeepseekProxy` |
| 401 `invalid proxy token` | DSH 里的 key 与 `clientToken` 不一致 |
| healthz 里 `keys: 0` | 积分模式正常；`http` 模式要填 `upstream.apiKey` |
| 402 / 429 | 额度或限流：`upstream.apiKeys` 加备用 key |
| 流式卡住 | `upstream.timeoutMs` 管首包；看 `logs/proxy-*.jsonl` 的 `ms` 与 `status` |

## 注意

- 仓库里只有样例配置，**真实 `sk-` key 请只写在本机 `config.json`**（已被 `.gitignore` 忽略）。
- `wbipc` / `direct` 都要求 WorkBuddy 进程在运行且已登录。
- `scan-token.ps1` 需要同用户权限读取 WorkBuddy 进程内存，部分杀软会拦。
- 本项目与你自己的 WorkBuddy 账号绑定使用，请遵守对应服务条款。

## License

MIT
