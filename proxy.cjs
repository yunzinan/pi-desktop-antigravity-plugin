"use strict";

/**
 * OpenAI-compatible front end for Google Antigravity / Cloud Code Assist.
 *
 * PI-Desktop's provider layer only speaks standard wire protocols, but
 * Antigravity exposes `v1internal:streamGenerateContent` with a Google-specific
 * envelope. This module bridges the two: it serves OpenAI chat-completions on
 * loopback, rewrites each request into the Cloud Code Assist envelope using the
 * stored OAuth account, and translates the SSE stream back to OpenAI chunks.
 *
 * The provider row points at http://127.0.0.1:<port>/v1, so the App never talks
 * to Google directly and never needs to know the real protocol.
 */

const { createServer } = require("node:http");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const PORT = 51122;
const QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary";
const ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];
const USER_AGENT =
  "antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";
const SYSTEM_FALLBACK =
  "You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. " +
  "Be concise, practical, and tool-aware.";

// --- in-chat tools -----------------------------------------------------------
// The host's provider route only carries chat traffic, so the panel-only image
// and search features would be unreachable from a conversation. Declaring them
// as Google function declarations lets the model call them like any other tool;
// the proxy then runs them itself and feeds the result back, so the host never
// sees a tool_call it could not execute.
let chatToolsEnabled = true;

function setChatToolsEnabled(value) {
  chatToolsEnabled = value !== false;
}

function getChatToolsEnabled() {
  return chatToolsEnabled;
}

// --- credential store (same shape as the sign-in flow) ---------------------

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * Same egress story as the sign-in flow: Node's fetch ignores the macOS system
 * proxy, so on a machine that reaches the internet through a local proxy every
 * direct Google call dies with a connect timeout. Resolve a loopback proxy once
 * and reuse an Undici ProxyAgent for all upstream traffic.
 */
const PROXY_PORTS = [7897, 7890, 1087, 1080, 8080, 8118];
let cachedProxy;
let proxyProbed = false;

