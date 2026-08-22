// dsh-folder-permissions — host half: per-session, per-folder read/write
// permissions.
//
// Implements the "Per-session folder-level read/write permissions" extension
// as a self-contained Cordis plugin. It runs in the host process (which is not
// sandboxed), so it can maintain a durable grant store under `$DSH_HOME`.
//
// What it does on its own (no core change, no restart of a running host):
//   - provides `ctx.folderPermissions` (grantsOf / rootsFor / grant / revoke),
//   - applies a pre-configured `allow.read` / `allow.write` list to every new
//     session without prompting,
//   - exposes a `/folder-permissions` slash command (grant / revoke / list),
//   - tells the model its current granted folders,
//   - persists grants per session (durable across restart, isolated per session).
//
// What needs the one-time core patch (`scripts/patch-core.mjs`, then a host
// restart): the filesystem fence actually HONORING the granted folders. Until
// that patch is applied, grants are recorded and surfaced but do not yet widen
// the `workspace-write` boundary — the feature fails closed (nothing becomes
// more permissive), so a running host is never affected by installing this.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ACCESSES, canonicalGrantPath, createGrantStore, grantsList, mergeConfigured, rootsOf } from "./store.js";

const name = "folder-permissions";

/** Services this plugin needs before it can mount. `sessions` is always in the host plane. */
const inject = ["sessions"];

/** Loopback-only addresses for the HTTP mutation surface (same trust level as the web UI). */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The harness home; mirrors `dsh-home-paths` without importing it (peer-agnostic). */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/** Coerce a config allow-list to an array of non-empty strings. */
function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function isLoopback(address) {
  return LOOPBACK.has(address ?? "");
}

/** Read a JSON request body (bounded only by the HTTP server's own limits). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Find the `approval/asked` event for one approval id (newest-first scan). */
function findApprovalAsked(events, approvalId) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "approval/asked" && event.data.id === approvalId) return event;
  }
  return undefined;
}

/** Find the `tool/call` event for one call id (newest-first scan). */
function findToolCall(events, callId) {
  const key = String(callId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "tool/call" && String(event.data.callId) === key) return event;
  }
  return undefined;
}

