"use strict";

/**
 * PI-Desktop plugin host for the Antigravity provider.
 *
 * Sign-in lives here rather than in the agent extension because the browser can
 * rarely reach http://localhost:51121/oauth-callback when a system proxy is
 * active. The plugin settings sheet gives the user somewhere to paste the
 * callback URL, which completes the flow without any local listener.
 *
 * Credentials are written to the same files the agent extension reads
 * (~/.pi/agent/antigravity-accounts.json and auth.json), so the two processes
 * stay decoupled and only share state on disk.
 */

const { createHash, randomBytes } = require("node:crypto");
const { createServer } = require("node:http");
const proxy = require("./proxy.cjs");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const CLIENT_ID =
  process.env.ANTIGRAVITY_CLIENT_ID ||
  Buffer.from(
    "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" +
      "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
    "base64",
  ).toString("utf8");
const CLIENT_SECRET =
  process.env.ANTIGRAVITY_CLIENT_SECRET ||
  Buffer.from("R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=", "base64").toString("utf8");

const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const CALLBACK_HOST = "127.0.0.1";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
// oauth2.googleapis.com is REJECTed on some networks (notably behind Clash rules)
// while www.googleapis.com/oauth2/v4/token serves the same grant types.
const TOKEN_ENDPOINTS = [
  "https://www.googleapis.com/oauth2/v4/token",
  "https://oauth2.googleapis.com/token",
];
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
const ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];
const USER_AGENT =
  "antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";

const ACCOUNTS_FILE = "antigravity-accounts.json";
const AUTH_FILE = "auth.json";
const PENDING_FILE = "antigravity-signin.json";
const OPEN_PANEL_COMMAND_ID = "antigravity.openPanel";
const SIGN_IN_COMMAND_ID = "antigravity.signIn";
const SIGN_OUT_COMMAND_ID = "antigravity.signOut";

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * Network egress for this plugin process.
 *
 * A PI-Desktop plugin host is a plain Electron utility process with no sandbox,
 * but it is NOT handed the host's proxy configuration (the agent sidecar gets
 * that over its configure RPC). Node's fetch ignores the macOS system proxy, so
 * on a machine that only reaches the internet through a local proxy every direct
 * request dies with UND_ERR_CONNECT_TIMEOUT.
 *
 * Order: explicit env proxy -> a loopback proxy that answers -> direct.
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
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || undefined;
}

