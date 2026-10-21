# Antigravity for PI-Desktop

Use **Google Antigravity / Cloud Code Assist** models as a native PI-Desktop
provider, on your own Google account's quota: Gemini 4 Argon, Gemini 3.8 Flash,
Claude Opus 5.5, Claude Sonnet 5.5 and GPT-OSS 120B — chat, in-chat image
generation, grounded web search, and quota monitoring.

> Unofficial integration. Not affiliated with or endorsed by Google. Use it only
> with an account and services you are authorized to access, and review the
> source before granting OAuth permissions.

Repository: <https://github.com/yunzinan/pi-desktop-antigravity-plugin> · Issues: <https://github.com/yunzinan/pi-desktop-antigravity-plugin/issues>

## Install

Download the `.piplug` from the [latest release](https://github.com/yunzinan/pi-desktop-antigravity-plugin/releases/latest) and
install it from **Plugins → Install from file**. Then open the Antigravity panel from the
sidebar and sign in with Google. Pick a model in the model picker and chat.

## What it does

| Feature | Where |
|---|---|
| Chat with all Antigravity models, per-effort thinking levels | model picker |
| Image generation | ask in the conversation, or the panel's *Generate image* card |
| Grounded web search with citations | ask in the conversation, or the panel's *Web search* card |
| Quota buckets and reset times | panel, loaded automatically |
| Model discovery from the server | panel → *Refresh from server* |

Both in-chat tools are opt-out: the panel's *Use image & web search inside chat*
checkbox (on by default) controls whether the model is offered them at all.

## Architecture

```
PI-Desktop ──OpenAI chat/completions──▶ 127.0.0.1:51122 ──▶ Cloud Code Assist
   (provider)                            (this plugin)        v1internal:*
```

Antigravity does not speak any wire protocol PI-Desktop supports — it exposes
`v1internal:streamGenerateContent` with a Google-specific envelope, its own auth
envelope, and Gemini-style `functionCall` parts. So the plugin runs a small
local OpenAI-compatible proxy and registers a provider that points at it:

- `main.cjs` — plugin host: OAuth login (PKCE + loopback on 127.0.0.1:51121),
  token refresh, proxy lifecycle, panel channels, commands.
- `proxy.cjs` — the translation layer: request/response mapping, tool-call
  bridging, image generation, grounded search, quota, model discovery.
- `renderer/index.html` — the sidebar panel.

The provider route (not the agent-extension route) is the only path that works
here: the sidecar's `trustedExtensions` is empty, so TypeScript extensions are
never loaded. `src/*.ts` is kept because the manifest declares it and the host
rejects a package whose declared extension files are missing.

### Why `node_modules/undici` is vendored

The plugin runs inside the app's Node process, whose `fetch` ignores the macOS
system proxy — behind Clash, every direct Google call dies with a connect
timeout. Routing through a loopback `ProxyAgent` is the only thing that works,
and `undici` is the only way to get one.

Node's built-in `NODE_USE_ENV_PROXY` would remove the dependency, but it is read
at process start and the app spawns the plugin host, so the variable cannot be
set in time. Hence the vendored copy: this plugin is installed as a package, not
through `npm install`, so the dependency has to ship with it.

### Credentials

Sign-in stores the account in `~/.pi/agent/antigravity-accounts.json`. The
credential PI-Desktop owns is preferred and refreshed by the host; the local
store is only a fallback, so the app never has to re-authenticate.

## Develop

1. **Plugins → Load development plugin**, pointing at this directory. The app
   reloads the plugin whenever you save a file.
2. Validate and package:

   ```bash
   python3 pack.py --check   # list what would ship
   python3 pack.py           # writes dist/<id>-<version>.piplug + sha256
   ```

3. Install the resulting `.piplug` from the Plugins page to test it the way a
   user would.

## Publish

Packages are distributed through the PI-Desktop plugin center
(`https://plugins.aiuo.net/catalog.json`), which only serves packages hosted on
`github.com` or `raw.githubusercontent.com`. Publishing is done from the console,
not from the app:

1. Register at `https://plugins.aiuo.net/console/register`.
2. Claim the plugin id under *Publish → Claim*.
3. Upload a version under *Publish → Upload* — either Git mode (packages in a
   branch) or GitHub Release mode (a stable asset URL per version, needs an
   HTTPS repo and a token).
4. Track the review under *Publish → Submissions*.

The catalog entry requires `license`, `engines.piDesktop`, `categories`,
`changelog`, and `i18n` with `name`/`description`/`safetyNotes` for `en` and
`zh-CN`; `pack.py` keeps the package itself small enough to review.

## Troubleshooting

- **Panel stuck on "Checking…"** — the plugin host did not answer. Reload the
  plugin; if it persists, check *Plugins* for a crash notice.
- **"Antigravity is not signed in"** — open the panel and sign in again.
- **Image generation reports a quota limit** — the image model has its own
  limit, separate from the chat quota the panel shows, and it is not reported by
  the quota endpoint. Wait for it to reset.
- **"Model list unavailable"** — the panel could not read the manifest. Reload
  the plugin.
- **Port 51122 already in use** — a stale proxy from an earlier session holds
  it. The listener PID must match the app's PID; kill anything else.

---

<details>
<summary>中文说明</summary>

把 Google Antigravity / Cloud Code Assist 模型接成 PI-Desktop 的原生
provider，走你自己的 Google 账号配额：Gemini 4 Argon、Gemini 3.8 Flash、
Claude Opus/Sonnet 5.5、GPT-OSS 120B，支持对话、会话内生图、联网搜索和配额监控。

非官方集成，与 Google 无关联。请只用于你有权使用的账号和服务，授予 OAuth
权限前先审阅源码。

**安装**：从 [Release](https://github.com/yunzinan/pi-desktop-antigravity-plugin/releases/latest) 下载 `.piplug`，在「插件 →
从文件安装」中安装，然后打开
侧边栏的 Antigravity 面板用 Google 登录，即可在模型选择器里选模型对话。

**架构**：Antigravity 只提供 `v1internal:streamGenerateContent` 这种
Google 专用信封，PI-Desktop 不支持，所以插件在 `127.0.0.1:51122` 起了一个
OpenAI 兼容的本地代理做协议转换，再把 provider 指向它。

**发布**：包经插件中心分发，只认 `github.com` /
`raw.githubusercontent.com` 上的包；发布在 `plugins.aiuo.net` 的控制台完成，
不在 App 里。

</details>