function envProxy() {
  const raw =
    process.env.ANTIGRAVITY_HTTPS_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ANTIGRAVITY_HTTP_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

async function detectLoopbackProxy() {
  if (proxyProbed) return cachedProxy;
  proxyProbed = true;
  const net = require("node:net");
  for (const port of PROXY_PORTS) {
    const reachable = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const done = (ok) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(400);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
    if (reachable) {
      cachedProxy = `http://127.0.0.1:${port}`;
      return cachedProxy;
    }
  }
  return undefined;
}

async function resolveProxy() {
  return envProxy() || (await detectLoopbackProxy());
}

let dispatcherInstalled = false;

/**
 * Route every upstream call through the resolved proxy by installing a global
 * dispatcher once. This mirrors what the agent sidecar does with the host's
 * proxy config, and it is the only form that survives Clash's connection
 * handling here (per-request dispatchers get reset).
 */
async function installProxyDispatcher() {
  if (dispatcherInstalled) return;
  const proxyUrl = await resolveProxy();
  if (!proxyUrl) return;
  const undici = require("undici");
  undici.setGlobalDispatcher(new undici.ProxyAgent(proxyUrl));
  dispatcherInstalled = true;
}

/** fetch that honours the resolved proxy. */
async function httpFetch(url, options) {
  await installProxyDispatcher();
  return fetch(url, options);
}

function readJsonObject(path) {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function loadAccountStore() {
  const raw = readJsonObject(join(agentDir(), "antigravity-accounts.json"));
  if (!raw || raw.version !== 1 || !raw.accounts || typeof raw.accounts !== "object") {
    return { version: 1, accounts: {} };
  }
  const accounts = {};
  for (const [key, value] of Object.entries(raw.accounts)) {
    if (!value || typeof value !== "object" || typeof value.refresh !== "string" || !value.refresh) continue;
    const id = typeof value.accountId === "string" && value.accountId.trim() ? value.accountId : key;
    accounts[id] = { ...value, accountId: id };
  }
  const activeId =
    typeof raw.activeAccountId === "string" && accounts[raw.activeAccountId] ? raw.activeAccountId : undefined;
  return { version: 1, activeAccountId: activeId, accounts };
}

function activeAccount() {
  const store = loadAccountStore();
  if (store.activeAccountId && store.accounts[store.activeAccountId]) return store.accounts[store.activeAccountId];
  const list = Object.values(store.accounts).sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
  return list[0];
}

function stableProjectId(seed) {
  const bytes = createHash("sha1").update(`antigravity:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const CLIENT_ID = Buffer.from(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" +
    "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
  "base64",
).toString("utf8");
const CLIENT_SECRET = Buffer.from("R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=", "base64").toString("utf8");
// oauth2.googleapis.com is REJECTed on some networks (notably behind Clash rules)
// while www.googleapis.com/oauth2/v4/token serves the same grant types, so try the
// reachable one first.
const TOKEN_URLS = [
  "https://www.googleapis.com/oauth2/v4/token",
  "https://oauth2.googleapis.com/token",
];

/** Refresh the access token when it is close to expiry. */
async function ensureFreshToken(account) {
  if (account.access && account.expires > Date.now() + 5 * 60 * 1000) {
    return { token: account.access, account };
  }
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: account.refresh,
    grant_type: "refresh_token",
  }).toString();

  let res;
  let lastStatus;
  for (const url of TOKEN_URLS) {
    try {
      res = await httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      });
      if (res.ok) break;
      lastStatus = res.status;
      res = undefined;
    } catch {
      // this endpoint is unreachable; try the next one
    }
  }
  if (!res) {
    throw new Error(`Antigravity token refresh failed${lastStatus ? ` (${lastStatus})` : ""}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("Antigravity token refresh returned no access token");
  return {
    token: data.access_token,
    account: {
      ...account,
      access: data.access_token,
      expires: Date.now() + (data.expires_in ?? 3600) * 1000 - 5 * 60 * 1000,
    },
  };
}

// Friendly model id -> Cloud Code Assist runtime id, per thinking effort.
// Mirrors ANTIGRAVITY_ROUTING in the pi-antigravity extension.
/**
 * Live model catalog.
 *
 * Seeded from the manifest's static list, then replaced wholesale by
 * /v1/models:refresh, which calls Antigravity's own fetchAvailableModels. This
 * mirrors buildAntigravityCatalog from the pi-antigravity extension: the
 * server's "Recommended" sort is authoritative, thinking suffixes collapse into
 * one public model with per-effort routing, and image models are excluded.
 */
let MODEL_CATALOG = [
  { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", context_window: 1048576, max_tokens: 65536 },
  { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", context_window: 1048576, max_tokens: 65536 },
  { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", context_window: 1048576, max_tokens: 65536 },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", context_window: 1048576, max_tokens: 65536 },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", context_window: 1048576, max_tokens: 65536 },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", context_window: 1048576, max_tokens: 65536 },
  { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)", context_window: 200000, max_tokens: 64000 },
  { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)", context_window: 200000, max_tokens: 64000 },
  { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)", context_window: 200000, max_tokens: 64000 },
  { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)", context_window: 200000, max_tokens: 64000 },
  { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)", context_window: 200000, max_tokens: 64000 },
  { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", context_window: 200000, max_tokens: 64000 },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", context_window: 128000, max_tokens: 32768 },
];
// publicId -> runtimeId per thinking effort (identity until discovery refines it)
let MODEL_ROUTING = {};
for (const m of MODEL_CATALOG) {
  MODEL_ROUTING[m.id] = { off: m.id, minimal: m.id, low: m.id, medium: m.id, high: m.id, xhigh: m.id };
}

const THINKING_SUFFIXES = [
  { suffix: "extra-low", level: "minimal" },
  { suffix: "extra-high", level: "xhigh" },
  { suffix: "minimal", level: "minimal" },
  { suffix: "low", level: "low" },
  { suffix: "medium", level: "medium" },
  { suffix: "high", level: "high" },
  { suffix: "xhigh", level: "xhigh" },
];

function modelDisplayName(info) {
  if (!info || typeof info !== "object") return undefined;
  for (const key of ["displayName", "label", "modelName"]) {
    if (typeof info[key] === "string" && info[key]) return info[key];
  }
  return undefined;
}

function isSelectableRuntimeModel(id, info) {
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(id) || /^MODEL_/i.test(id)) return false;
  if (/^(chat_|tab_)/i.test(id)) return false;
  if (/image/i.test(id) || /image/i.test(modelDisplayName(info) ?? "")) return false;
  if (info?.isInternal === true || info?.apiProvider === "API_PROVIDER_INTERNAL") return false;
  return true;
}

function parseThinkingSuffix(runtimeId) {
  const lower = runtimeId.toLowerCase();
  for (const { suffix, level } of THINKING_SUFFIXES) {
    if (lower.endsWith("-" + suffix)) return { baseId: runtimeId.slice(0, -(suffix.length + 1)), level };
  }
  return undefined;
}

function levelFromDisplayName(displayName) {
  if (!displayName) return undefined;
  const m = /\((extra\s*low|extra\s*high|low|medium|high|minimal|thinking)\)\s*$/i.exec(displayName);
  if (!m) return undefined;
  const raw = m[1].toLowerCase().replace(/\s+/g, "-");
  const found = THINKING_SUFFIXES.find((s) => s.suffix === raw);
  return found?.level;
}

function recommendedIdsFrom(agentModelSorts) {
  if (!Array.isArray(agentModelSorts) || agentModelSorts.length === 0) return undefined;
  const ids = new Set();
  for (const sort of agentModelSorts) {
    const groups = Array.isArray(sort?.groups) ? sort.groups : [];
    for (const g of groups) {
      const list = Array.isArray(g?.modelIds) ? g.modelIds : [];
      for (const id of list) if (typeof id === "string") ids.add(id);
    }
  }
  return ids.size ? ids : undefined;
}

function positiveInt(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

/**
 * Collapse the raw runtime catalog into public models + routing.
 * Returns null when nothing usable came back, so callers keep the old catalog.
 */
function buildCatalog(rawModels, agentModelSorts) {
  const recommended = recommendedIdsFrom(agentModelSorts);

  const collect = (filterIds) => {
    const groups = new Map();
    const ensure = (publicId) => {
      if (!groups.has(publicId)) groups.set(publicId, { publicId, variants: {}, displayNames: [] });
      return groups.get(publicId);
    };
    for (const [runtimeId, info] of Object.entries(rawModels || {})) {
      if (!isSelectableRuntimeModel(runtimeId, info)) continue;
      if (filterIds && !filterIds.has(runtimeId)) continue;
      const displayName = modelDisplayName(info);
      if (runtimeId.endsWith("-tiered")) {
        const g = ensure(runtimeId.slice(0, "-tiered".length));
        if (displayName) g.displayNames.push(displayName);
        const cw = positiveInt(info?.maxTokens);
        const mo = positiveInt(info?.maxOutputTokens);
        if (cw !== undefined) g.contextWindow = Math.min(g.contextWindow ?? cw, cw);
        if (mo !== undefined) g.maxTokens = Math.min(g.maxTokens ?? mo, mo);
        continue;
      }
      const suffix = parseThinkingSuffix(runtimeId);
      const publicId = suffix?.baseId ?? runtimeId;
      const g = ensure(publicId);
      if (displayName) g.displayNames.push(displayName);
      const cw = positiveInt(info?.maxTokens);
      const mo = positiveInt(info?.maxOutputTokens);
      if (cw !== undefined) g.contextWindow = Math.min(g.contextWindow ?? cw, cw);
      if (mo !== undefined) g.maxTokens = Math.min(g.maxTokens ?? mo, mo);
      const level = levelFromDisplayName(displayName) ?? suffix?.level;
      if (level) g.variants[level] = runtimeId;
      else g.unsuffixed = runtimeId;
    }
    return groups;
  };

  let groups = collect(recommended);
  if (groups.size === 0 && recommended) groups = collect();
  if (groups.size === 0) return null;

  const models = [];
  const routing = {};
  for (const g of groups.values()) {
    const variants = g.variants;
    const anyId = g.unsuffixed ?? variants.low ?? variants.medium ?? variants.high ?? Object.values(variants)[0];
    if (!anyId) continue;
    const contextWindow = g.contextWindow ?? 1048576;
    const maxTokens = g.maxTokens ?? 65536;
    const name =
      (g.displayNames[0] || g.publicId)
        .replace(/\s*\((?:extra\s*low|extra\s*high|low|medium|high|minimal|thinking)\)\s*$/i, "")
        .trim() || g.publicId;
    models.push({ id: g.publicId, name, context_window: contextWindow, max_tokens: maxTokens });
    routing[g.publicId] = {
      off: variants.low ?? variants.medium ?? variants.high ?? anyId,
      minimal: variants.minimal ?? variants.low ?? anyId,
      low: variants.low ?? anyId,
      medium: variants.medium ?? variants.low ?? anyId,
      high: variants.high ?? variants.medium ?? anyId,
      xhigh: variants.xhigh ?? variants.high ?? anyId,
    };
  }
  if (!models.length) return null;
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models, routing };
}

function resolveRuntimeModel(modelId, reasoningEffort) {
  const route = MODEL_ROUTING[modelId];
  if (!route) return modelId;
  const effort = reasoningEffort || "off";
  return route[effort] ?? route.low ?? route.off ?? modelId;
}

// --- tool schema sanitisation ------------------------------------------------
// Cloud Code Assist rejects JSON Schema metadata it does not know ("Unknown name
// \"const\"", 400). Mirrors stripMetaSchema/normalizeCustomToolSchema from the
// pi-antigravity extension: strip meta keywords everywhere, and for the
// Claude/GPT custom-tool bridge keep only a small allowlist.

const META_SCHEMA_KEYWORDS = new Set([
  "$schema", "$id", "$anchor", "$dynamicAnchor", "$vocabulary", "$comment", "$defs", "definitions",
]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "dependentSchemas", "dependencies"]);
const SCHEMA_VALUE_KEYWORDS = new Set([
  "additionalItems", "additionalProperties", "contains", "contentSchema", "else", "if", "items",
  "not", "propertyNames", "then", "unevaluatedItems", "unevaluatedProperties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const CUSTOM_TOOL_SCHEMA_ALLOW = new Set(["type", "description", "properties", "required", "items", "enum"]);

function stripMetaSchemaMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return stripMetaSchema(value);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripMetaSchema(v)]));
}

function stripMetaSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(stripMetaSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (META_SCHEMA_KEYWORDS.has(key)) continue;
    if (SCHEMA_MAP_KEYWORDS.has(key)) out[key] = stripMetaSchemaMap(value);
    else if (SCHEMA_VALUE_KEYWORDS.has(key) || SCHEMA_ARRAY_KEYWORDS.has(key)) out[key] = stripMetaSchema(value);
    else out[key] = value;
  }
  return out;
}

function normalizeCustomToolType(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const scalar = value.find((entry) => typeof entry === "string" && entry !== "null");
  return scalar;
}

function normalizeCustomToolSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) continue;
    if (key === "type") {
      const t = normalizeCustomToolType(value);
      if (t !== undefined) out.type = t;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props = {};
      for (const [name, sub] of Object.entries(value)) props[name] = normalizeCustomToolSchema(sub);
      out.properties = props;
      continue;
    }
    if (key === "enum" && Array.isArray(value) && !value.every((e) => typeof e === "string")) continue;
    out[key] = normalizeCustomToolSchema(value);
  }
  return out;
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const value = match?.[1]?.trim();
  return value || undefined;
}

// --- OpenAI -> Cloud Code Assist -------------------------------------------

function toInt64SessionId() {
  return BigInt.asIntN(64, BigInt("0x" + randomBytes(8).toString("hex"))).toString();
}