async function detectLoopbackProxy() {
  if (proxyProbed) return cachedProxy;
  proxyProbed = true;
  const net = require("node:net");
  for (const port of PROXY_PORTS) {
    const host = "127.0.0.1";
    const reachable = await new Promise((resolve) => {
      const socket = net.connect({ host, port });
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
      cachedProxy = `http://${host}:${port}`;
      return cachedProxy;
    }
  }
  return undefined;
}

async function resolveProxy() {
  return envProxy() || (await detectLoopbackProxy());
}

let dispatcher;
let dispatcherFor;

async function httpFetch(url, options) {
  const proxy = await resolveProxy();
  if (!proxy) return fetch(url, options);
  if (dispatcherFor !== proxy) {
    const undici = require("undici");
    dispatcher = new undici.ProxyAgent(proxy);
    dispatcherFor = proxy;
  }
  const undici = require("undici");
  return undici.fetch(url, { ...options, dispatcher });
}

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stableProjectId(seed) {
  const bytes = createHash("sha1").update(`antigravity:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonObject(path) {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writePrivateJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

// --- account store (same shape as src/auth/accounts.ts) ---------------------

function normalizeStore(raw) {
  if (!raw || raw.version !== 1 || !isRecord(raw.accounts)) return { version: 1, accounts: {} };
  const accounts = {};
  for (const [key, value] of Object.entries(raw.accounts)) {
    if (!isRecord(value) || typeof value.refresh !== "string" || !value.refresh) continue;
    const accountId = typeof value.accountId === "string" && value.accountId.trim() ? value.accountId : key;
    accounts[accountId] = { ...value, accountId };
  }
  const activeAccountId =
    typeof raw.activeAccountId === "string" && accounts[raw.activeAccountId] ? raw.activeAccountId : undefined;
  return { version: 1, activeAccountId, accounts };
}

function loadAccountStore() {
  return normalizeStore(readJsonObject(join(agentDir(), ACCOUNTS_FILE)));
}

function saveAccountStore(store) {
  writePrivateJson(join(agentDir(), ACCOUNTS_FILE), store);
}

function accountIdFor(credentials) {
  const email = typeof credentials.email === "string" ? credentials.email.trim().toLowerCase() : "";
  if (email) return email;
  return `account-${createHash("sha256").update(credentials.refresh).digest("hex").slice(0, 16)}`;
}

function findAccount(store, credentials) {
  const id = accountIdFor(credentials);
  return store.accounts[id];
}

function activeAccount(store) {
  if (store.activeAccountId && store.accounts[store.activeAccountId]) return store.accounts[store.activeAccountId];
  const list = Object.values(store.accounts).sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
  return list[0];
}

function apiKeyFor(account) {
  const email = typeof account.email === "string" ? account.email.trim() : "";
  return {
    token: account.access,
    projectId: account.projectId || stableProjectId(email || "antigravity-default"),
  };
}

/** Mirror the active account into Pi's auth.json so the host model registry sees it. */
function writeActiveCredential(account) {
  const authPath = join(agentDir(), AUTH_FILE);
  const auth = readJsonObject(authPath) || {};
  if (account) {
    auth.antigravity = {
      type: "oauth",
      email: account.email,
      access: account.access,
      refresh: account.refresh,
      expires: account.expires,
      projectId: account.projectId,
    };
  } else {
    delete auth.antigravity;
  }
  writePrivateJson(authPath, auth);
}

function statusText() {
  const store = loadAccountStore();
  const account = activeAccount(store);
  if (!account || !account.access) return "Not signed in.";
  const email = account.email ? ` (${account.email})` : "";
  return `Signed in${email}.`;
}

// --- OAuth ------------------------------------------------------------------

function generatePKCE() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function apiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
}

async function discoverProjectId(token) {
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await httpFetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: apiHeaders(token),
        body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const direct =
        data.antigravityProjectId ?? data.projectId ?? data.backendProjectId ?? data.cloudaicompanionProject;
      const id = typeof direct === "string" ? direct : isRecord(direct) ? direct.id : undefined;
      if (id) return id;
      const listRes = await httpFetch(`${endpoint}/v1internal:listCloudAICompanionProjects`, {
        method: "POST",
        headers: apiHeaders(token),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15000),
      });
      if (!listRes.ok) continue;
      const listData = await listRes.json();
      const projects = listData.projects ?? listData.projectIds ?? listData.cloudaicompanionProjects;
      if (Array.isArray(projects) && projects.length > 0) {
        const first = projects[0];
        const pid = typeof first === "string" ? first : isRecord(first) ? first.id : undefined;
        if (pid) return pid;
      }
    } catch {
      // try the next endpoint
    }
  }
  return undefined;
}

function parseCallback(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("Paste the full callback URL from the browser address bar.");
  let url;
  try {
    url = new URL(text);
  } catch {
    const qs = text.startsWith("?") ? text.slice(1) : text;
    url = new URL(`${REDIRECT_URI}?${qs}`);
  }
  const error = url.searchParams.get("error");
  if (error) throw new Error(`Google reported an error: ${error.slice(0, 200)}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new Error("That URL has no code/state. Copy the FULL address bar URL.");
  return { code, state };
}

async function exchangeCode(code, verifier) {
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  }).toString();

  let res;
  let lastStatus;
  let lastBody = "";
  for (const url of TOKEN_ENDPOINTS) {
    try {
      const candidate = await httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      });
      if (candidate.ok) {
        res = candidate;
        break;
      }
      lastStatus = candidate.status;
      lastBody = await candidate.text();
    } catch {
      // unreachable; try the next endpoint
    }
  }
  if (!res) {
    throw new Error(`Token exchange failed${lastStatus ? ` (${lastStatus})` : ""}: ${lastBody.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.refresh_token) {
    throw new Error("Google returned no refresh token. Re-run sign-in and allow offline access.");
  }
  return data;
}

async function fetchEmail(token) {
  try {
    const res = await httpFetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return undefined;
    const data = await res.json();
    return typeof data.email === "string" ? data.email : undefined;
  } catch {
    return undefined;
  }
}

// --- sign-in flow -----------------------------------------------------------

/** Drop the in-flight sign-in state so a stale URL cannot be replayed. */
function clearPending() {
  const path = join(agentDir(), PENDING_FILE);
  try {
    if (existsSync(path)) rmSync(path);
  } catch {
    // best effort: an expired pending file is rejected by the state check anyway
  }
}

function buildAuthUrl(verifier, challenge, state) {
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  }).toString()}`;
}

/**
 * Mint the PKCE pair and persist it so the callback (automatic or pasted) can be
 * finished later, possibly by a different call.
 */
function beginSignIn() {
  const { verifier, challenge } = generatePKCE();
  const state = base64Url(randomBytes(32));
  writePrivateJson(join(agentDir(), PENDING_FILE), { verifier, state, createdAt: Date.now() });
  return buildAuthUrl(verifier, challenge, state);
}

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Serve http://127.0.0.1:51121/oauth-callback for the duration of one sign-in.
 *
 * The system proxy exempts loopback, so the browser redirect lands here and the
 * flow finishes with no manual paste. Pasting remains available as a fallback:
 * anything that arrives on the listener wins the race against the pasted URL.
 */
function startCallbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", REDIRECT_URI);
      if (url.pathname !== "/oauth-callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Antigravity OAuth callback route not found.");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const page = (title, detail) =>
        `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
        `<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:34em;margin:12vh auto;padding:0 20px;color:#1a1c1f}</style>` +
        `<h2>${title}</h2><p>${detail}</p>`;
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("Antigravity sign-in failed", `Google reported: ${escapeHtml(String(error).slice(0, 200))}`));
        finish(() => rejectCode(new Error(`Google reported an OAuth error: ${String(error).slice(0, 200)}`)));
        return;
      }
      if (!code || !state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("Antigravity sign-in failed", "The callback URL was missing code or state."));
        finish(() => rejectCode(new Error("Callback was missing code or state.")));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("Antigravity sign-in failed", "That callback belongs to a different sign-in."));
        finish(() => rejectCode(new Error("Callback state did not match this sign-in.")));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page("Antigravity signed in", "You can close this tab and return to PI-Desktop."));
      finish(() => resolveCode({ code, state }));
    });

    let settled = false;
    let timeout;
    let resolveCode;
    let rejectCode;
    let closeServer = () => {};
    const codePromise = new Promise((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    // The caller may still be opening the browser when a bad callback lands, so
    // the rejection has to stay "handled" until someone awaits it.
    codePromise.catch(() => {});
    // Whatever settles the flow - code, error, timeout - must also release the
    // port, otherwise a failed attempt keeps 51121 bound and the next sign-in
    // hits EADDRINUSE.
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
      closeServer();
    };

    server.on("error", (err) => {
      finish(() =>
        reject(
          err && err.code === "EADDRINUSE"
            ? new Error("Port 51121 is already in use. Close whatever holds it, then sign in again.")
            : err,
        ),
      );
    });

    server.listen(51121, CALLBACK_HOST, () => {
      timeout = setTimeout(() => {
        finish(() => rejectCode(new Error("Sign-in timed out after 5 minutes.")));
        close();
      }, CALLBACK_TIMEOUT_MS);
      resolve({
        waitForCode: () => codePromise,
        close: () => finish(() => close()),
      });
    });

    closeServer = () => {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      server.close();
    };
    const close = () => finish(() => {});
  });
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let lastEmail;

