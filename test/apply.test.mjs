// dsh-folder-permissions — smoke test for the plugin's apply() against a
// minimal fake Cordis context (no host needed). Verifies the service seam,
// pre-configure, the command surface, the loopback HTTP route, and the store
// round-trip through a temp $DSH_HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, findApprovalAsked, findToolCall, inject, name, resolveAgainstSession } from "../lib/index.js";

function fakeContext(home) {
  const services = new Map();
  const entries = {};
  const listeners = [];
  const ctx = {
    provide(serviceName, service) {
      services.set(serviceName, service);
    },
    get(serviceName) {
      return services.get(serviceName);
    },
    on(event, handler) {
      listeners.push([event, handler]);
      return () => {};
    },
    inject(_deps, cb) {
      const scope = {
        systemPrompt: { context(entry) { entries.systemPrompt = entry; } },
        commands: { register(entry) { entries.command = entry; } },
        webServer: { register(entry) { entries.route = entry; } }
      };
      cb(scope);
    },
    sessions: { list: () => [], get: () => undefined }
  };
  return { ctx, services, listeners, entries };
}

/** Drive one route handler call with a loopback request and capture the JSON response. */
async function callRoute(handler, method, url, body) {
  let result;
  const req = {
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    setEncoding() {},
    on(event, cb) {
      if (event === "data" && body !== void 0 && body !== "") cb(body);
      if (event === "end") cb();
      return this;
    }
  };
  const res = {
    writeHead(code, headers) { result = { code, headers }; },
    end(payload) { result = { ...result, body: JSON.parse(payload) }; }
  };
  await handler(req, res);
  return result;
}

