# AGENTS.md

Guidance for coding agents working in this repository. If a gitignored `AGENTS.local.md` exists beside this file, read it too: it holds machine-local notes.

## What This Is

Obsidian community plugin that integrates with Perforce (Helix Core). Checks out a tracked file on its first edit, auto-reverts it on switch/close if unchanged, and runs `p4 add`/`delete`/`move` through vault file lifecycle events. Native delete is intercepted so tracked files are staged for delete (`p4 delete -k`) and kept on disk, shown red, until the delete is submitted. While the server is involuntarily unreachable or the login has expired, fail-closed guards keep managed files from diverging from the depot. Desktop-only: relies on Node's `child_process` to shell out to the `p4` CLI.

## Commands

- `npm run dev` — esbuild watch mode, emits `main.js` with inline sourcemaps.
- `npm run build` — type-check (`tsc -noEmit`) then esbuild production bundle (minified, no sourcemap).

There is no test suite and no linter. Validation is type-check + manual testing inside an Obsidian vault.

Install locally by copying `main.js` + `manifest.json` into `<vault>/.obsidian/plugins/obsidian-p4/` and toggling the plugin in Obsidian's community-plugins settings.

## Architecture

Three files in `src/`, bundled into a single `main.js` (CommonJS, es2018). `obsidian` and all `@codemirror/*` / `@lezer/*` modules are marked external — they're provided by the Obsidian runtime.

- **`src/main.ts`** — `P4Plugin` (the `Plugin` subclass Obsidian loads) plus `P4LoginModal`. Owns all state and wires Obsidian events to P4 actions.
- **`src/p4.ts`** — Thin async wrappers around `p4 <cmd>` via `execAsync` (10 s timeout). Action wrappers (`p4Edit`, `p4Add`, `p4Delete`, …) fire and return nothing; what actually stuck is read back through `p4Opened` / `p4Have` by `reconcile`. `p4Fstat` parses `... <field> <value>` lines, and keys `tracked` off `haveRev`, so a depot record with no synced revision (deleted at head, never synced) reads as untracked, matching `p4 have`. `runP4` turns auth-failure stderr (`isAuthFailure`) into a `P4AuthError`.
- **`src/settings.ts`** — Settings tab + `P4PluginSettings` shape. Two connection modes: `.p4config` (default) or manual `P4PORT`/`P4CLIENT`/`P4USER`.

### Key behaviors to preserve