/** Exchange an authorization code for tokens and persist the account. */
async function finishWithCode(code, verifier) {
  const token = await exchangeCode(code, verifier);
  const [email, projectId] = await Promise.all([
    fetchEmail(token.access_token),
    discoverProjectId(token.access_token),
  ]);
  const credentials = {
    refresh: token.refresh_token,
    access: token.access_token,
    expires: Date.now() + token.expires_in * 1000 - 5 * 60 * 1000,
    projectId: projectId || stableProjectId(email || "antigravity-default"),
    email,
  };
  lastEmail = email;
  const store = loadAccountStore();
  const existing = findAccount(store, credentials);
  const account = {
    ...credentials,
    accountId: existing?.accountId || accountIdFor(credentials),
    addedAt: existing?.addedAt ?? Date.now(),
    lastUsedAt: Date.now(),
  };
  store.accounts[account.accountId] = account;
  store.activeAccountId = account.accountId;
  saveAccountStore(store);
  writeActiveCredential(account);
  clearPending();
  return account;
}

/** Manual-paste path used when the loopback listener never saw the redirect. */
async function completeSignIn(callbackUrl) {
  const pending = readJsonObject(join(agentDir(), PENDING_FILE));
  if (!pending || typeof pending.verifier !== "string") {
    throw new Error("No sign-in in progress. Run the sign-in command first.");
  }
  const { code, state } = parseCallback(callbackUrl);
  if (state !== pending.state) {
    throw new Error("That callback belongs to a different sign-in. Start again and paste the new URL.");
  }
  return finishWithCode(code, pending.verifier);
}