function openAiMessagesToContents(messages) {
  const contents = [];
  for (const message of messages ?? []) {
    const role = message.role === "assistant" ? "model" : "user";
    const parts = [];
    if (typeof message.content === "string") {
      if (message.content) parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text" && part.text) parts.push({ text: part.text });
      }
    }
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        parts.push({
          functionCall: {
            name: call.function?.name ?? "tool",
            args: safeJsonParse(call.function?.arguments) ?? {},
          },
        });
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  // Cloud Code Assist rejects a trailing model turn.
  while (contents.length && contents[contents.length - 1].role === "model") contents.pop();
  return contents;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function buildGoogleBody(openAiRequest, projectId, options = {}) {
  const messages = openAiRequest.messages ?? [];
  const systemMessages = messages.filter((m) => m.role === "system" || m.role === "developer");
  const conversational = messages.filter((m) => m.role !== "system" && m.role !== "developer");

  const systemText =
    systemMessages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n\n").trim() ||
    SYSTEM_FALLBACK;

  const contents = openAiMessagesToContents(conversational);
  if (!contents.length) contents.push({ role: "user", parts: [{ text: "Continue." }] });

  const requested = String(openAiRequest.model ?? "gemini-3.8-flash");
  const model = resolveRuntimeModel(requested, openAiRequest.reasoning_effort);
  const isClaude = requested.startsWith("claude-");
  const isNonGemini = isClaude || requested.startsWith("gpt-oss-") || !requested.startsWith("gemini-");

  const generationConfig = {};
  if (typeof openAiRequest.temperature === "number") generationConfig.temperature = openAiRequest.temperature;
  if (typeof openAiRequest.top_p === "number") generationConfig.topP = openAiRequest.top_p;
  generationConfig.maxOutputTokens =
    typeof openAiRequest.max_tokens === "number" ? openAiRequest.max_tokens : 8192;

  const step = Math.max(1, contents.length);
  const trajectoryId = randomUUID();
  const requestIndex = Math.max(0, messages.filter((m) => m.role === "assistant").length);

  const labels = {
    last_step_index: String(step - 1),
    request_id: `${trajectoryId}-${requestIndex}`,
    trajectory_id: trajectoryId,
    used_claude: isClaude ? "true" : "false",
    used_claude_conservative: isClaude ? "true" : "false",
    used_non_gemini_model: isNonGemini ? "true" : "false",
  };
  if (step > 1) labels.last_execution_id = randomUUID();

  const body = {
    project: projectId,
    model,
    request: {
      contents,
      systemInstruction: { role: "user", parts: [{ text: systemText }] },
      generationConfig,
      sessionId: toInt64SessionId(),
      labels,
    },
    requestType: "AGENT",
    userAgent: "ANTIGRAVITY",
    requestId: `agent/${randomUUID()}/${Date.now()}/${trajectoryId}/${step}`,
  };

  const declarations = [];
  if (Array.isArray(openAiRequest.tools) && openAiRequest.tools.length) {
    for (const tool of openAiRequest.tools) {
      const fn = tool.function ?? tool;
      if (!fn?.name) continue;
      const root = fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} };
      const cleaned = stripMetaSchema(root);
      if (isClaude || requested.startsWith("gpt-oss-")) {
        // Claude / GPT-OSS go through the custom-tool bridge: allowlisted subset only.
        declarations.push({
          name: fn.name,
          description: fn.description ?? "",
          parameters: normalizeCustomToolSchema(cleaned),
        });
      } else {
        // Gemini accepts full JSON Schema through parametersJsonSchema.
        declarations.push({
          name: fn.name,
          description: fn.description ?? "",
          parametersJsonSchema: cleaned,
        });
      }
    }
  }
  // In-chat image/search tools ride alongside whatever the host declared, so the
  // model can reach them in the same turn as its own tools.
  if (options.includeInternalTools !== false && chatToolsEnabled) {
    for (const tool of INTERNAL_TOOLS) {
      if (isClaude || requested.startsWith("gpt-oss-")) {
        declarations.push({
          name: tool.name,
          description: tool.description,
          parameters: normalizeCustomToolSchema(tool.parameters),
        });
      } else {
        declarations.push({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: stripMetaSchema(tool.parameters),
        });
      }
    }
  }
  if (declarations.length) body.request.tools = [{ functionDeclarations: declarations }];

  return body;
}

// --- image generation --------------------------------------------------------
// Mirrors buildImageGenerateRequest from the pi-antigravity extension. The host
// calls /v1/images/generations on this proxy (openAIImagesAdapter), so the
// Antigravity image endpoint is translated here.
const IMAGE_MODEL = "gemini-3.1-flash-image";
const IMAGE_ASPECT_RATIOS = ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

function imageExtension(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function buildGoogleImageRequest(prompt, model, projectId, aspectRatio, inputImages) {
  return {
    project: projectId,
    model,
    request: {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }, ...(inputImages || []).map((img) => ({ inlineData: img }))],
        },
      ],
      generationConfig: {
        imageConfig: aspectRatio && aspectRatio !== "auto" ? { aspectRatio } : {},
        candidateCount: 1,
      },
    },
    requestType: "IMAGE_GEN",
    userAgent: "ANTIGRAVITY",
    requestId: `image_gen/${Date.now()}/${randomUUID()}/1`,
  };
}

/** Collect inlineData parts out of a (possibly streamed) Gemini response. */
function collectImages(data) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.inlineData && typeof node.inlineData.data === "string") {
      out.push({
        data: node.inlineData.data,
        mimeType: node.inlineData.mimeType || "image/png",
      });
    }
    for (const key of ["parts", "candidates", "content", "response"]) visit(node[key]);
  };
  visit(data);
  return out;
}

// --- in-chat tool implementations -------------------------------------------

const INTERNAL_TOOLS = [
  {
    name: "antigravity_generate_image",
    description:
      "Generate an image with Google's image model and show it inline in the conversation. " +
      "Use it whenever the user asks to draw, render, create, illustrate or visualise something. " +
      "Do not use it for content that is better expressed as text, code or a table. " +
      "Generate one image per request, then describe it; do not generate variations unless asked.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed image prompt: subject, style, composition, lighting, colours.",
        },
        aspect_ratio: {
          type: "string",
          description: "Optional aspect ratio.",
          enum: ["auto", "1:1", "3:4", "4:3", "9:16", "16:9", "21:9"],
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "antigravity_web_search",
    description:
      "Search the live web with Google Search grounding and return a grounded brief with sources. " +
      "Use it for anything that needs current, factual or post-training-cutoff information, " +
      "or when the user explicitly asks to search the web. " +
      "Search once per question, then answer the user from the results; never repeat a search.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query, in the language most likely to return good results.",
        },
        urls: {
          type: "array",
          items: { type: "string" },
          description: "Optional specific URLs to read in detail.",
        },
      },
      required: ["query"],
    },
  },
];
/**
 * Same conversation, but with the in-chat tools withdrawn and their results
 * folded into plain text. Two reasons: the endpoint refuses a functionCall
 * without its thoughtSignature, and a model that keeps re-calling the same tool
 * would otherwise burn the whole round budget without ever answering.
 *
 * `internalFrom` is the contents length before this proxy appended its first
 * tool exchange, so only those turns are replaced and the host's own tool
 * history survives untouched.
 */
function bodyWithoutInternalTools(request, projectId, bodyObj, internalFrom, summaries) {
  const fresh = buildGoogleBody(request, projectId, { includeInternalTools: false });
  const kept = bodyObj.request.contents.slice(0, internalFrom);
  fresh.request.contents = kept;
  if (summaries?.length) {
    fresh.request.contents.push({
      role: "user",
      parts: [
        {
          text:
            "Results from the tools you already ran:\n\n" +
            summaries.join("\n\n") +
            "\n\nAnswer the user now, in your own words, citing sources as [n] where relevant. " +
            "Do not call any more tools.",
        },
      ],
    });
  }
  return fresh;
}
const INTERNAL_TOOL_NAMES = new Set(INTERNAL_TOOLS.map((tool) => tool.name));

/** Every tool call this proxy runs itself instead of handing back to the host. */
function isSelfExecutedTool(name) {
  if (!chatToolsEnabled) return false;
  return INTERNAL_TOOL_NAMES.has(name) || INTERCEPTED_HOST_TOOLS.has(name);
}

