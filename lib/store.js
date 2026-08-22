// dsh-folder-permissions — the durable per-session grant store.
//
// Grants live OUTSIDE the session event log so this plugin stays a
// self-contained, out-of-repo package. The harness's session-event vocabulary
// (`KNOWN_SESSION_EVENT_TYPES`) is closed to in-repo packages by construction:
// a downstream plugin adding a durable required event type would make granted
// sessions unloadable by any harness that does not ship this plugin. A
// per-session JSON file under `$DSH_HOME/folder-permissions/` gives the same
// guarantees the event log would — durable across restart, isolated per
// session — with no core coupling.
//
// Enforcement consumes `rootsFor(session)` via `ctx.folderPermissions`; the
// optional core patch (`scripts/patch-core.mjs`) is the only core change, and
// the plugin degrades to a grants registry + command when that patch is not
// applied.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Every folder-grant access kind. */
export const ACCESSES = ["read", "write"];

/** Expand a leading `~` to the user home; other paths pass through untouched. */
export function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * Canonicalize a grant path the way enforcement compares paths: realpath
 * (symlinks resolved) then an absolute lexical resolve. A missing path keeps
 * its as-spelled absolute form — a missing grant matches nothing until it
 * exists, which is the fail-closed outcome.
 */
export function canonicalGrantPath(path) {
  const absolute = resolve(expandHome(path));
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/** The empty folded grant state. */
export function emptyGrants() {
  return {};
}

/**
 * Fold an ordered list of grant operations into a `{ [canonicalPath]: flags }`
 * map. Each op sets or clears one access flag on its (canonicalized) path; the
 * last op per (path, access) wins, and a path whose flags are both cleared
 * drops out. Replay needs no catch-up state.
 *
 * @param {Array<{ path: string, access: "read" | "write", granted: boolean }>} ops
 * @param {Record<string, { read: boolean, write: boolean }>} [initial]
 */
export function foldGrants(ops, initial = emptyGrants()) {
  const grants = { ...initial };
  for (const op of ops) {
    const canonical = canonicalGrantPath(op.path);
    const entry = grants[canonical] ?? { read: false, write: false };
    entry[op.access] = op.granted === true;
    if (entry.read || entry.write) grants[canonical] = entry;
    else delete grants[canonical];
  }
  return grants;
}

/** Flatten a folded grants map into the wire-friendly list the FE tab renders. */
export function grantsList(grants) {
  return Object.entries(grants).map(([path, flags]) => ({
    path,
    read: flags.read === true,
    write: flags.write === true,
    enabled: flags.enabled !== false
  }));
}

/**
 * Split a folded grants map into the writable/readable root lists enforcement
 * consumes. Entries with `enabled: false` are toggled off — they stay listed in
 * the tab but are not enforced.
 */
export function rootsOf(grants) {
  const writable = [];
  const readable = [];
  for (const [path, flags] of Object.entries(grants)) {
    if (flags.enabled === false) continue;
    if (flags.write) writable.push(path);
    if (flags.read) readable.push(path);
  }
  return { writable, readable };
}

/**
 * Merge a list of configured paths into grants under one access kind. Returns
 * the SAME reference when nothing changes, so callers can persist only on a
 * real change; never mutates the input grants.
 */
export function mergeConfigured(grants, paths, access) {
  let next = grants;
  for (const path of paths) {
    const canonical = canonicalGrantPath(path);
    const prev = next[canonical] ?? { read: false, write: false };
    if (prev[access] === true) continue;
    if (next === grants) next = { ...grants };
    next[canonical] = { ...prev, [access]: true };
  }
  return next;
}

/**
 * A durable, per-session grant store under `rootDir`. Loads lazily (cached in
 * memory per session id) and writes atomically (temp file + rename) so a crash
 * mid-save never corrupts an existing grant file.
 *
 * @param {string} rootDir - directory that holds one `<sessionId>.json` per session.
 */
export function createGrantStore(rootDir) {
  const cache = new Map();

  function fileFor(sessionId) {
    return join(rootDir, `${sessionId}.json`);
  }

  function load(sessionId) {
    const key = String(sessionId);
    if (cache.has(key)) return cache.get(key);
    let grants = emptyGrants();
    const file = fileFor(key);
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (parsed && typeof parsed === "object" && parsed.grants && typeof parsed.grants === "object") {
          grants = parsed.grants;
        }
      } catch {
        // A corrupt/unreadable file starts empty — grants are re-created, never guessed.
      }
    }
    cache.set(key, grants);
    return grants;
  }

  function save(sessionId, grants) {
    const key = String(sessionId);
    mkdirSync(rootDir, { recursive: true });
    const file = fileFor(key);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, grants }, null, 2));
    renameSync(tmp, file);
    cache.set(key, grants);
  }

  function drop(sessionId) {
    const key = String(sessionId);
    cache.delete(key);
    try {
      rmSync(fileFor(key), { force: true });
    } catch {
      // Best-effort cleanup; a lingering file is harmless (load() starts empty).
    }
  }

  return { fileFor, load, save, drop };
}
