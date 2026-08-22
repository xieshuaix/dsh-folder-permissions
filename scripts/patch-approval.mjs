#!/usr/bin/env node
// dsh-folder-permissions — one-time core patch: "allow & remember this session"
// in the approval popup.
//
// The sandbox-escalation approval popup ships with two answers: `rejected` and
// `allowed-once`. This patch adds a third, `allowed-session`, that lets the user
// allow the current call AND remember the folder for the rest of the session:
//   - `dsh-user-approval`  — extend the closed outcome vocabulary.
//   - `dsh-sandbox`        — `approveEscalation` maps `allowed-session` to a
//                            grant (same as `allowed-once`; the folder grant is
//                            a side effect handled by the plugin's host half).
//   - `dsh-client-ui-conversation` — add the "Allow & remember" button to the
//                            shipped approval panel (shown for write/edit).
//
// Usage:
//   node scripts/patch-approval.mjs --checkout /path/to/@deepseek-ai/dsh
// Idempotent: re-running reports "already patched".
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function fail(message) {
  console.error(`patch-approval: ${message}`);
  process.exit(1);
}

const checkout = process.argv.includes("--checkout")
  ? process.argv[process.argv.indexOf("--checkout") + 1]
  : process.env.DSH_CHECKOUT;

if (checkout === void 0 || checkout === "") {
  fail("no checkout path; pass --checkout <path> or set DSH_CHECKOUT");
}