/**
 * Tools the *host* declares that this proxy executes itself.
 *
 * The app ships a built-in `GenerateImages` tool, and the model reaches for it
 * far more readily than for anything a provider invents. Its own implementation
 * is a dead end for this provider though: `imageModelOfferedByProvider` rejects
 * every oauth provider that is not the OpenAI Codex vendor, so the call always
 * comes back IMAGE_NOT_CONFIGURED and the model just tells the user to go and
 * configure an image model. Intercepting the call and running it against
 * Antigravity instead is the only way in-chat image generation works at all.
 */
const INTERCEPTED_HOST_TOOLS = new Set(["GenerateImages"]);

function isInterceptedHostTool(name) {
  return chatToolsEnabled && INTERCEPTED_HOST_TOOLS.has(name);
}

/** POST one Cloud Code Assist envelope and hand back the parsed JSON. */
async function googlePost(token, path, body, timeoutMs = 120000) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      const candidate = await httpFetch(`${endpoint}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await candidate.text();
      if (candidate.ok) return { ok: true, status: candidate.status, data: safeJsonParse(text) ?? {} };
      lastError = `HTTP ${candidate.status}: ${text.slice(0, 200)}`;
    } catch (error) {
      lastError = error.cause?.code || error.message;
    }
  }
  throw new Error(String(lastError || "upstream request failed").slice(0, 300));
}

const MAX_INLINE_IMAGE_B64 = 6 * 1024 * 1024;

function imageDataUri(image) {
  return `data:${image.mimeType};base64,${image.data}`;
}

function markdownImage(image, prompt) {
  const alt = String(prompt || "generated image").replace(/[[\]]/g, "").slice(0, 120);
  return `![${alt}](${imageDataUri(image)})`;
}

/**
 * Run one in-chat tool. Returns the functionResponse payload plus, for images,
 * the markdown the caller appends to the answer so the user actually sees it.
 */
async function executeInternalTool(name, args, ctx) {
  if (INTERCEPTED_HOST_TOOLS.has(name)) return await executeHostGenerateImages(args, ctx);
  if (name === "antigravity_generate_image") {
    const prompt = String(args?.prompt ?? "").trim();
    if (!prompt) return { response: { ok: false, error: "prompt is required" }, images: [] };
    const ratio = String(args?.aspect_ratio ?? "auto");
    if (ratio !== "auto" && !IMAGE_ASPECT_RATIOS.includes(ratio)) {
      return { response: { ok: false, error: `unsupported aspect_ratio ${ratio}` }, images: [] };
    }
    return await generateOneImage(prompt, ratio, ctx);
  }

  if (name === "antigravity_web_search") {
    return await executeWebSearchTool(args, ctx);
  }

  return { response: { ok: false, error: `unknown tool ${name}` }, images: [] };
}

/** One Antigravity image call, wrapped as a tool result the model can read. */
async function generateOneImage(prompt, ratio, ctx) {
  let images = [];
  let failure;
  try {
    const upstream = await googlePost(
      ctx.token,
      "/v1internal:generateContent",
      buildGoogleImageRequest(prompt, IMAGE_MODEL, ctx.projectId, ratio, []),
    );
    images = collectImages(upstream.data);
  } catch (error) {
    failure = error.message;
  }
  if (!images.length) {
    return { response: { ok: false, error: failure || "no image returned" }, images: [] };
  }
  const image = images[0];
  let markdown = "";
  if (image.data.length > MAX_INLINE_IMAGE_B64) {
    // A multi-megabyte data URI would bloat the message beyond what the host
    // stores comfortably, so fall back to a file the user can open.
    try {
      const dir = join(agentDir(), "antigravity-images");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${imageExtension(image.mimeType)}`);
      writeFileSync(file, Buffer.from(image.data, "base64"));
      markdown = `_Image too large to embed inline (${(image.data.length / 1048576).toFixed(1)} MB); saved to ${file}._`;
    } catch {
      markdown = "_Image was generated but is too large to embed inline._";
    }
  } else {
    markdown = markdownImage(image, prompt);
  }
  return {
    response: {
      ok: true,
      mime_type: image.mimeType,
      images: images.length,
      note:
        "The image has been rendered inline for the user. Describe it briefly; " +
        "never paste base64 or a data URI into your reply.",
    },
    images,
    markdown,
    summary: `Image generated for "${prompt}" and shown to the user inline.`,
  };
}

/**
 * The host's own `GenerateImages` tool, executed against Antigravity.
 *
 * Its arguments are `{items: [{prompt, count, images?}]}`, and the host expects a
 * `generated-images` result with one entry per requested image. Replying in that
 * shape keeps the host's transcript rendering working even though the pixels
 * never left this process.
 */
async function executeHostGenerateImages(args, ctx) {
  const items = Array.isArray(args?.items) ? args.items : [];
  const prompts = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const prompt = String(item.prompt ?? "").trim();
    if (prompt) prompts.push(prompt);
  }
  if (!prompts.length) {
    return { response: { ok: false, error: "items[].prompt is required" }, images: [] };
  }
  const results = [];
  const markdowns = [];
  const summaries = [];
  const images = [];
  const failures = [];
  for (const prompt of prompts) {
    // The host allows a repeated identical prompt, but re-running it only burns
    // quota, so serve the second attempt from the first result.
    const key = prompt.toLowerCase();
    if (ctx.seenPrompts?.has(key)) {
      results.push({ status: "succeeded", prompt, cached: true });
      continue;
    }
    ctx.seenPrompts?.add(key);
    const outcome = await generateOneImage(prompt, "auto", ctx);
    if (outcome.response?.ok) {
      results.push({ status: "succeeded", prompt, mimeType: outcome.response.mime_type });
      if (outcome.markdown) markdowns.push(outcome.markdown);
      if (outcome.summary) summaries.push(outcome.summary);
      images.push(...(outcome.images ?? []));
    } else {
      failures.push(`${prompt.slice(0, 80)}: ${outcome.response?.error ?? "failed"}`);
      results.push({ status: "failed", prompt, error: outcome.response?.error ?? "failed" });
    }
  }
  const ok = results.some((r) => r.status === "succeeded");
  return {
    response: {
      ok,
      kind: ok ? "generated-images" : "image-generation-error",
      errorCode: ok ? undefined : "IMAGE_UPSTREAM_FAILED",
      results,
      ...(failures.length ? { failures } : {}),
      note: ok
        ? "The images are rendered inline for the user. Describe them briefly; never paste base64 or a data URI."
        : "Image generation failed upstream. Say so plainly; do not retry the same prompt.",
    },
    images,
    markdown: markdowns.join("\n\n"),
    summary: summaries.join("\n"),
  };
}

async function executeWebSearchTool(args, ctx) {
    const query = String(args?.query ?? "").trim();
    if (!query) return { response: { ok: false, error: "query is required" }, sources: [] };
    // A model that keeps re-searching the same thing would burn the round
    // budget without ever answering, so short-circuit the repeat and push it
    // back to the results it already has.
    const key = query.toLowerCase();
    if (ctx.seenQueries?.has(key)) {
      return {
        response: {
          ok: true,
          cached: true,
          note: "You already ran this exact search. Use the previous results and answer the user now.",
        },
        sources: [],
      };
    }
    ctx.seenQueries?.add(key);
    const urls = Array.isArray(args?.urls)
      ? args.urls.filter((u) => typeof u === "string" && u.trim())
      : [];
    let parsed;
    try {
      const upstream = await googlePost(
        ctx.token,
        "/v1internal:generateContent",
        buildGoogleSearchRequest(
          { query, urls, systemInstruction: CHAT_SEARCH_SYSTEM_INSTRUCTION },
          SEARCH_MODEL,
          ctx.projectId,
        ),
      );
      parsed = parseGoogleSearch(upstream.data);
    } catch (error) {
      return { response: { ok: false, error: error.message }, sources: [] };
    }
    const sources = parsed.sources.slice(0, 10);
    const summary =
      `Search: ${query}\n` +
      `${parsed.text || "(no text returned)"}\n` +
      (sources.length ? `Sources:\n${sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n")}` : "");
    return {
      response: {
        ok: true,
        answer: parsed.text,
        sources: sources.map((source, index) => ({ n: index + 1, title: source.title, url: source.url })),
        note:
          "This is the complete result. Do not search again: answer the user now and cite the sources as [n].",
      },
      sources: parsed.sources,
      summary,
      // Models often drop the source list they were given, so keep a copy to
      // append when the answer itself carries no links.
      footer: sources.length
        ? `Sources:\n${sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n")}`
        : "",
    };
}


