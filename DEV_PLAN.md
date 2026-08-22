# dsh-folder-permissions — Dev Plan / TODO

Scratch log of what's shipped, what's blocked, and what's still open. Keep this
file updated so a later session doesn't have to re-derive state.

## State snapshot

- Plugin built and installed into `~/.dsh/profiles/web/` (bundles + node_modules).
- `allowGlobal.write` configured in the profile's `cordis.patch.yml` as
  `["~/code", "~/.dsh"]`.
- Core patches applied **on disk** to the checkout
  (`/Users/xs/.nvm/versions/node/v24.14.0/lib/node_modules/@deepseek-ai/dsh`):
  - `scripts/patch-core.mjs` — enforcement: `dsh-sandbox` `writableRoots()` +
    `SandboxExecutionPolicy.extraWritableRoots`; `dsh-sandbox-policy.resolve()`
    consults `ctx.folderPermissions.rootsFor(session)`.
  - `scripts/patch-approval.mjs` — "Allow & remember": `dsh-user-approval`
    outcome vocabulary, `dsh-sandbox` `approveEscalation`, `dsh-client-ui-conversation`
    popup button, `dsh-client-connection` respond gate + schemas,
    `dsh-host-apiproxy` response/resolved schemas.
- **All verified working** after a host restart (user confirmed). Client bundles
  are served live from disk (browser refresh is enough); host-side changes need
  a restart.

## Done / verified

- [x] Restart `dsh web` and load all on-disk patches.
- [x] Permissions tab shows the session summary (sandbox mode / approval policy /
      workspace) + global dirs (read-only "Global (inherited)") + per-session
      grants ("Granted in this session") with clear section headings.
- [x] "Allow & remember" button works for every approval type: `write`/`edit`
      grants the file's parent folder; any other tool (`bash`/`pwsh`/…) switches
      the session to `danger-full-access` + `approval: never`.
- [x] Enforcement: granted folders (global + per-session) widen the
      `workspace-write` fence; the folder grant is remembered for the session.
- [x] Per-session grant toggle: toggling off revokes the dir but keeps it listed
      (dimmed, "Revoked"); toggling on re-grants. The separate Revoke button was
      removed so grants never vanish from the tab.

## Later / follow-ups

- [ ] **Global roots for agentless calls** — `allowGlobal` roots only apply to
      agent calls (`rootsFor(session)`); agentless calls still fall back to the
      core's single `workspaceRoot`. Extend `sandbox-policy.resolve()` to consult
      `folderPermissions` even without a session if this matters.
- [ ] **`read` grants are recorded but not enforced** — reads are unrestricted
      in every sandbox mode today; a read-fenced mode would need enforcement
      changes.
- [ ] **bwrap/Landlock bash parity** — extra writable roots are honored by the
      fs fence and the macOS Seatbelt backend only; the Linux bwrap/Landlock
      profile builders keep their own grant spellings and don't include extra
      roots yet.

## Config reminder

- `allow.read` / `allow.write` — per-session pre-grants (applied at session
  start; appear in the tab and are toggleable/revocable).
- `allowGlobal.read` / `allowGlobal.write` — deployment-wide roots, enforced for
  every session, NOT toggleable from the tab.