// [pkg, relFile, oldText, newText, alreadyPatchedMarker, replaceAll]
const PATCHES = [
  [
    "@deepseek-ai/dsh-user-approval",
    "lib/index.js",
    '\t"allowed-once",\n\t"rejected",',
    '\t"allowed-once",\n\t"allowed-session",\n\t"rejected",',
    '"allowed-session"',
    false
  ],
  [
    "@deepseek-ai/dsh-user-approval",
    "lib/invariant.js",
    '\t"allowed-once",\n\t"rejected",',
    '\t"allowed-once",\n\t"allowed-session",\n\t"rejected",',
    '"allowed-session"',
    true
  ],
  [
    "@deepseek-ai/dsh-sandbox",
    "lib/index.js",
    '\t\tcase "allowed-once": return mode;',
    '\t\tcase "allowed-once": return mode;\n\t\tcase "allowed-session": return mode;',
    'case "allowed-session"',
    false
  ],
  [
    "@deepseek-ai/dsh-client-ui-conversation",
    "lib/client.js",
    '\t\t\t"approval.allowOnce": "允许一次",',
    '\t\t\t"approval.allowOnce": "允许一次",\n\t\t\t"approval.allowSession": "允许并记住本会话",',
    '"允许并记住本会话"',
    false
  ],
  [
    "@deepseek-ai/dsh-client-ui-conversation",
    "lib/client.js",
    '\t\t\t"approval.allowOnce": "Allow once",',
    '\t\t\t"approval.allowOnce": "Allow once",\n\t\t\t"approval.allowSession": "Allow & remember",',
    '"Allow & remember"',
    false
  ],
  [
    "@deepseek-ai/dsh-client-ui-conversation",
    "lib/client.js",
    '\t\t\t\t\t\t\t\tchildren: t("approval.allowOnce")\n\t\t\t\t\t\t\t})]',
    '\t\t\t\t\t\t\t\tchildren: t("approval.allowOnce")\n' +
    '\t\t\t\t\t\t\t}), pending.toolName === "write" || pending.toolName === "edit" ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {\n' +
    '\t\t\t\t\t\t\t\tvariant: "primary",\n' +
    '\t\t\t\t\t\t\t\tdisabled: answered,\n' +
    '\t\t\t\t\t\t\t\tonClick: () => {\n' +
    '\t\t\t\t\t\t\t\t\tanswer("allowed-session");\n' +
    '\t\t\t\t\t\t\t\t},\n' +
    '\t\t\t\t\t\t\t\tchildren: t("approval.allowSession")\n' +
    '\t\t\t\t\t\t\t}) : null]',
    'answer("allowed-session")',
    false
  ],
  // Wire schemas + gates that also carry the closed outcome vocabulary. The
  // client-side respond gate rejects any outcome outside ["allowed-once",
  // "rejected"] BEFORE it ever reaches the host, so this is the actual reason
  // the "Allow & remember" button was a no-op.
  [
    "@deepseek-ai/dsh-client-connection",
    "lib/client.js",
    'outcome: union([literal("allowed-once"), literal("rejected")])',
    'outcome: union([literal("allowed-once"), literal("allowed-session"), literal("rejected")])',
    'literal("allowed-once"), literal("allowed-session")',
    false
  ],
  [
    "@deepseek-ai/dsh-client-connection",
    "lib/client.js",
    '\t\t\t\t\tliteral("allowed-once"),\n\t\t\t\t\tliteral("rejected"),',
    '\t\t\t\t\tliteral("allowed-once"),\n\t\t\t\t\tliteral("allowed-session"),\n\t\t\t\t\tliteral("rejected"),',
    '\t\t\t\t\tliteral("allowed-session"),',
    false
  ],
  [
    "@deepseek-ai/dsh-client-connection",
    "lib/client.js",
    'value.outcome !== "allowed-once" && value.outcome !== "rejected"',
    'value.outcome !== "allowed-once" && value.outcome !== "allowed-session" && value.outcome !== "rejected"',
    'value.outcome !== "allowed-session"',
    false
  ],
  [
    "@deepseek-ai/dsh-host-apiproxy",
    "lib/index.js",
    'outcome: z$1.union([z$1.literal("allowed-once"), z$1.literal("rejected")])',
    'outcome: z$1.union([z$1.literal("allowed-once"), z$1.literal("allowed-session"), z$1.literal("rejected")])',
    'z$1.literal("allowed-once"), z$1.literal("allowed-session")',
    false
  ],
  [
    "@deepseek-ai/dsh-host-apiproxy",
    "lib/index.js",
    '\t\t\tz$1.literal("allowed-once"),\n\t\t\tz$1.literal("rejected"),',
    '\t\t\tz$1.literal("allowed-once"),\n\t\t\tz$1.literal("allowed-session"),\n\t\t\tz$1.literal("rejected"),',
    '\t\t\tz$1.literal("allowed-session"),',
    false
  ],
  [
    "@deepseek-ai/dsh-host-apiproxy",
    "lib/types/api/approvals.schema.js",
    "outcome: z.union([z.literal('allowed-once'), z.literal('rejected')]),",
    "outcome: z.union([z.literal('allowed-once'), z.literal('allowed-session'), z.literal('rejected')]),",
    "z.literal('allowed-session')",
    false
  ],
  [
    "@deepseek-ai/dsh-host-apiproxy",
    "lib/types/api/events.schema.js",
    "outcome: z.union([z.literal('allowed-once'), z.literal('rejected'), z.literal('cancelled'), z.literal('unavailable')])",
    "outcome: z.union([z.literal('allowed-once'), z.literal('allowed-session'), z.literal('rejected'), z.literal('cancelled'), z.literal('unavailable')])",
    "z.literal('allowed-session')",
    false
  ]
];

let changedCount = 0;
for (const [pkg, rel, oldText, newText, marker, replaceAll] of PATCHES) {
  const file = join(checkout, "node_modules", pkg, rel);
  if (!existsSync(file)) fail(`missing file: ${file}`);
  const content = readFileSync(file, "utf8");
  if (content.includes(marker)) {
    console.log(`already patched: ${pkg}/${rel}`);
    continue;
  }
  if (!content.includes(oldText)) {
    fail(`target not found in ${file} — this checkout's build differs; patch manually or upgrade`);
  }
  writeFileSync(file, replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText));
  changedCount += 1;
  console.log(`patched: ${pkg}/${rel}`);
}

console.log(changedCount === 0 ? "no changes needed" : `patched ${changedCount} file(s); restart the host to load them`);