test("apply() provides the folderPermissions seam and grants/revokes a folder", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-fp-apply-"));
  process.env.DSH_HOME = home;
  try {
    const { ctx, services } = fakeContext(home);
    apply(ctx, { allow: { read: [], write: [] } });

    const folderPermissions = services.get("folderPermissions");
    assert.ok(folderPermissions, "folderPermissions service is provided");
    assert.deepEqual(folderPermissions.rootsFor({ id: "s-1" }), { writable: [], readable: [] });

    const session = { id: "s-1" };
    folderPermissions.grant(session, "~/granted-dir", "write");
    const roots = folderPermissions.rootsFor(session);
    assert.equal(roots.writable.length, 1);
    assert.equal(roots.writable[0].startsWith("/"), true);

    folderPermissions.revoke(session, "~/granted-dir", "write");
    assert.deepEqual(folderPermissions.rootsFor(session), { writable: [], readable: [] });
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("apply() pre-configures allow lists on existing sessions without prompting", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-fp-apply-"));
  process.env.DSH_HOME = home;
  try {
    const { ctx, services } = fakeContext(home);
    const session = { id: "s-2" };
    ctx.sessions.list = () => [session];
    apply(ctx, { allow: { read: ["~/readme"], write: ["~/writable"] } });

    const { writable, readable } = services.get("folderPermissions").rootsFor(session);
    assert.equal(writable.length, 1);
    assert.equal(readable.length, 1);
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the loopback HTTP route lists, grants, and revokes by session id", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-fp-route-"));
  process.env.DSH_HOME = home;
  try {
    const { ctx, entries } = fakeContext(home);
    apply(ctx, { allow: { read: [], write: [] } });
    assert.ok(entries.route, "route is registered");
    assert.equal(entries.route.path, "/folder-permissions/grants");
    const handler = entries.route.handler;

    // Empty list.
    const empty = await callRoute(handler, "GET", "/folder-permissions/grants?session=s-9");
    assert.equal(empty.code, 200);
    assert.deepEqual(empty.body, { ok: true, mode: "workspace-write", approval: "ask", grants: [], global: [] });

    // Grant write.
    const granted = await callRoute(handler, "POST", "/folder-permissions/grants",
      JSON.stringify({ session: "s-9", action: "grant", path: "~/route-dir", access: "write" }));
    assert.equal(granted.code, 200);
    assert.equal(granted.body.grants.length, 1);
    assert.equal(granted.body.grants[0].write, true);

    // Revoke write.
    const revoked = await callRoute(handler, "POST", "/folder-permissions/grants",
      JSON.stringify({ session: "s-9", action: "revoke", path: "~/route-dir", access: "write" }));
    assert.equal(revoked.code, 200);
    assert.deepEqual(revoked.body, { ok: true, mode: "workspace-write", approval: "ask", grants: [], global: [] });

    // Reject a bad action.
    const bad = await callRoute(handler, "POST", "/folder-permissions/grants",
      JSON.stringify({ session: "s-9", action: "nope", path: "~/x", access: "write" }));
    assert.equal(bad.code, 400);
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the HTTP route toggles a grant on/off without removing it", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-fp-toggle-"));
  process.env.DSH_HOME = home;
  try {
    const { ctx, entries, services } = fakeContext(home);
    apply(ctx, { allow: { read: [], write: [] }, allowGlobal: { read: [], write: [] } });
    const handler = entries.route.handler;
    const session = { id: "s-9" };

    // Grant write.
    await callRoute(handler, "POST", "/folder-permissions/grants",
      JSON.stringify({ session: "s-9", action: "grant", path: "~/toggle-dir", access: "write" }));

    // Toggle off (still listed, but not enforced).
    const off = await callRoute(handler, "POST", "/folder-permissions/grants",
      JSON.stringify({ session: "s-9", action: "toggle", path: "~/toggle-dir" }));
    assert.equal(off.code, 200);
    assert.equal(off.body.grants.length, 1);
    assert.equal(off.body.grants[0].enabled, false);
    assert.deepEqual(services.get("folderPermissions").rootsFor(session), { writable: [], readable: [] });

    // Toggle back on.
    const on = await callRoute(handler, "POST", "/folder-permissions/grants",
      JSON.stringify({ session: "s-9", action: "toggle", path: "~/toggle-dir" }));
    assert.equal(on.body.grants[0].enabled, true);
    assert.equal(services.get("folderPermissions").rootsFor(session).writable.length, 1);
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("findApprovalAsked / findToolCall scan newest-first by id", () => {
  const events = [
    { type: "tool/call", data: { callId: "c-1", arguments: "{}" } },
    { type: "approval/asked", data: { id: "a-1", callId: "c-1" } },
    { type: "tool/call", data: { callId: "c-2", arguments: "{}" } }
  ];
  assert.equal(findApprovalAsked(events, "a-1").data.callId, "c-1");
  assert.equal(findApprovalAsked(events, "missing"), undefined);
  assert.equal(findToolCall(events, "c-2").data.callId, "c-2");
  assert.equal(findToolCall(events, "missing"), undefined);
});

test("resolveAgainstSession joins relative paths onto the session cwd", () => {
  const session = { header: { cwd: "/w" } };
  assert.equal(resolveAgainstSession(session, "src/a.ts"), "/w/src/a.ts");
  assert.equal(resolveAgainstSession(session, "/abs/a.ts"), "/abs/a.ts");
  assert.equal(resolveAgainstSession(session, "~/code/a.ts"), "~/code/a.ts");
  assert.equal(resolveAgainstSession({ header: {} }, "rel/a.ts"), "rel/a.ts");
});

test("the approval listener grants the parent folder on allowed-session", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-fp-approval-"));
  process.env.DSH_HOME = home;
  try {
    const { ctx, services, listeners } = fakeContext(home);
    apply(ctx, { allow: { read: [], write: [] } });

    const sessionEventListener = listeners.find(([event]) => event === "session/event")?.[1];
    assert.ok(sessionEventListener, "session/event listener is registered");

    const session = {
      id: "s-10",
      header: { cwd: "/home/user/work" },
      events: [
        { type: "tool/call", data: { callId: "call-1", arguments: JSON.stringify({ file_path: "/home/user/work/src/foo.ts" }) } },
        { type: "approval/asked", data: { id: "a-1", callId: "call-1", toolName: "write" } }
      ]
    };
    sessionEventListener(session, { type: "approval/decided", data: { id: "a-1", outcome: "allowed-session" } });

    const { writable } = services.get("folderPermissions").rootsFor(session);
    assert.equal(writable.length, 1);
    assert.equal(writable[0], "/home/user/work/src");
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the approval listener grants session-wide access for bash on allowed-session", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-fp-approval-bash-"));
  process.env.DSH_HOME = home;
  try {
    const { ctx, listeners } = fakeContext(home);
    apply(ctx, { allow: { read: [], write: [] } });

    const sessionEventListener = listeners.find(([event]) => event === "session/event")?.[1];
    assert.ok(sessionEventListener, "session/event listener is registered");

    const session = {
      id: "s-11",
      header: { cwd: "/w" },
      events: [{ type: "approval/asked", data: { id: "a-2", callId: "call-2", toolName: "bash" } }],
      append(type, data) {
        this.events.push({ type, data });
      }
    };
    sessionEventListener(session, { type: "approval/decided", data: { id: "a-2", outcome: "allowed-session" } });
    await Promise.resolve(); // flush the queueMicrotask

    const modes = session.events.filter((e) => e.type === "sandbox/mode").map((e) => e.data.mode);
    const policies = session.events.filter((e) => e.type === "approval/policy").map((e) => e.data.policy);
    assert.deepEqual(modes, ["danger-full-access"]);
    assert.deepEqual(policies, ["never"]);
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the GET route reports global roots separately from session grants", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-fp-global-route-"));
  process.env.DSH_HOME = home;
  try {
    const { ctx, entries } = fakeContext(home);
    apply(ctx, { allow: { read: [], write: [] }, allowGlobal: { read: [], write: ["/global-route-test"] } });
    const handler = entries.route.handler;

    const res = await callRoute(handler, "GET", "/folder-permissions/grants?session=s-30");
    assert.equal(res.code, 200);
    assert.deepEqual(res.body.grants, []);
    assert.deepEqual(res.body.global, [{ path: "/global-route-test", read: false, write: true }]);
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the GET route reports the effective sandbox mode and approval policy", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-fp-summary-"));
  process.env.DSH_HOME = home;
  try {
    const { ctx, entries } = fakeContext(home);
    const session = { id: "s-40", header: { cwd: "/workspace" } };
    ctx.sessions.get = (id) => (id === "s-40" ? session : undefined);
    ctx.provide("sandboxPolicy", { resolve: () => ({ mode: "danger-full-access", workspaceRoot: "/workspace" }) });
    ctx.provide("approval", { config: { policy: "ask" }, effectivePolicy: () => "never" });
    apply(ctx, { allow: { read: [], write: [] }, allowGlobal: { read: [], write: [] } });

    const res = await callRoute(entries.route.handler, "GET", "/folder-permissions/grants?session=s-40");
    assert.equal(res.code, 200);
    assert.equal(res.body.mode, "danger-full-access");
    assert.equal(res.body.approval, "never");
    assert.equal(res.body.workspace, "/workspace");
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("allowGlobal.write roots are enforced for every session and not revocable", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-fp-global-"));
  process.env.DSH_HOME = home;
  try {
    const { ctx, services } = fakeContext(home);
    apply(ctx, { allow: { read: [], write: [] }, allowGlobal: { read: [], write: ["/global-shared-test"] } });

    const folderPermissions = services.get("folderPermissions");
    const session = { id: "s-20" };
    const { writable } = folderPermissions.rootsFor(session);
    assert.equal(writable.length, 1);
    assert.equal(writable[0], "/global-shared-test");

    // Global roots are not part of the per-session grant map (the tab surface).
    assert.deepEqual(folderPermissions.grantsOf(session), {});
  } finally {
    delete process.env.DSH_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("plugin exports the loader contract", () => {
  assert.equal(name, "folder-permissions");
  assert.deepEqual(inject, ["sessions"]);
  assert.equal(typeof apply, "function");
});