/** Resolve a tool-supplied path against the calling session's cwd before granting its parent folder. */
function resolveAgainstSession(session, path) {
  if (path === "~" || path.startsWith("~/") || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  const cwd = session.header?.cwd;
  return cwd !== undefined ? join(cwd, path) : path;
}

function apply(ctx, config = {}) {
  const cfg = {
    allow: {
      read: normalizeList(config.allow?.read),
      write: normalizeList(config.allow?.write)
    },
    allowGlobal: {
      read: normalizeList(config.allowGlobal?.read),
      write: normalizeList(config.allowGlobal?.write)
    }
  };
  const store = createGrantStore(join(dshHome(), "folder-permissions"));

  const grantsOf = (session) => store.load(session.id);
  const persist = (session, grants) => store.save(session.id, grants);

  /** Deployment-wide roots, canonicalized once at mount. */
  const globalRoots = () => ({
    writable: cfg.allowGlobal.write.map(canonicalGrantPath),
    readable: cfg.allowGlobal.read.map(canonicalGrantPath)
  });

  /** The full writable/readable root set for one session: global roots + its own grants. */
  const rootsForSession = (session) => {
    const per = rootsOf(grantsOf(session));
    const glob = globalRoots();
    return {
      writable: [...new Set([...glob.writable, ...per.writable])],
      readable: [...new Set([...glob.readable, ...per.readable])]
    };
  };

  /** Global roots as a wire-friendly list for the tab's read-only section. */
  const globalGrantsList = () => {
    const byPath = new Map();
    for (const path of globalRoots().readable) byPath.set(path, { path, read: true, write: false });
    for (const path of globalRoots().writable) {
      const entry = byPath.get(path) ?? { path, read: false, write: false };
      entry.write = true;
      byPath.set(path, entry);
    }
    return [...byPath.values()];
  };

  /** Optional composition services for the session permission summary (degrade gracefully when absent). */
  const sandboxPolicy = ctx.get("sandboxPolicy");
  const approval = ctx.get("approval");

  /** Effective sandbox mode + approval policy + workspace root for one session id. */
  const sessionSummary = (sessionId) => {
    const session = ctx.sessions.get?.(sessionId);
    const policy = sandboxPolicy?.resolve(session === undefined ? {} : { session });
    const mode = policy?.mode ?? "workspace-write";
    const workspace = policy?.workspaceRoot ?? session?.header?.cwd;
    const approvalPolicy = approval === undefined
      ? "ask"
      : session === undefined
        ? (approval.config?.policy ?? "ask")
        : approval.effectivePolicy(session);
    return { mode, workspace, approval: approvalPolicy };
  };

  /** One grant/revoke transition keyed by session id, shared by the service, the command, and the HTTP route. */
  const mutateGrant = (sessionId, path, access, granted) => {
    const canonical = canonicalGrantPath(path);
    const grants = store.load(sessionId);
    const entry = grants[canonical] ?? { read: false, write: false };
    entry[access] = granted;
    if (entry.read || entry.write) grants[canonical] = entry;
    else delete grants[canonical];
    store.save(sessionId, grants);
    return canonical;
  };

  /** Flip a grant's enabled flag without removing it from the tab's list. */
  const toggleGrant = (sessionId, path) => {
    const canonical = canonicalGrantPath(path);
    const grants = store.load(sessionId);
    const entry = grants[canonical];
    if (entry === undefined) return canonical;
    entry.enabled = entry.enabled === false; // enabled/undefined -> disable; false -> enable
    store.save(sessionId, grants);
    return canonical;
  };

  const grant = (session, path, access) => mutateGrant(session.id, path, access, true);
  const revoke = (session, path, access) => mutateGrant(session.id, path, access, false);
  const toggle = (session, path) => toggleGrant(session.id, path);

  // First-class service. The core sandbox-policy patch reads `rootsFor` to fold
  // granted folders into the per-call file-effect policy; everything else here
  // is the grant-management surface.
  ctx.provide("folderPermissions", {
    grantsOf: (session) => ({ ...grantsOf(session) }),
    rootsFor: rootsForSession,
    grant,
    revoke,
    toggle
  });

  // Pre-configure: apply the allow lists to every session, with no prompt.
  const pinInitial = (session) => {
    let grants = grantsOf(session);
    let changed = false;
    for (const access of ACCESSES) {
      const configured = mergeConfigured(grants, cfg.allow[access], access);
      if (configured !== grants) {
        grants = configured;
        changed = true;
      }
    }
    if (changed) persist(session, grants);
  };
  ctx.on("session/created", (session) => pinInitial(session));
  for (const session of ctx.sessions.list()) pinInitial(session);

  // Model-facing context: what this session may currently write/read beyond the
  // workspace, so the model knows its grants and can ask to widen them.
  ctx.inject(["systemPrompt"], (scope) => {
    scope.systemPrompt.context({
      name: "permission:folders",
      order: 112,
      text: (context) => {
        const session = context.agent?.session;
        if (session === void 0) return "";
        const { writable, readable } = rootsForSession(session);
        if (writable.length === 0 && readable.length === 0) return "";
        const parts = [];
        if (writable.length > 0) parts.push(`Granted writable folders for this session: ${writable.map((p) => JSON.stringify(p)).join(", ")}.`);
        if (readable.length > 0) parts.push(`Tracked readable folders for this session: ${readable.map((p) => JSON.stringify(p)).join(", ")} (reads are currently unrestricted).`);
        return parts.join(" ");
      }
    });
  });

  // The agent/user toggle surface: /folder-permissions grant|revoke|list.
  ctx.inject(["commands"], (scope) => {
    scope.commands.register({
      name: "folder-permissions",
      description: "Grant or revoke a per-session folder read/write permission",
      input: { hint: "<grant|revoke|list> [path] [read|write]" },
      handler: ({ agent, rawInput }) => {
        const session = agent?.session;
        if (session === void 0) return { kind: "error", text: "no active session" };
        const parts = (rawInput ?? "").trim().split(/\s+/).filter(Boolean);
        const verb = parts[0] ?? "list";
        if (verb === "list") {
          const grants = grantsOf(session);
          const entries = Object.entries(grants);
          if (entries.length === 0) return { kind: "success", text: "no folder grants for this session" };
          const lines = entries.map(([path, flags]) => {
            const kinds = flags.read && flags.write ? "read, write" : flags.read ? "read" : "write";
            return `${path}: ${kinds}`;
          });
          return { kind: "success", text: lines.join("\n") };
        }
        if (verb === "grant" || verb === "revoke") {
          const path = parts[1];
          const access = parts[2] ?? "write";
          if (path === void 0) return { kind: "error", text: `usage: /folder-permissions ${verb} <path> [read|write]` };
          if (!ACCESSES.includes(access)) return { kind: "error", text: `access must be one of: ${ACCESSES.join(", ")}` };
          const canonical = verb === "grant" ? grant(session, path, access) : revoke(session, path, access);
          return { kind: "success", text: `${verb} ${access} on ${canonical}` };
        }
        return { kind: "error", text: `unknown subcommand "${verb}" (use grant, revoke, or list)` };
      }
    });
  });

  // FE-tab data plane: a loopback-only read/write route the browser tab fetches.
  // The slash command above serves the agent; this route serves the web UI
  // without a custom RPC channel (the dsh-deepseek-usage precedent).
  ctx.inject(["webServer"], (scope) => {
    scope.webServer.register({
      kind: "exact",
      path: "/folder-permissions/grants",
      handler: async (req, res) => {
        const send = (code, body) => {
          res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(body));
        };
        if (!isLoopback(req.socket?.remoteAddress)) return send(403, { ok: false, error: "loopback-only" });

        const url = new URL(req.url ?? "/", "http://localhost");
        const sessionId = url.searchParams.get("session");

        if (req.method === "GET") {
          if (sessionId === null || sessionId === "") return send(400, { ok: false, error: "missing ?session=<id>" });
          return send(200, { ok: true, ...sessionSummary(sessionId), grants: grantsList(store.load(sessionId)), global: globalGrantsList() });
        }

        if (req.method === "POST") {
          let parsed;
          try {
            parsed = JSON.parse((await readBody(req)) || "{}");
          } catch {
            return send(400, { ok: false, error: "invalid JSON body" });
          }
          const { session, action, path, access } = parsed ?? {};
          if (typeof session !== "string" || session === "" || typeof path !== "string" || path === "") {
            return send(400, { ok: false, error: "expected { session, action, path }" });
          }
          if (action === "toggle") {
            toggleGrant(session, path);
            return send(200, { ok: true, ...sessionSummary(session), grants: grantsList(store.load(session)), global: globalGrantsList() });
          }
          if (action !== "grant" && action !== "revoke") {
            return send(400, { ok: false, error: "action must be grant, revoke, or toggle" });
          }
          if (!ACCESSES.includes(access)) {
            return send(400, { ok: false, error: `access must be one of: ${ACCESSES.join(", ")}` });
          }
          mutateGrant(session, path, access, action === "grant");
          return send(200, { ok: true, ...sessionSummary(session), grants: grantsList(store.load(session)), global: globalGrantsList() });
        }

        return send(405, { ok: false, error: "use GET or POST" });
      }
    });
  });

  // "Allow & remember" side effect: when the user answers `allowed-session` on
  // any approval, widen the grant for the rest of the session:
  //   - write/edit: grant the denied file's parent folder (folder-level),
  //   - every other tool (bash/pwsh/…): switch the session to
  //     danger-full-access + never-ask (session-wide).
  // The denied tool is recovered from the paired `approval/asked` + `tool/call`
  // events (by call id). Event appends are deferred a microtask: this listener
  // runs while the `approval/decided` append is still publishing, and a nested
  // `session.append` would trip the session's re-entrancy guard.
  ctx.on("session/event", (session, event) => {
    if (event.type !== "approval/decided" || event.data.outcome !== "allowed-session") return;
    const asked = findApprovalAsked(session.events, event.data.id);
    const callId = asked?.data.callId;
    const toolName = asked?.data.toolName;
    if (callId === undefined) return;

    if (toolName !== "write" && toolName !== "edit") {
      // bash, pwsh, or any other approval: grant session-wide full access.
      queueMicrotask(() => {
        session.append("sandbox/mode", { mode: "danger-full-access" });
        session.append("approval/policy", { policy: "never" });
      });
      return;
    }

    const call = findToolCall(session.events, callId);
    if (call === undefined) return;
    let filePath;
    try {
      const args = JSON.parse(call.data.arguments);
      filePath = typeof args.file_path === "string" ? args.file_path : undefined;
    } catch {
      return;
    }
    if (filePath === undefined || filePath.trim() === "") return;
    grant(session, dirname(resolveAgainstSession(session, filePath)), "write");
  });

  // Deliberately NO `session/disposed` cleanup: a graceful host restart disposes
  // every live session before exit, and deleting the grant file there would
  // lose a session's grants across restart. Grants persist until explicitly
  // revoked (or the file is removed from $DSH_HOME/folder-permissions/); a
  // lingering file for a session that never resumes is harmless — load() starts
  // empty only when the file is absent.
}

export { ACCESSES, apply, canonicalGrantPath, findApprovalAsked, findToolCall, inject, name, resolveAgainstSession };