/** Append one model functionCall + user functionResponse pair to the request. */
function pushToolExchange(bodyObj, call, result, thoughtSignature) {
  const args = call.args && typeof call.args === "object" ? call.args : {};
  const parts = [{ functionResponse: { name: call.name, response: result.response } }];
  // Handing the pixels back lets the model talk about what it produced.
  for (const image of result.images ?? []) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  }
  // thoughtSignature is a property of the part, and the endpoint refuses a
  // functionCall that comes back without the one it was issued with.
  const modelPart = { functionCall: { name: call.name, args } };
  if (typeof thoughtSignature === "string" && thoughtSignature) {
    modelPart.thoughtSignature = thoughtSignature;
  }
  bodyObj.request.contents.push({ role: "model", parts: [modelPart] });
  bodyObj.request.contents.push({ role: "user", parts });
}

/** Retry helper: some runtimes reject images inside a function response. */
function stripInlineImages(bodyObj, from) {
  for (let i = from; i < bodyObj.request.contents.length; i++) {
    const parts = bodyObj.request.contents[i]?.parts;
    if (Array.isArray(parts)) {
      bodyObj.request.contents[i].parts = parts.filter((part) => !part.inlineData);
    }
  }
}

// --- Cloud Code Assist -> OpenAI -------------------------------------------

function openAiChunk(id, created, model, delta, finishReason) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  };
}

function mapFinishReason(reason, hasToolCall) {
  if (hasToolCall) return "tool_calls";
  if (reason === "MAX_TOKENS") return "length";
  return "stop";
}

/**
 * Fetch the account's quota groups. Mirrors parseQuotaSummary from the
 * pi-antigravity extension so the panel shows the same buckets the extension
 * reports.
 */
