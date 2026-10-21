# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
semantic versioning.

## [0.12.0] - 2026-10-21

First public release.

### Added

- Native PI-Desktop provider for Google Antigravity / Cloud Code Assist, covering
  Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5, Claude Sonnet 5.5 and
  GPT-OSS 120B, each with its own thinking-effort levels.
- In-chat image generation. The proxy intercepts the built-in `GenerateImages`
  tool — whose own implementation refuses every OAuth provider that is not the
  OpenAI Codex vendor — and runs it against Antigravity instead, appending the
  result to the reply as an inline markdown image. The plugin's own
  `antigravity_generate_image` tool is declared as well, so either path works.
- In-chat grounded web search through Google Search grounding, with inline
  citations and a source list when the model drops it.
- Sidebar panel: account status, quota buckets, manual image generation and web
  search, and model discovery from the server.
- Model discovery that merges the server catalog into the manifest: fine-grained
  thinking variants survive when their family still exists, and only genuinely
  new public models are appended.

### Fixed

- Tool calls now echo the `thoughtSignature` Cloud Code Assist issues them with;
  without it the endpoint answers `400 Function call is missing a
  thought_signature`.
- A model that spends every round on tools without answering now gets one final
  call with the tools withdrawn and their results folded into plain text.
- The panel no longer reads the model count straight from the proxy port (the
  sandboxed frame cannot reach it, which showed up as a permanent
  "Model list unavailable"). It goes through the host bridge, and the proxy
  reflects CORS origins as a second line of defence.
- The panel survives its own failures: each card degrades independently, and a
  `boot()` error is rendered instead of leaving the panel stuck on "Checking…".

### Security

- OAuth login uses PKCE with a loopback redirect on 127.0.0.1:51121.
- Tokens live in `~/.pi/agent`; the credential the host sends is preferred and
  refreshed by the host, so the plugin never stores a token the app owns.
- All upstream traffic is routed through the resolved system proxy, because
  Node's `fetch` ignores the macOS system proxy and direct Google calls time out
  behind one.

[0.12.0]: https://github.com/yunzinan/pi-desktop-antigravity-plugin/releases/tag/v0.12.0