- **Path resolution**: vault paths are joined with `vault.adapter.getBasePath()` and run through `realpathSync` so symlinked vaults resolve to the depot-mapped real path before being handed to `p4`. See `P4Plugin.resolveRealPath` / `absPath`.
- **Checkout on first edit**: the `editor-change` event (every content edit) drives `ensureCheckedOut`. Opening a file never checks it out; a tracked file stays read-only (muted "tracked" bar) until the user changes it, so reading sessions and agents browsing docs don't churn the pending changelist. Keep checkout out of `onFileOpen`. `ensureCheckedOut` gates on the read-only bit (`accessSync(..., W_OK)` fails): that's both "P4 hasn't already unlocked it" and the keystroke-storm guard, since every keystroke after the first finds the file writable. It then does a synchronous `chmod +w` (so Obsidian's imminent debounced autosave lands on a writable file) and an async `checkoutForEdit`: fstat → `p4 edit` → `reconcile`. If the edit doesn't land (server rejected it, file not really tracked), `checkoutForEdit` re-locks the file via `makeReadOnly` so a failed checkout fails the save loudly rather than diverging silently.
- **Backlink pre-checkout on rename**: before Obsidian rewrites wikilinks in files that link to a renamed note, `checkoutBacklinks` finds them through `metadataCache.resolvedLinks` (still pre-rename at that point) and `preCheckoutBacklink` uses the same sync-chmod-then-async-`p4 edit` shape, then schedules a revert-if-unchanged 5 s later for links the user declined to update.
- **Auto-revert on switch**: `onFileOpen` only calls `revertIfUnchanged` on the *previous* file (`p4 revert -a`). Since only edited files are ever open, this catches the edited-then-undone case and keeps the pending changelist clean.
- **`.obsidian/` and `.trash/` are always ignored** via `shouldHandle`.
- **Rename logic** (`handleFileRename`) branches on fstat: `openedForAdd` → revert + re-add; `tracked` → `p4 move` (preceded by a `p4 edit` of the source inside `p4Move`; the new path is chmodded writable because `move -k` skips the workspace); otherwise → `p4 add`.
- **Sidebar status bars**: a single left-edge bar (CSS `box-shadow: inset` on the title row, injected via a `<style>` element) encodes each file's P4 status; the title text keeps its theme color. Classes `p4-tracked` / `p4-edit` / `p4-add` / `p4-delete` map to muted / accent / green / red, toggled on the file-explorer `fileItems[path].el` (private Obsidian API cast through `any`). Two source maps, both written *only* by `reconcile()`: `fileStates: Map<vaultPath, "edit"|"add"|"delete">` (from `p4 opened`) and `trackedFiles: Set<vaultPath>` (from `p4 have`). `barFor(path)` resolves the displayed class — open state wins over plain `tracked`. `applyBar` writes the class; `reconcile` skips the DOM write when `barFor` is unchanged; `layout-change` → `refreshExplorerColors` reapplies all bars when the explorer re-renders. `p4Opened` maps `delete`/`move/delete` to the `delete` state.
- **Submitted-delete cleanup**: when `reconcile` sees a staged delete lose its bar, `cleanupSubmittedDelete` confirms by fstat that the depot head is a deletion and the file has no have-rev before trashing the kept `-k` copy. The signal is positive, never inferred from absence in a query that may have failed. A reverted delete keeps its have-rev and stays. Removal goes to the vault's `.trash` or the system trash per the user's "Deleted files" preference, never a permanent delete.
- **Context menu** (`buildFileMenu` on the `file-menu` event): a Perforce section (`setSection("perforce")`) built synchronously from the cached maps so items show only when they apply — *Add to Perforce* (untracked), *Revert* (any open state; restores a staged deletion, drops an add, or — with a `confirm()` — discards an edit), *Mark for delete* (tracked, not already marked). Folder variants recurse via `collectFiles`. The workspace file is kept in every case; `menuAdd`/`menuRevert` reconcile the touched paths afterward.
- **Native delete interception** (`patchDeletePrompt`): `app.fileManager.promptForDeletion` (a public API, the funnel for explorer Delete, the "Delete current file" command, and its hotkey) is wrapped on load and restored on unload. When connected, a tracked depot file is staged with `p4 delete -k` (workspace copy kept → stays visible, colored red) and the wrapper returns `false` so Obsidian doesn't remove it; `revert -k` precedes the delete if the file was open for edit. Add-pending, untracked, and ignored files fall through to Obsidian's normal delete. Folders are walked (`collectFiles`): tracked children are staged and kept, others untouched; a folder with no tracked children falls through to a normal delete. If a p4 call throws, the file is left in place with a notice. `onFileDelete` is the fallback for programmatic deletes that bypass the funnel; it reverts an open-for-edit file before `p4 delete`.
- **Connection state**: `connectionStatus` is one of `connected` / `unreachable` / `expired` / `offline`, written only by `setConnectionState`, which derives the `serverAvailable` gate and renders the status-bar dot (green / red / grey). `checkServer` runs `p4 info`, then a full `reconcile`; a `P4AuthError` there marks the session `expired`. It runs on load, on settings save, on window focus while down, and from the Reconnect command. A 30 s `heartbeat` (focused window only) runs `p4 login -s` while connected and `checkServer` while down. Window focus while connected runs a full `reconcile` to pick up changes made outside Obsidian. Clicking the status bar offers Work offline, Reconnect, or Log in; Log in opens `P4LoginModal` and `p4Login` hands the password to `p4 login` on stdin, never storing it.
- **Fail-closed guards** (`guardsEngaged`: down and not voluntarily offline): a first edit leaves the tracked file locked with a throttled notice, a new file warns that it is untracked, and deleting anything managed (read-only bit, or present in the cached maps) is blocked. Warnings stay silent until the first probe completes (`connectionProbed`), so startup doesn't warn from the unconfirmed initial state.
- **Work offline** is a voluntary sink: no probes and no automation, a first edit only unlocks the file, and deletes are normal. Only an explicit reconnect leaves it.
- **`onunload`** restores `promptForDeletion`, clears pending backlink reverts, and calls `p4 revert -a` on the last-open file so closing Obsidian doesn't leave a stale checkout.

### Environment handed to `p4`

`p4.ts:buildEnv` copies `process.env`. In `.p4config` mode it walks up from the vault base path to the nearest `.p4config`, injects its `KEY=VALUE` pairs, and sets `P4CONFIG=.p4config`, so the connection doesn't depend on variables being present in Obsidian's GUI environment. Manual mode injects `P4PORT`/`P4CLIENT`/`P4USER` from settings. `cwd` for every `p4` invocation is the vault base path.

## Releasing

Pushing a tag builds and publishes a GitHub release (`.github/workflows/release.yml`), attaching `main.js` and `manifest.json`; `main.js` is gitignored, so the release artifact is always built in CI. Obsidian matches the tag to `manifest.json`'s version, without a `v` prefix, and the workflow fails if they differ. To cut a release:

1. Set the new version in `manifest.json`, `package.json`, and both top-level `version` fields of `package-lock.json`, and add it to `versions.json` mapped to the minimum Obsidian version.
2. Commit and push.
3. `git tag -a <version>` with the release notes as the tag message, then `git push origin <version>`. The workflow takes the notes from the annotation.

Versioning is 0.x semver: new features or behavior changes bump the minor, fixes the patch. Bump when a change lands, and release once a minor version's worth of changes is in.