async function fetchQuota(token) {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await httpFetch(`${endpoint}${QUOTA_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return await res.json();
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error.cause?.code || error.message;
    }
  }
  throw new Error(`Quota request failed${lastError ? `: ${lastError}` : ""}`);
}

function parseQuota(data) {
  const summary = data && typeof data === "object" ? data : {};
  const groups = [];
  for (const group of summary.groups || []) {
    const buckets = [];
    for (const bucket of group.buckets || []) {
      const remaining = typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : undefined;
      if (remaining === undefined && !bucket.bucketId) continue;
      buckets.push({
        bucketId: String(bucket.bucketId || bucket.displayName || "unknown"),
        displayName: String(bucket.displayName || bucket.bucketId || "Limit"),
        window: bucket.window ? String(bucket.window) : undefined,
        resetTime: bucket.resetTime ? String(bucket.resetTime) : undefined,
        description: bucket.description ? String(bucket.description) : undefined,
        remainingFraction: remaining ?? 0,
      });
    }
    if (!buckets.length && !group.displayName) continue;
    groups.push({
      displayName: String(group.displayName || "Quota group"),
      description: group.description ? String(group.description) : undefined,
      buckets,
    });
  }
  return { groups, description: summary.description ? String(summary.description) : undefined };
}

/**
 * OpenAI images/generations -> Antigravity image generation.
 *
 * The host sends {model, prompt, n} and expects {data:[{b64_json|url}]}. Antigravity
 * only returns inlineData, so b64_json is what we hand back.
 */
async function handleImageGenerations(req, res, request) {
  const prompt = String(request.prompt ?? "").trim();
  if (!prompt) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "prompt is required", type: "invalid_request_error" } }));
    return;
  }

  const clientToken = bearerToken(req);
  let token;
  let projectId;
  if (clientToken) {
    token = clientToken;
    const account = activeAccount();
    projectId = account?.projectId || stableProjectId(account?.email || "antigravity-default");
  } else {
    const account = activeAccount();
    if (!account) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Antigravity is not signed in.", type: "authentication_error" } }));
      return;
    }
    try {
      const fresh = await ensureFreshToken(account);
      token = fresh.token;
      projectId = fresh.account.projectId || stableProjectId(fresh.account.email || "antigravity-default");
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message, type: "upstream_error" } }));
      return;
    }
  }

  // The host may send edits as multipart; that path carries input images we cannot
  // reconstruct from JSON, so reject it rather than silently dropping them.
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.includes("multipart/form-data")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "Image editing (input images) is not supported by this provider.", type: "invalid_request_error" },
      }),
    );
    return;
  }

  const model = String(request.model || IMAGE_MODEL);
  const ratio = String(request.size || request.aspect_ratio || "auto");
  if (ratio !== "auto" && !IMAGE_ASPECT_RATIOS.includes(ratio)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Unsupported aspect ratio: ${ratio}`, type: "invalid_request_error" } }));
    return;
  }

  const body = JSON.stringify(buildGoogleImageRequest(prompt, model, projectId, ratio, []));
  let upstream;
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      const candidate = await httpFetch(`${endpoint}/v1internal:generateContent`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(120000),
      });
      if (candidate.ok) {
        upstream = candidate;
        break;
      }
      lastError = `HTTP ${candidate.status}`;
    } catch (error) {
      lastError = error.cause?.code || error.message;
    }
  }
  if (!upstream) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Antigravity image request failed${lastError ? `: ${lastError}` : ""}`, type: "upstream_error" } }));
    return;
  }

  const data = await upstream.json();
  const images = collectImages(data);
  if (!images.length) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Antigravity returned no image data.", type: "upstream_error" } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: images.map((img) => ({
        b64_json: img.data,
        mime_type: img.mimeType,
        revised_prompt: prompt,
      })),
    }),
  );
}

const MAX_TOOL_ROUNDS = 3;

/** One streaming Cloud Code Assist call; throws when every endpoint failed. */
async function callUpstream(token, bodyObj) {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      const candidate = await httpFetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(bodyObj),
        signal: AbortSignal.timeout(120000),
      });
      if (candidate.ok) return candidate;
      // Retryable statuses fall through to the next endpoint; anything else is a
      // definitive answer from this endpoint.
      if ([401, 403, 429, 500, 502, 503, 504].includes(candidate.status)) {
        lastError = await candidate.text();
        continue;
      }
      lastError = await candidate.text();
      break;
    } catch (error) {
      lastError = `${error.message}${error.cause?.code ? ` (${error.cause.code})` : ""}`;
    }
  }
  throw new Error(String(lastError).slice(0, 300) || "upstream request failed");
}

async function handleChatCompletions(req, res, bodyText) {
  const request = safeJsonParse(bodyText);
  if (!request) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }));
    return;
  }

  // The host owns the credential for this provider and refreshes it itself, so
  // prefer whatever token it sends. The local account store is only a fallback
  // for hosts that do not attach one.
  const clientToken = bearerToken(req);
  let token;
  let projectId;

  if (clientToken) {
    token = clientToken;
    const account = activeAccount();
    projectId = account?.projectId || stableProjectId(account?.email || "antigravity-default");
  } else {
    const account = activeAccount();
    if (!account) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Antigravity is not signed in. Open the Antigravity panel and sign in first.",
            type: "authentication_error",
          },
        }),
      );
      return;
    }
    let fresh;
    try {
      fresh = await ensureFreshToken(account);
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message, type: "upstream_error" } }));
      return;
    }
    token = fresh.token;
    projectId = fresh.account.projectId || stableProjectId(fresh.account.email || "antigravity-default");
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);
  const model = String(request.model ?? "gemini-3.8-flash");

  let bodyObj = buildGoogleBody(request, projectId, { includeInternalTools: true });
  let upstream;
  let lastError;
  try {
    upstream = await callUpstream(token, bodyObj);
  } catch (error) {
    lastError = error.message;
    // A runtime that rejects the extra declarations must not take the whole
    // conversation down, so retry once with only the host's own tools. The
    // rebuild keeps them, which is why this is safe even in agent mode.
    if (chatToolsEnabled) {
      try {
        bodyObj = buildGoogleBody(request, projectId, { includeInternalTools: false });
        upstream = await callUpstream(token, bodyObj);
      } catch (retryError) {
        lastError = retryError.message;
      }
    }
  }

  if (!upstream) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: `Antigravity upstream failed: ${String(lastError).slice(0, 300)}`, type: "upstream_error" },
      }),
    );
    return;
  }

  const wantsStream = request.stream === true;

  /**
   * Stream one round. In-chat tool calls are buffered instead of forwarded: the
   * host has no implementation for them, and this proxy runs them itself.
   * Returns the buffered calls plus the finish reason, which the caller emits
   * only once no further round is needed.
   */
  const streamRound = async (up) => {
    const internalCalls = [];
    let sawToolCall = false;
    let finish;
    let text = "";
    let toolIndex = 0;
    for await (const chunk of parseGoogleSse(up.body)) {
      const candidate = chunk.response?.candidates?.[0] ?? chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.thought === true) continue; // reasoning is not part of OpenAI content
        if (typeof part.text === "string" && part.text) {
          text += part.text;
          res.write(`data: ${JSON.stringify(openAiChunk(id, created, model, { content: part.text }))}\n\n`);
          continue;
        }
        const call = part.functionCall;
        if (call && typeof call.name === "string") {
          if (isSelfExecutedTool(call.name)) {
            internalCalls.push({ name: call.name, args: call.args ?? {}, thoughtSignature: part.thoughtSignature });
            continue;
          }
          // Google may split a call across frames; emit one OpenAI tool_call
          // delta per functionCall so the host can accumulate and execute it.
          sawToolCall = true;
          const toolCallId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
          res.write(
            `data: ${JSON.stringify(
              openAiChunk(id, created, model, {
                tool_calls: [
                  {
                    index: toolIndex++,
                    id: toolCallId,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                  },
                ],
              }),
            )}\n\n`,
          );
        }
      }
      if (candidate?.finishReason) finish = mapFinishReason(candidate.finishReason, sawToolCall);
    }
    return { internalCalls, finish, text };
  };

  if (!wantsStream) {
    let aggregated = await aggregateGoogleStream(upstream.body);
    let text = aggregated.text;
    let toolCalls = aggregated.toolCalls.filter((c) => !isSelfExecutedTool(c.function?.name));
    let usage = aggregated.usage;
    const trailing = [];
    const footers = [];
    const summaries = [];
    const seenQueries = new Set();
    const seenPrompts = new Set();
    let usedTools = false;
    let internalFrom = bodyObj.request.contents.length;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const internalCalls = aggregated.toolCalls.filter((c) => isSelfExecutedTool(c.function?.name));
      if (!internalCalls.length) break;
      usedTools = true;
      const from = bodyObj.request.contents.length;
      let sawImages = false;
      for (const call of internalCalls) {
        const args = safeJsonParse(call.function?.arguments) ?? {};
        const result = await executeInternalTool(call.function.name, args, { token, projectId, seenQueries, seenPrompts });
        pushToolExchange(bodyObj, { name: call.function.name, args }, result, aggregated.thoughtSignatures?.[call.id]);
        if (result.images?.length) sawImages = true;
        if (result.markdown) trailing.push(result.markdown);
        if (result.summary) summaries.push(result.summary);
        if (result.footer) footers.push(result.footer);
      }
      try {
        aggregated = await aggregateGoogleStream((await callUpstream(token, bodyObj)).body);
      } catch (error) {
        if (sawImages) {
          // Images inside a function response are the usual suspect; drop them
          // and ask again before giving up on the round.
          stripInlineImages(bodyObj, from);
          try {
            aggregated = await aggregateGoogleStream((await callUpstream(token, bodyObj)).body);
          } catch (retryError) {
            aggregated = { text: `_(tool call failed: ${retryError.message})_`, toolCalls: [] };
          }
        } else {
          aggregated = { text: `_(tool call failed: ${error.message})_`, toolCalls: [] };
        }
      }
      text += (text && aggregated.text ? "\n\n" : "") + aggregated.text;
      toolCalls.push(...aggregated.toolCalls.filter((c) => !isSelfExecutedTool(c.function?.name)));
      usage = aggregated.usage ?? usage;
    }
    // Same safety net as the streaming path: no answer means one more call with
    // the in-chat tools withdrawn.
    if (usedTools && !text.trim()) {
      try {
        const forced = await aggregateGoogleStream(
          (await callUpstream(token, bodyWithoutInternalTools(request, projectId, bodyObj, internalFrom, summaries))).body,
        );
        text = forced.text;
        toolCalls.push(...forced.toolCalls.filter((c) => !isSelfExecutedTool(c.function?.name)));
        usage = forced.usage ?? usage;
      } catch {
        // keep whatever the tool rounds produced
      }
    }
    for (const markdown of trailing) text += `\n\n${markdown}`;
    if (!/https?:\/\//.test(text)) {
      for (const footer of footers) text += `\n\n${footer}`;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
            finish_reason: toolCalls.length ? "tool_calls" : "stop",
          },
        ],
        usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify(openAiChunk(id, created, model, { role: "assistant" }))}\n\n`);

  const trailing = [];
  const footers = [];
  const summaries = [];
  const seenQueries = new Set();
  const seenPrompts = new Set();
  let up = upstream;
  let finish;
  let streamedText = "";
  let usedTools = false;
  const internalFrom = bodyObj.request.contents.length;
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await streamRound(up);
      finish = result.finish ?? finish;
      streamedText += result.text;
      if (!result.internalCalls.length) break;
      usedTools = true;
      const from = bodyObj.request.contents.length;
      let sawImages = false;
      for (const call of result.internalCalls) {
        const executed = await executeInternalTool(call.name, call.args ?? {}, { token, projectId, seenQueries, seenPrompts });
        pushToolExchange(bodyObj, call, executed, call.thoughtSignature);
        if (executed.images?.length) sawImages = true;
        if (executed.markdown) trailing.push(executed.markdown);
        if (executed.summary) summaries.push(executed.summary);
        if (executed.footer) footers.push(executed.footer);
      }
      try {
        up = await callUpstream(token, bodyObj);
      } catch (error) {
        if (!sawImages) throw error;
        stripInlineImages(bodyObj, from);
        up = await callUpstream(token, bodyObj);
      }
    }
    // A model that spends every round on tools leaves the user with nothing.
    // One last call with the in-chat tools withdrawn forces a real answer.
    if (usedTools && !streamedText.trim()) {
      try {
        const forced = await callUpstream(
          token,
          bodyWithoutInternalTools(request, projectId, bodyObj, internalFrom, summaries),
        );
        const forcedRound = await streamRound(forced);
        streamedText += forcedRound.text;
        finish = forcedRound.finish ?? finish;
      } catch (error) {
        res.write(
          `data: ${JSON.stringify({ error: { message: error.message, type: "upstream_error" } })}\n\n`,
        );
      }
    }
    // Images arrive after the answer so the model never has to emit them.
    for (const markdown of trailing) {
      res.write(`data: ${JSON.stringify(openAiChunk(id, created, model, { content: `\n\n${markdown}` }))}\n\n`);
    }
    // Same for search sources, but only when the answer carries no link itself.
    if (!/https?:\/\//.test(streamedText)) {
      for (const footer of footers) {
        res.write(`data: ${JSON.stringify(openAiChunk(id, created, model, { content: `\n\n${footer}` }))}\n\n`);
      }
    }
    if (finish) {
      res.write(`data: ${JSON.stringify(openAiChunk(id, created, model, {}, finish))}\n\n`);
    }
  } catch (error) {
    res.write(
      `data: ${JSON.stringify({ error: { message: error.message, type: "upstream_error" } })}\n\n`,
    );
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

function findFrameBoundary(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { start: crlf, end: crlf + 4 };
  return { start: lf, end: lf + 2 };
}

async function* parseGoogleSse(body) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    // Cloud Code Assist frames with CRLF; accept either terminator.
    while ((idx = findFrameBoundary(buffer)) !== -1) {
      const raw = buffer.slice(0, idx.start);
      buffer = buffer.slice(idx.end);
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // ignore malformed frames
        }
      }
    }
  }
}

