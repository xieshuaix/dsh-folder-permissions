// dsh-folder-permissions — unit tests for the pure grant-store logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCESSES,
  canonicalGrantPath,
  createGrantStore,
  emptyGrants,
  expandHome,
  foldGrants,
  grantsList,
  mergeConfigured,
  rootsOf
} from "../lib/store.js";

test("ACCESSES is the closed read/write vocabulary", () => {
  assert.deepEqual(ACCESSES, ["read", "write"]);
});

test("expandHome expands a leading ~ and leaves other paths alone", () => {
  assert.equal(expandHome("~/code/dsh"), join(process.env.HOME ?? "/", "code/dsh"));
  assert.equal(expandHome("/abs/path"), "/abs/path");
  assert.equal(expandHome("relative/path"), "relative/path");
});

test("canonicalGrantPath resolves symlinks and makes paths absolute", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-fp-"));
  const real = join(dir, "real");
  const link = join(dir, "link");
  mkdirSync(real);
  try {
    // A missing path keeps its as-spelled absolute form (fail-closed).
    const missing = join(dir, "nope");
    assert.equal(canonicalGrantPath(missing), missing);
    // A symlink canonicalizes to its target (both spellings collapse to one).
    symlinkSync(real, link);
    assert.equal(canonicalGrantPath(link), canonicalGrantPath(real));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("foldGrants: last op per (path, access) wins and cleared paths drop out", () => {
  const grants = foldGrants([
    { path: "/a", access: "write", granted: true },
    { path: "/a", access: "read", granted: true },
    { path: "/b", access: "write", granted: true },
    { path: "/b", access: "write", granted: false },
    { path: "/c", access: "write", granted: true },
    { path: "/c", access: "write", granted: true }
  ]);
  const keyA = canonicalGrantPath("/a");
  const keyC = canonicalGrantPath("/c");
  assert.deepEqual(Object.keys(grants).sort(), [keyA, keyC].sort());
  assert.deepEqual(grants[keyA], { read: true, write: true });
  assert.deepEqual(grants[keyC], { read: false, write: true });
  assert.equal(keyC in grants, true);
  assert.equal(canonicalGrantPath("/b") in grants, false);
});

test("rootsOf splits a folded map into writable/readable lists", () => {
  const grants = {
    "/w": { read: false, write: true },
    "/r": { read: true, write: false },
    "/both": { read: true, write: true }
  };
  assert.deepEqual(rootsOf(grants), {
    writable: ["/w", "/both"],
    readable: ["/r", "/both"]
  });
});

test("rootsOf skips toggled-off (enabled:false) entries; grantsList carries enabled", () => {
  const grants = {
    "/on": { read: false, write: true },
    "/off": { read: false, write: true, enabled: false }
  };
  assert.deepEqual(rootsOf(grants), { writable: ["/on"], readable: [] });

  const list = grantsList(grants);
  const on = list.find((g) => g.path === "/on");
  const off = list.find((g) => g.path === "/off");
  assert.equal(on.enabled, true);
  assert.equal(off.enabled, false);
});

test("mergeConfigured adds access flags idempotently", () => {
  const base = { "/x": { read: false, write: true } };
  const merged = mergeConfigured(base, ["/x", "/y"], "read");
  assert.deepEqual(merged, {
    "/x": { read: true, write: true },
    "/y": { read: true, write: false }
  });
});

test("createGrantStore round-trips load/save/drop with atomic rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-fp-store-"));
  try {
    const store = createGrantStore(dir);
    const grants = { "/granted": { read: false, write: true } };
    store.save("session-1", grants);
    assert.deepEqual(store.load("session-1"), grants);
    assert.deepEqual(store.load("missing"), emptyGrants());

    // Corrupt file -> empty start (fail closed).
    writeFileSync(join(dir, "session-bad.json"), "{ not json", "utf8");
    assert.deepEqual(store.load("session-bad"), emptyGrants());

    store.drop("session-1");
    assert.deepEqual(store.load("session-1"), emptyGrants());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
