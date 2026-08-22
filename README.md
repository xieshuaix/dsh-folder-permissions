# dsh-folder-permissions

Per-session, per-folder read/write permissions for the DeepSeek Harness.

Implements the "Per-session folder-level read/write permissions" extension:
the sandbox currently exposes one coarse `workspace-write` mode and otherwise
requires a one-shot `danger-full-access` escalation per denied write. This
plugin adds a first-class, per-session, per-folder grant that is remembered
for the session, can be pre-configured, and can be revoked at any time.

## What it does

- **Web session tab** — a self-adaptive `Permissions` tab in the conversation
  view ring (beside Chat/Trajectory/Context) to register and toggle write
  permissions for the current session.
- **"Allow & remember" in the approval popup** — the sandbox-escalation prompt
  gains a third answer beside Reject / Allow once: *Allow & remember this
  session*, which grants the denied file's folder for the session and allows
  the current call.
- **`ctx.folderPermissions`** — the lifecycle service (`grantsOf`, `rootsFor`,
  `grant`, `revoke`) for plugins/agents.
- **`/folder-permissions`** — the slash command: `grant <path> [read|write]`,
  `revoke <path> [read|write]`, `list`.
- **Pre-configure** — the bundle `config.allow.read` / `config.allow.write`
  lists are applied to every new session with no prompt.
- **Remember once granted** — a grant is durable per session (survives restart)
  and is not re-asked.
- **Revoke anytime** — revoking immediately re-blocks further access (once the
  enforcement patch below is applied).

## Web session tab

The client half registers a `Permissions` tab in the `conversation.view` ring
(the same slot Chat/Trajectory/Context use). It joins by `order` only — never a
fixed tab index — so it sits beside whatever other view tabs are mounted. The
tab shows, systematically, everything allowed for the current session:

- the effective **sandbox mode**, **approval policy**, and **workspace root**
  (a read-only summary at the top);
- **inherited global dirs** (from `allowGlobal`, read-only);
- **per-session folder grants** — each with a grant/revoke toggle (toggle off
  revokes but keeps the dir listed, dimmed as "Revoked"; toggle on re-grants),
  plus an input to grant a new folder.

The tab talks to a loopback-only host route (`GET`/`POST
/folder-permissions/grants`) that reads and mutates the same durable grant
store as the command and enforcement, so the tab, the agent command, and the
sandbox fence always agree. It re-fetches after every toggle; no polling, no
custom RPC channel.

## Install

From inside the profile directory (e.g. `$DSH_HOME/profiles/web`):

```sh
dsh plugin --profile web add file:/path/to/dsh-folder-permissions
```

This appends `dsh-folder-permissions` to `dsh.profile.bundles`.

## Making grants actually gate writes (one-time core patch)

Grant management needs no core change. **Honoring** the grants does, because
the `workspace-write` boundary is enforced in two core packages that a plugin
cannot reach from outside:

- `@deepseek-ai/dsh-sandbox` — `writableRoots()` derives the allow-list from
  `SandboxExecutionPolicy` (workspace root + temp dirs only).
- `@deepseek-ai/dsh-sandbox-policy` — `resolve()` stamps the mode + workspace
  root onto each call.

`scripts/patch-core.mjs` applies the two minimal, additive edits that make the
fence consult `ctx.folderPermissions`:

```sh
node scripts/patch-core.mjs --checkout /path/to/@deepseek-ai/dsh
```

then restart the host once. The patch is backward compatible: with no plugin
mounted, the resolved policy is unchanged, and no existing session is affected
(fail-closed — nothing becomes more permissive on its own).

Without the patch, the plugin still records and surfaces grants but does not
widen the write boundary.

## "Allow & remember" in the approval popup (second core patch)

The shipped sandbox-escalation approval prompt offers only Reject / Allow once.
Adding the folder-level *Allow & remember this session* answer needs one more
one-time core patch, because the approval outcome vocabulary and the shipped
approval panel are compiled core packages:

```sh
node scripts/patch-approval.mjs --checkout /path/to/@deepseek-ai/dsh
```

then restart the host once. It extends the closed `ApprovalOutcome` vocabulary
with `allowed-session`, maps it in `approveEscalation` (allow the current call),
and adds a third *Allow & remember* button to the shipped approval panel. The
button now appears for **every** approval prompt. The plugin's host half listens
for the `allowed-session` decision and, by tool:

- `write`/`edit` — grants the denied file's **parent folder** for the session,
  so later writes to that folder no longer prompt (folder-level).
- any other tool (`bash`, `pwsh`, …) — switches the session to
  **`danger-full-access` + `approval: never`** (session-wide; there is no single
  folder in a shell command).

## Config

All optional (bundle patch `config`):

| field                    | default | meaning                                                             |
| ------------------------ | ------- | ------------------------------------------------------------------- |
| `allow.read`             | `[]`    | folders granted read access for every new session (stored per-session, revocable) |
| `allow.write`            | `[]`    | folders granted write access for every new session (stored per-session, revocable) |
| `allowGlobal.read`       | `[]`    | folders allowed read access for EVERY session, not revocable per-session |
| `allowGlobal.write`      | `[]`    | folders allowed write access for EVERY session, not revocable per-session |

All accept a leading `~` for the user home. `allow` grants land in the
per-session store (so they appear in, and can be toggled from, the Permissions
tab); `allowGlobal` roots are enforced directly by the fence for every session
and never appear as per-session toggles.

## Storage

Grants live in `$DSH_HOME/folder-permissions/<session-id>.json` (atomic
temp-file + rename). They are deliberately **not** session-log events: the
harness's session-event vocabulary is closed to in-repo packages, and a
downstream plugin adding a durable required event type would make granted
sessions unloadable by any harness without this plugin. A sidecar file keeps
the same durability and per-session isolation with zero core coupling.

Grants persist across a host restart (a graceful restart disposes sessions, so
the files are intentionally *not* cleaned on dispose). Revoking removes a path
from the file; a file for a session that never resumes is harmless and can be
removed manually.

## Scope / limitations (v1)

- **Reads are currently unrestricted** across every sandbox mode, so `read`
  grants are recorded and surfaced but do not change enforcement today. They
  exist for symmetry and for a future read-fenced mode.
- Extra **writable** roots are honored by the in-process filesystem fence
  (write/edit tools) and by the macOS Seatbelt bash backend, both of which
  derive their allow-list from the shared `writableRoots()` helper. The Linux
  bwrap/Landlock bash dialects keep their own grant spellings and do not yet
  include extra roots (a pre-existing parity gap, not a regression).
- Grants widen access only under the `workspace-write` mode. Under `read-only`
  every write is still denied, and under `danger-full-access` nothing needs
  granting.
- The "harness asks once on first denial" flow is currently expressed as the
  `/folder-permissions grant` command plus the model-facing grant context, not
  an automatic in-denial prompt (that needs a hook inside the compiled
  write/edit tool layer, deferred to a later increment).

## Tests

```sh
npm test          # or: node --test test/*.test.mjs
```