async function aggregateGoogleStream(body) {
  let text = "";
  const toolCalls = [];
  // Cloud Code Assist rejects a functionCall that comes back without the
  // thoughtSignature it was issued with, so keep them keyed by tool call id.
  // Host-visible tool calls are unaffected: only this proxy's in-chat tools
  // need to be echoed back.
  const thoughtSignatures = {};
  let usage;
  for await (const chunk of parseGoogleSse(body)) {
    const meta = chunk.response?.usageMetadata ?? chunk.usageMetadata;
    if (meta) {
      usage = {
        prompt_tokens: meta.promptTokenCount ?? 0,
        completion_tokens: meta.candidatesTokenCount ?? 0,
        total_tokens: meta.totalTokenCount ?? 0,
      };
    }
    const candidate = chunk.response?.candidates?.[0] ?? chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.thought === true) continue;
      if (typeof part.text === "string") text += part.text;
      const call = part.functionCall;
      if (call && typeof call.name === "string") {
        const id = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
        if (typeof part.thoughtSignature === "string") thoughtSignatures[id] = part.thoughtSignature;
        toolCalls.push({
          id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        });
      }
    }
  }
  return { text, toolCalls, usage, thoughtSignatures };
}


// --- grounded web search ----------------------------------------------------
// Mirrors buildSearchRequest/parseSearchResponse from the pi-antigravity
// extension: a googleSearch-grounded generateContent call whose grounding
// metadata becomes the citation list.
const SEARCH_MODEL = "gemini-3.5-flash-lite";
const SEARCH_SYSTEM_INSTRUCTION = `You are a careful research assistant using Google Search grounding.
Return a compact evidence brief with exactly these sections:
## Findings
## Gaps
## Next checks

Rules:
- Verify each claim inside the specific item, function, or section it refers to. Do not copy an attribute from a neighboring entry on the same page.
- Prefer primary documentation and exact names, versions, and constraints over marketing summaries.
- If a fact is not supported by a retrieved source, put it under Gaps instead of stating it as a finding.
- Keep the brief short enough for an interactive agent tool call.`;
// In-chat searches must read like an answer to the user, not like a tool brief.
const CHAT_SEARCH_SYSTEM_INSTRUCTION = `You are a web research assistant with Google Search grounding.
Answer the user's question directly from the retrieved results.

Rules:
- Cite every factual claim with [n], where n is the 1-based position of the source in the result list.
- Finish with a "Sources:" section listing those sources as markdown links, in the same order.
- If the results do not answer the question, say so plainly instead of guessing.
- Stay concise: a short answer plus citations, not a research report.`;

