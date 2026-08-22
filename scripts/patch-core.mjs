#!/usr/bin/env node
// dsh-folder-permissions — one-time core enforcement patch.
//
// The plugin alone records and surfaces folder grants but cannot widen the
// filesystem fence's `workspace-write` boundary: that fence (`writableRoots`)
// and the per-call policy resolver (`sandboxPolicy.resolve`) live in core
// packages that are already loaded into a running host.
//
// This script applies the two minimal, additive core edits that let the fence
// HONOR granted folders, by consulting `ctx.folderPermissions` (provided by the
// plugin) at policy-resolution time. The edits are backward compatible: with no
// plugin mounted, `ctx.get("folderPermissions")` returns undefined and the
// resolved policy is byte-for-byte what it was before.
//
// Usage:
//   node scripts/patch-core.mjs --checkout /path/to/@deepseek-ai/dsh
// (or set DSH_CHECKOUT). Idempotent: re-running reports "already patched".
//
// Apply it, then restart the host ONCE (the running host keeps the modules it
// already imported, so the patch takes effect only on the next boot).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function fail(message) {
  console.error(`patch-core: ${message}`);
  process.exit(1);
}

const checkout = process.argv.includes("--checkout")
  ? process.argv[process.argv.indexOf("--checkout") + 1]
  : process.env.DSH_CHECKOUT;

if (checkout === void 0 || checkout === "") {
  fail("no checkout path; pass --checkout <path> or set DSH_CHECKOUT");
}

// Each patch: [packageDir, relativeFile, oldText, newText, alreadyPatchedMarker].
const PATCHES = [
  [
    "@deepseek-ai/dsh-sandbox",
    "lib/index.js",
    [
      "\treturn [...new Set([",
      "\t\tpolicy.workspaceRoot,",
      "\t\t\"/tmp\",",
      "\t\ttmpdir()",
      "\t].map(canonicalPath))];"
    ].join("\n"),
    [
      "\treturn [...new Set([",
      "\t\tpolicy.workspaceRoot,",
      "\t\t...(policy.extraWritableRoots ?? []),",
      "\t\t\"/tmp\",",
      "\t\ttmpdir()",
      "\t].map(canonicalPath))];"
    ].join("\n"),
    "policy.extraWritableRoots ?? []"
  ],
  [
    "@deepseek-ai/dsh-sandbox",
    "lib/types/index.d.ts",
    [
      "    /** Absolute root directory `workspace-write` may write under. */",
      "    workspaceRoot: string;"
    ].join("\n"),
    [
      "    /** Absolute root directory `workspace-write` may write under. */",
      "    workspaceRoot: string;",
      "    /**",
      "     * Extra folders this call may write under, beyond the workspace root and",
      "     * platform temp areas (per-session folder grants; canonical absolute",
      "     * paths). Consumed by {@link writableRoots}; absent when no grants apply.",
      "     */",
      "    extraWritableRoots?: readonly string[];",
      "    /**",
      "     * Extra folders this call may read, tracked for symmetry with write grants.",
      "     * Reads are currently unrestricted, so these do not change enforcement.",
      "     */",
      "    extraReadableRoots?: readonly string[];"
    ].join("\n"),
    "extraWritableRoots?: readonly string[];"
  ],
  [
    "@deepseek-ai/dsh-sandbox-policy",
    "lib/index.js",
    [
      "\tresolve(request = {}) {",
      "\t\tconst { session } = request;",
      "\t\treturn {",
      "\t\t\tmode: request.mode ?? (session === void 0 ? void 0 : this.overrideOf(session)) ?? this.defaultMode,",
      "\t\t\tworkspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),",
      "\t\t\t...session === void 0 ? {} : { sessionId: session.id }",
      "\t\t};",
      "\t}"
    ].join("\n"),
    [
      "\tresolve(request = {}) {",
      "\t\tconst { session } = request;",
      "\t\tconst folderPermissions = this.ctx.get(\"folderPermissions\");",
      "\t\tconst extra = session === void 0 || folderPermissions === void 0 ? { writable: [], readable: [] } : folderPermissions.rootsFor(session);",
      "\t\treturn {",
      "\t\t\tmode: request.mode ?? (session === void 0 ? void 0 : this.overrideOf(session)) ?? this.defaultMode,",
      "\t\t\tworkspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),",
      "\t\t\t...extra.writable.length > 0 ? { extraWritableRoots: extra.writable } : {},",
      "\t\t\t...extra.readable.length > 0 ? { extraReadableRoots: extra.readable } : {},",
      "\t\t\t...session === void 0 ? {} : { sessionId: session.id }",
      "\t\t};",
      "\t}"
    ].join("\n"),
    'this.ctx.get("folderPermissions")'
  ]
];

let changedCount = 0;
for (const [pkg, rel, oldText, newText, marker] of PATCHES) {
  const file = join(checkout, "node_modules", pkg, rel);
  if (!existsSync(file)) fail(`missing file: ${file}`);
  const content = readFileSync(file, "utf8");
  if (content.includes(marker)) {
    console.log(`already patched: ${pkg}/${rel}`);
    continue;
  }
  if (!content.includes(oldText)) {
    fail(`target not found in ${file} — this checkout's build differs; patch manually or upgrade the plugin`);
  }
  writeFileSync(file, content.replace(oldText, newText));
  changedCount += 1;
  console.log(`patched: ${pkg}/${rel}`);
}

console.log(changedCount === 0 ? "no changes needed" : `patched ${changedCount} file(s); restart the host to load them`);