function signOut() {
  const store = loadAccountStore();
  const active = activeAccount(store);
  if (active) delete store.accounts[active.accountId];
  const remaining = Object.keys(store.accounts);
  store.activeAccountId = remaining[0];
  saveAccountStore(store);
  writeActiveCredential(store.activeAccountId ? store.accounts[store.activeAccountId] : undefined);
}

function openUrl(url) {
  const { spawn } = require("node:child_process");
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

// --- plugin wiring ----------------------------------------------------------

/**
 * Small piece of plugin-local state.
 *
 * The manifest no longer declares `contributes.settings` (it only produced an
 * auto-generated form that the panel made redundant), and the host rejects
 * writes to undeclared setting keys, so state lives in the agent directory.
 */
let pluginState = {};
let stateLoaded = false;

function statePath() {
  return join(agentDir(), "plugin-state.json");
}

async function readState() {
  if (stateLoaded) return pluginState;
  try {
    pluginState = readJsonObject(statePath()) || {};
  } catch {
    pluginState = {};
  }
  stateLoaded = true;
  return pluginState;
}

async function writeState(patch) {
  pluginState = { ...(await readState()), ...patch };
  stateLoaded = true;
  try {
    writePrivateJson(statePath(), pluginState);
  } catch {
    // best effort: state is diagnostic only
  }
}

async function toast(message, level) {
  try {
    await pi.ui.showToast(message, level);
  } catch {
    // toast unavailable outside the host
  }
}

/**
 * Start sign-in and return immediately.
 *
 * A panel invoke is capped at PLUGIN_PANEL_TIMEOUT_MS (30s), but the browser
 * round-trip takes minutes, so waiting for the callback inside the invoke would
 * be killed mid-flight. The listener therefore runs in the background and the
 * panel polls status instead of blocking on this call.
 */
async function doSignIn() {
  const url = beginSignIn();
  const pending = readJsonObject(join(agentDir(), PENDING_FILE));
  if (!pending) throw new Error("Could not start sign-in: no pending state.");

  let server;
  try {
    server = await startCallbackServer(pending.state);
  } catch (error) {
    server = undefined;
    await writeState({
      lastError: `${error.message} Paste the callback URL manually.`,
    }).catch(() => {});
    return { opened: openUrl(url), waiting: false };
  }

  openUrl(url);

  // Detached on purpose: nothing awaits this, so the 30s panel budget never applies.
  void (async () => {
    try {
      const { code } = await server.waitForCode();
      const account = await finishWithCode(code, pending.verifier);
      await writeState({
        accountStatus: account.email ? `Signed in (${account.email}).` : "Signed in.",
        lastError: "",
        callbackUrl: "",
      });
      await toast(`Antigravity: signed in${account.email ? ` as ${account.email}` : ""}`, "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeState({ lastError: message }).catch(() => {});
      await toast(`Antigravity sign-in failed: ${message}`, "warn");
    } finally {
      server.close();
    }
  })();

  return { opened: true, waiting: true };
}

async function doSignOut() {
  signOut();
  await writeState({ accountStatus: statusText(), lastError: "" });
  try {
    await pi.ui.showToast("Antigravity: signed out", "ok");
  } catch {
    // toast unavailable
  }
}

async function onLoad() {
  // The provider row points at this loopback proxy: PI-Desktop speaks OpenAI
  // wire format, Antigravity does not, so the proxy is what makes the provider
  // usable at all.
  try {
    proxy.startProxy();
  } catch (error) {
    await writeState({ lastError: `Proxy failed to start: ${error.message}` }).catch(() => {});
  }
  await readState();
  // In-chat image/search tools are on by default; the panel toggle persists here.
  try {
    proxy.setChatToolsEnabled(pluginState.chatTools !== false);
  } catch {
    // the proxy keeps its own default when the flag cannot be applied
  }
  try {
    await pi.commands.register({
      id: SIGN_IN_COMMAND_ID,
      title: "Antigravity: open Google sign-in",
      keywords: ["antigravity", "google", "sign in", "login", "oauth", "cloud code", "gemini"],
      category: "Agent",
      run: doSignIn,
    });
    await pi.commands.register({
      id: OPEN_PANEL_COMMAND_ID,
      title: "Antigravity: open panel",
      keywords: ["antigravity", "google", "panel", "sign in", "login", "oauth", "gemini"],
      category: "Agent",
      run: async () => {
        await pi.ui.openPanel({ title: "Antigravity" });
      },
    });
    await pi.commands.register({
      id: SIGN_OUT_COMMAND_ID,
      title: "Antigravity: sign out",
      keywords: ["antigravity", "google", "sign out", "logout", "oauth"],
      category: "Agent",
      run: doSignOut,
    });
  } catch (error) {
    // Without commands the settings sheet still works, so this is not fatal.
    try {
      await pi.ui.showToast(`Antigravity: could not register commands (${error?.message ?? error})`, "warn");
    } catch {
      // toast unavailable
    }
  }
}

async function onUnload() {
  try {
    proxy.stopProxy();
  } catch {
    // best effort
  }
  for (const id of [OPEN_PANEL_COMMAND_ID, SIGN_IN_COMMAND_ID, SIGN_OUT_COMMAND_ID]) {
    try {
      await pi.commands.unregister(id);
    } catch {
      // already gone
    }
  }
}

/**
 * Panel bridge (renderer/index.html). Channels are plain strings; the host routes
 * anything outside its built-in `ui.*` set here.
 */
async function onPanelInvoke(channel, payload) {
  try {
    return await handlePanelInvoke(channel, payload);
  } catch (error) {
    // The panel surfaces whatever lands here verbatim, so keep the message
    // human-readable instead of letting a stack trace reach the UI.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message || "Antigravity panel call failed.");
  }
}

async function handlePanelInvoke(channel, payload) {
  switch (channel) {
    case "antigravity.status": {
      // The account store on disk is the source of truth: settings only mirror it,
      // and a stale mirror is exactly what made a signed-in panel read "not signed in".
      const store = loadAccountStore();
      const account = activeAccount(store);
      const status = account?.access
        ? account.email
          ? `Signed in (${account.email}).`
          : "Signed in."
        : "Not signed in.";
      let lastError = "";
      try {
        await readState();
        lastError = String(pluginState.lastError ?? "");
      } catch {
        // settings unavailable; status alone is still accurate
      }
      return { accountStatus: status, lastError, chatTools: proxy.getChatToolsEnabled() };
    }
    case "antigravity.signIn": {
      await doSignIn();
      return { ok: true };
    }
    case "antigravity.completeSignIn": {
      const callbackUrl = String(payload?.callbackUrl ?? "").trim();
      if (!callbackUrl) throw new Error("Paste the full callback URL first.");
      const account = await completeSignIn(callbackUrl);
      const status = account.email ? `Signed in (${account.email}).` : "Signed in.";
      await writeState({ callbackUrl: "", lastError: "", accountStatus: status });
      return { ok: true, accountStatus: status };
    }
    case "antigravity.quota": {
      // The proxy owns egress + token handling, so ask it rather than duplicating
      // the endpoint list here.
      const res = await httpFetch("http://127.0.0.1:51122/v1/quota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Quota request failed (${res.status}): ${detail.slice(0, 200)}`);
      }
      return await res.json();
    }
    case "antigravity.image": {
      const prompt = String(payload?.prompt ?? "").trim();
      if (!prompt) throw new Error("A prompt is required.");
      const ratio = String(payload?.aspectRatio ?? "auto");
      const res = await httpFetch(`http://127.0.0.1:${proxy.PORT}/v1/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: payload?.model || "gemini-3.1-flash-image", prompt, n: 1, size: ratio }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Image generation failed (${res.status}): ${detail.slice(0, 200)}`);
      }
      const data = await res.json();
      const first = data?.data?.[0];
      if (!first?.b64_json) throw new Error("Antigravity returned no image.");
      return { b64: first.b64_json, mimeType: first.mime_type || "image/png" };
    }
    case "antigravity.search": {
      const query = String(payload?.query ?? "").trim();
      if (!query) throw new Error("A query is required.");
      const res = await httpFetch(`http://127.0.0.1:${proxy.PORT}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, urls: payload?.urls, thinking: payload?.thinking }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Search failed (${res.status}): ${detail.slice(0, 200)}`);
      }
      return await res.json();
    }
    case "antigravity.refreshModels": {
      const res = await httpFetch(`http://127.0.0.1:${proxy.PORT}/v1/models/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Model refresh failed (${res.status}): ${detail.slice(0, 200)}`);
      }
      return await res.json();
    }
    case "antigravity.models": {
      // The picker is built from the manifest snapshot, so report exactly that
      // list. Asking the proxy instead made the panel disagree with the picker:
      // the proxy catalog collapses thinking variants into families.
      const manifestPath = join(__dirname, "manifest.json");
      let models = [];
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        models = manifest?.contributes?.providers?.[0]?.models ?? [];
      } catch (error) {
        throw new Error(`Could not read the model list: ${error.message}`);
      }
      const chat = models.filter((m) => m && m.type !== "image");
      return {
        count: models.length,
        chatCount: chat.length,
        imageCount: models.length - chat.length,
        models: models.map((m) => ({ id: m.id, name: m.name ?? m.id, type: m.type ?? "chat" })),
      };
    }
    case "antigravity.setChatTools": {
      // In-chat image/search tools. Off means a plain conversation that never
      // sees a function declaration it did not ask for.
      const enabled = payload?.enabled !== false;
      proxy.setChatToolsEnabled(enabled);
      await writeState({ chatTools: enabled });
      return { ok: true, chatTools: enabled };
    }
    case "antigravity.signOut": {
      await doSignOut();
      return { ok: true, accountStatus: statusText() };
    }
    default:
      throw new Error(`unsupported panel channel: ${channel}`);
  }
}