function buildGoogleSearchRequest(options, model, projectId) {
  const instruction = (options.instruction || "").trim();
  // The panel's search wants a structured evidence brief; an in-chat search
  // wants a direct answer with citations, so callers can override the brief.
  let systemText = (options.systemInstruction || "").trim() || SEARCH_SYSTEM_INSTRUCTION;
  if (instruction) {
    systemText += `\n\n[SPECIFIC DIRECTIVE FROM LEAD AGENT]:\n${instruction}\nYou MUST strictly follow this directive during search query formulation and synthesis.`;
  }
  let prompt = (options.query || "").trim();
  if (instruction) prompt = `[Lead Agent Directive]: ${instruction}\n\nSearch Query: ${prompt}`;
  const urls = Array.isArray(options.urls) ? options.urls.filter((u) => typeof u === "string" && u.trim()) : [];
  if (urls.length) prompt += `\n\nURLs to analyze in detail:\n${urls.join("\n")}`;

  const tools = [{ googleSearch: {} }];
  if (urls.length) tools.push({ urlContext: {} });

  const generationConfig = {};
  if (options.thinking || (options.thinking === undefined && !model.includes("lite"))) {
    generationConfig.thinkingConfig = {
      thinkingBudget: options.thinking ? 4096 : 2048,
      includeThoughts: false,
    };
  }
  const envelope = searchEnvelope(model);

  return {
    project: projectId,
    model,
    request: {
      systemInstruction: { role: "user", parts: [{ text: systemText }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools,
      generationConfig,
    },
    requestType: "AGENT",
    userAgent: "ANTIGRAVITY",
    requestId: envelope.requestId,
  };
}

function searchEnvelope(model) {
  const trajectoryId = randomUUID();
  return { requestId: `agent/${randomUUID()}/${Date.now()}/${trajectoryId}/1` };
}

function parseGoogleSearch(data) {
  const result = { text: "", sources: [], queries: [] };
  if (!data || typeof data !== "object") return result;
  const responseObj = data.response && typeof data.response === "object" ? data.response : data;
  const candidates = Array.isArray(responseObj.candidates) ? responseObj.candidates : [];
  const candidate = candidates[0];
  if (!candidate || typeof candidate !== "object") {
    const err = (data.error && data.error.message) || (responseObj.error && responseObj.error.message);
    result.text = `Error: ${err || "No candidate returned from Antigravity Search"}`;
    return result;
  }
  const content = candidate.content && typeof candidate.content === "object" ? candidate.content : undefined;
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const texts = [];
  parts.forEach((part, index) => {
    if (part && typeof part === "object" && !part.thought && typeof part.text === "string" && part.text) {
      texts.push({ index, text: part.text });
    }
  });
  result.text = texts.map((p) => p.text).join("\n\n");

  const grounding = candidate.groundingMetadata && typeof candidate.groundingMetadata === "object" ? candidate.groundingMetadata : undefined;
  if (grounding) {
    if (Array.isArray(grounding.webSearchQueries)) {
      result.queries = grounding.webSearchQueries.filter((q) => typeof q === "string");
    }
    if (Array.isArray(grounding.groundingChunks)) {
      grounding.groundingChunks.forEach((chunk, index) => {
        if (!chunk || typeof chunk !== "object") return;
        const web = chunk.web && typeof chunk.web === "object" ? chunk.web : undefined;
        if (typeof web?.uri === "string") {
          result.sources.push({
            index,
            title: typeof web.title === "string" && web.title.trim() ? web.title.trim() : web.uri,
            url: web.uri,
          });
        }
      });
    }
  }
  return result;
}

/**
 * Write the discovered catalog back into the plugin manifest.
 *
 * The host builds its model picker from the provider's config_json (a snapshot of
 * the manifest at install time), and no plugin-reachable API updates it. So the
 * discovered list is persisted here and takes effect on the next plugin reload.
 * Returns false when the manifest could not be written, so callers can say so.
 */
/**
 * How many models the picker will list. This is what the panel should report:
 * the runtime catalog collapses thinking variants into families, so counting
 * that instead makes a healthy refresh look like it lost models.
 */
function manifestModelCount() {
  try {
    const manifest = JSON.parse(readFileSync(join(__dirname, "manifest.json"), "utf8"));
    return manifest?.contributes?.providers?.[0]?.models?.length ?? MODEL_CATALOG.length;
  } catch {
    return MODEL_CATALOG.length;
  }
}

function persistCatalogToManifest(models) {
  try {
    const manifestPath = join(__dirname, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const provider = manifest?.contributes?.providers?.[0];
    if (!provider) return false;
    const preserved = (provider.models || []).filter((m) => m && m.type === "image");

    // Merge rather than replace: keep fine-grained entries whose runtime id the
    // server still advertises (so users can still pick -medium/-high directly),
    // drop entries that went away, and append any newly discovered public model.
    const known = new Set();
    for (const m of provider.models || []) {
      if (m && typeof m.id === "string") known.add(m.id);
    }
    const liveRuntimeIds = new Set();
    for (const m of models) liveRuntimeIds.add(m.id);

    const kept = [];
    for (const m of provider.models || []) {
      if (!m || m.type === "image") continue;
      // A fine-grained entry survives when its family still exists server-side.
      const family = m.id.replace(/-(low|medium|high|extra-low|minimal|xhigh)$/, "");
      if (liveRuntimeIds.has(family)) kept.push(m);
    }
    // Families already covered by fine-grained entries need no coarse alias:
    // listing both gemini-4-argon and gemini-4-argon-medium is just noise.
    const coveredFamilies = new Set();
    for (const m of kept) {
      coveredFamilies.add(m.id.replace(/-(low|medium|high|extra-low|minimal|xhigh)$/, ""));
    }
    const added = [];
    for (const m of models) {
      if (known.has(m.id)) continue;
      if (coveredFamilies.has(m.id)) continue;
      added.push({
        id: m.id,
        name: m.name,
        contextWindow: m.context_window,
        maxTokens: m.max_tokens,
        thinkingLevels: ["off", "low", "medium", "high"],
      });
    }
    provider.models = [...kept, ...added, ...preserved];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

// --- server -----------------------------------------------------------------

let server;
let startedAt = 0;
let bindRetry;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function startProxy() {
  if (server) return server;
  server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    // The panel runs in a sandboxed frame, so a direct fetch to this proxy is a
    // cross-origin request. Reflecting the origin keeps that path working (the
    // panel prefers the host bridge, which never needs this).
    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", typeof origin === "string" && origin ? origin : "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            url.pathname === "/health"
              ? { ok: true, uptimeMs: Date.now() - startedAt }
              : {
                  object: "list",
                  data: MODEL_CATALOG.map((m) => ({
                    id: m.id,
                    object: "model",
                    created: Math.floor(Date.now() / 1000),
                    owned_by: "antigravity",
                  })),
                },
          ),
        );
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Method not allowed", type: "invalid_request_error" } }));
        return;
      }
      const path = url.pathname.replace(/\/+$/, "");
      if (path === "/v1/models/refresh" || path === "/models/refresh") {
        // Ask Antigravity for its live catalog and swap it in.
        const clientTok = bearerToken(req);
        let token;
        if (clientTok) {
          token = clientTok;
        } else {
          const account = activeAccount();
          if (!account) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Not signed in.", type: "authentication_error" } }));
            return;
          }
          try {
            token = (await ensureFreshToken(account)).token;
          } catch (error) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: error.message, type: "upstream_error" } }));
            return;
          }
        }
        let raw;
        let lastError;
        for (const endpoint of ENDPOINTS) {
          try {
            const candidate = await httpFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
              },
              body: JSON.stringify({}),
              signal: AbortSignal.timeout(30000),
            });
            if (candidate.ok) {
              raw = await candidate.json();
              break;
            }
            lastError = `HTTP ${candidate.status}`;
          } catch (error) {
            lastError = error.cause?.code || error.message;
          }
        }
        if (!raw) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: `Model discovery failed${lastError ? `: ${lastError}` : ""}`, type: "upstream_error" } }));
          return;
        }
        // fetchAvailableModels returns the catalog at the top level.
        const models = raw.models && typeof raw.models === "object" ? raw.models : raw.data?.models;
        const sorts = raw.agentModelSorts ?? raw.data?.agentModelSorts;
        const built = buildCatalog(models, sorts);
        if (!built) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Antigravity returned no usable chat models.", type: "upstream_error" } }));
          return;
        }
        MODEL_CATALOG = built.models;
        MODEL_ROUTING = built.routing;
        const persisted = persistCatalogToManifest(MODEL_CATALOG);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            // `count` is the number of model *families* the server advertises;
            // the picker lists the finer-grained manifest entries, which is a
            // different number and the one users actually see.
            count: MODEL_CATALOG.length,
            manifestModels: manifestModelCount(),
            models: MODEL_CATALOG,
            // The host reads its picker from manifest config_json, which only a
            // plugin reload re-reads, so tell the caller whether a reload is needed.
            manifestUpdated: persisted,
            reloadRequired: persisted,
          }),
        );
        return;
      }
      if (path === "/v1/images/generations" || path === "/images/generations") {
        const bodyText2 = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(bodyText2);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }));
          return;
        }
        await handleImageGenerations(req, res, parsed);
        return;
      }
      if (path === "/v1/search" || path === "/search") {
        const bodyText3 = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(bodyText3);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }));
          return;
        }
        const query = String(parsed.query ?? "").trim();
        if (!query) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "query is required", type: "invalid_request_error" } }));
          return;
        }
        const clientTok = bearerToken(req);
        let token;
        let projectId;
        if (clientTok) {
          token = clientTok;
          const account = activeAccount();
          projectId = account?.projectId || stableProjectId(account?.email || "antigravity-default");
        } else {
          const account = activeAccount();
          if (!account) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Not signed in.", type: "authentication_error" } }));
            return;
          }
          try {
            const fresh = await ensureFreshToken(account);
            token = fresh.token;
            projectId = fresh.account.projectId || stableProjectId(fresh.account.email || "antigravity-default");
          } catch (error) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: error.message, type: "upstream_error" } }));
            return;
          }
        }
        const model = String(parsed.model || SEARCH_MODEL);
        const body = JSON.stringify(buildGoogleSearchRequest(parsed, model, projectId));
        let upstream;
        let lastError;
        for (const endpoint of ENDPOINTS) {
          try {
            const candidate = await httpFetch(`${endpoint}/v1internal:generateContent`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
              },
              body,
              signal: AbortSignal.timeout(120000),
            });
            if (candidate.ok) {
              upstream = candidate;
              break;
            }
            lastError = `HTTP ${candidate.status}`;
          } catch (error) {
            lastError = error.cause?.code || error.message;
          }
        }
        if (!upstream) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: `Antigravity search failed${lastError ? `: ${lastError}` : ""}`, type: "upstream_error" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(parseGoogleSearch(await upstream.json())));
        return;
      }
      if (path === "/v1/quota" || path === "/quota") {
        // Same precedence as chat: the host's token wins, otherwise refresh the
        // stored account so a stale token never turns into a bare 401.
        let token = bearerToken(req);
        if (!token) {
          const account = activeAccount();
          if (account) {
            try {
              token = (await ensureFreshToken(account)).token;
            } catch {
              token = undefined;
            }
          }
        }
        if (!token) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Not signed in.", type: "authentication_error" } }));
          return;
        }
        try {
          const raw = await fetchQuota(token);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(parseQuota(raw)));
        } catch (error) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: error.message, type: "upstream_error" } }));
        }
        return;
      }
      if (path !== "/chat/completions" && path !== "/v1/chat/completions") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Unknown route: ${url.pathname}`, type: "invalid_request_error" } }));
        return;
      }
      const bodyText = await readBody(req);
      await handleChatCompletions(req, res, bodyText);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: { message: error.message, type: "proxy_error" } }));
    }
  });
  server.listen(PORT, "127.0.0.1", () => {
    startedAt = Date.now();
  });
  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      // A stale process from an earlier session may still hold the port. It runs
      // old code, so quietly stepping aside would leave it serving forever.
      // Drop this listener and retry shortly; if it is genuinely gone the retry
      // binds, otherwise the next attempt reports the conflict.
      server = undefined;
      if (bindRetry) clearTimeout(bindRetry);
      bindRetry = setTimeout(() => {
        bindRetry = undefined;
        startProxy();
      }, 2000);
      return;
    }
    process.stderr.write(`[antigravity-proxy] listen error: ${error.message}\n`);
  });
  return server;
}

function stopProxy() {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  server.close();
  server = undefined;
}

module.exports = { startProxy, stopProxy, PORT, buildGoogleBody, openAiMessagesToContents, parseGoogleSse, aggregateGoogleStream, buildCatalog, getModelCatalog: () => MODEL_CATALOG, setChatToolsEnabled, getChatToolsEnabled };