/**
 * Native provider OAuth (manifest contributes.providers, authKind "oauth").
 *
 * The host asks for { operation, providerId, loginId } and expects a credential
 * back: { accessToken, refreshToken?, expiresAt?, accountLabel? }. Reusing the
 * same PKCE + loopback listener + token exchange as the panel flow means one
 * implementation serves both, and the credential still lands in the shared
 * account store the agent extension reads.
 */
function credentialFromStore() {
  const store = loadAccountStore();
  const account = activeAccount(store);
  if (!account?.access || !account?.refresh) return undefined;
  return {
    accessToken: account.access,
    refreshToken: account.refresh,
    expiresAt: account.expires,
    accountLabel: account.email || "Google account",
  };
}

/**
 * Exchange a stored refresh token for a fresh access token.
 *
 * oauth2.googleapis.com is REJECTed on some networks while
 * www.googleapis.com/oauth2/v4/token serves the same grant, so try the reachable
 * one first.
 */
async function refreshCredential(refreshToken) {
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }).toString();

  let res;
  let lastStatus;
  for (const url of TOKEN_ENDPOINTS) {
    try {
      const candidate = await httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      });
      if (candidate.ok) {
        res = candidate;
        break;
      }
      lastStatus = candidate.status;
    } catch {
      // unreachable; try the next endpoint
    }
  }
  if (!res) throw new Error(`Antigravity token refresh failed${lastStatus ? ` (${lastStatus})` : ""}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("Refresh returned no access token.");
  return data;
}

async function onProviderOAuth(request) {
  const operation = String(request?.operation ?? "");
  if (operation === "refresh") {
    const current = request?.credential ?? {};
    const refreshToken = String(current.refreshToken ?? "").trim();
    if (!refreshToken) throw new Error("No refresh token available for Antigravity.");
    const data = await refreshCredential(refreshToken);
    const store = loadAccountStore();
    const account = activeAccount(store);
    const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000 - 5 * 60 * 1000;
    // Keep the shared store in step so the agent extension sees the same token.
    if (account && account.refresh === refreshToken) {
      account.access = data.access_token;
      account.expires = expiresAt;
      store.accounts[account.accountId] = account;
      if (store.activeAccountId === account.accountId) store.activeAccountId = account.accountId;
      saveAccountStore(store);
      writeActiveCredential(account);
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt,
      accountLabel: current.accountLabel || account?.email || "Google account",
    };
  }
  if (operation !== "login") {
    throw new Error(`unsupported provider OAuth operation: ${operation || "(none)"}`);
  }

  // The host caps this call at PLUGIN_PROVIDER_OAUTH_TIMEOUT_MS (60s), while a
  // browser round-trip routinely takes longer. An account that is already
  // signed in therefore answers immediately instead of racing that budget.
  const existing = credentialFromStore();
  if (existing) {
    await writeState({
      accountStatus: "Signed in.",
      lastError: "",
      callbackUrl: "",
    }).catch(() => {});
    return existing;
  }

  const url = beginSignIn();
  const pending = readJsonObject(join(agentDir(), PENDING_FILE));
  if (!pending) throw new Error("Could not start sign-in: no pending state.");

  let server;
  try {
    server = await startCallbackServer(pending.state);
  } catch (error) {
    throw new Error(`${error.message} Paste the callback URL into the panel instead.`);
  }

  try {
    openUrl(url);
    const { code } = await server.waitForCode();
    const account = await finishWithCode(code, pending.verifier);
    await writeState({
      accountStatus: account.email ? `Signed in (${account.email}).` : "Signed in.",
      lastError: "",
      callbackUrl: "",
    });
    try {
      await pi.ui.showToast(`Antigravity: signed in${account.email ? ` as ${account.email}` : ""}`, "ok");
    } catch {
      // toast unavailable
    }
    return {
      accessToken: account.access,
      refreshToken: account.refresh,
      expiresAt: account.expires,
      accountLabel: account.email || "Google account",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeState({ lastError: message }).catch(() => {});
    throw error;
  } finally {
    server.close();
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke, onProviderOAuth };
