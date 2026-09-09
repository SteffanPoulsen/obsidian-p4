# Obsidian Perforce Integration

Seamless [Perforce (Helix Core)](https://www.perforce.com/products/helix-core) integration for [Obsidian](https://obsidian.md). Checks a file out the moment you start editing it and reverts it when you navigate away if nothing changed — so you can edit version-controlled documentation without thinking about P4, and just reading never touches your changelist.

Built for teams that keep documentation alongside code in Perforce workspaces.

## Features

- **Checkout on first edit** — a tracked file opens for edit (`p4 edit`) on your first keystroke; opening or reading it leaves it alone
- **Auto-revert** — reverts unchanged files (`p4 revert -a`) when you navigate away, keeping your changelist clean
- **File lifecycle** — automatically runs `p4 add` and `p4 move` when you create or rename files, and checks out the notes whose links Obsidian rewrites on a rename
- **Mark for delete** — deleting a tracked file or folder stages it for deletion (`p4 delete -k`) and keeps it on disk, shown in red, until you submit; after the submit the leftover copy is moved to the trash
- **Status bars** — a colored bar on the left edge of each file shows its P4 status at a glance: muted = tracked, accent = open for edit, green = open for add, red = marked for delete (untracked files have no bar)
- **Right-click menu** — a Perforce section on the file/folder context menu: *Add to Perforce* (start tracking new files), *Revert* (discard edits or restore a staged deletion), and *Mark for delete*
- **Connection status** — the status bar shows your workspace name with a green, red, or grey dot; click it to reconnect, log in again, or work offline
- **Offline safety** — if the server becomes unreachable or your login expires, edits, adds, and deletes of Perforce files are held back instead of silently drifting from the depot
- **Login recovery** — an expired session is detected automatically, and you can log back in from inside Obsidian (the password goes straight to `p4 login` and is never stored)
- **Manual commands** — checkout, revert, status, reconnect, and refresh in the command palette

## Setup

1. Install the plugin (see [Installation](#installation))
2. Place a `.p4config` file (or symlink) in your vault root, or configure the connection manually in settings
3. Enable the plugin — files will be checked out automatically when you start editing them

### Connection Settings

**Option A: .p4config (recommended)**

If your vault lives inside a Perforce workspace, symlink or copy your `.p4config` into the vault root:

```bash
ln -s /path/to/project/.p4config /path/to/vault/.p4config
```

The plugin reads `P4PORT`, `P4CLIENT`, and `P4USER` from the nearest `.p4config` at or above the vault root, so it doesn't depend on those variables being set in Obsidian's environment.

**Option B: Manual configuration**

Disable the `.p4config` toggle in settings and enter your server, workspace, and username directly.

## Installation

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/SteffanPoulsen/obsidian-p4/releases/latest)
2. Create a folder: `<your-vault>/.obsidian/plugins/obsidian-p4/`
3. Copy both files into that folder
4. Restart Obsidian → Settings → Community plugins → Enable "Perforce Integration"

### From source

```bash
git clone https://github.com/SteffanPoulsen/obsidian-p4.git
cd obsidian-p4
npm install
npm run build
```

Copy `main.js` and `manifest.json` to your vault's plugin folder.

## Requirements

- **Desktop only** — requires Node.js (`child_process`) which is not available on mobile
- **Perforce CLI (`p4`)** — must be installed and on your PATH
- **Perforce workspace** — the vault (or a parent directory) must be mapped in a P4 client workspace

## How It Works

| Event | Action |
|-------|--------|
| Open a tracked file | nothing — it stays read-only |
| First edit of a tracked file | `p4 edit` (file becomes writable) |
| Navigate away from an edited file | `p4 revert -a` (reverts if content matches depot) |
| Create a new file | `p4 add` |
| Delete a tracked file or folder | `p4 delete -k` — staged for delete, kept on disk and shown red until submit |
| Delete a pending-add or untracked file | removed normally (a pending `p4 add` is reverted first) |
| Rename a file | `p4 move` (tracked) or revert + re-add (pending add) |
| Return to the Obsidian window | refresh status from the server, picking up submits and reverts made elsewhere |

Files inside `.obsidian/` and `.trash/` are always ignored.

### Delete behavior

Obsidian's normal delete — right-click, the *Delete current file* command, or its hotkey — is intercepted so a tracked file is **marked** for delete rather than removed. The file stays in the explorer (shown in red) and is only removed from the depot when you submit; reverting it before then restores it. Once the submit goes through, the leftover local copy is moved to the trash (Obsidian's `.trash` or the system trash, following your *Deleted files* setting). Deleting a folder marks all of its tracked contents and leaves the folder in place. Untracked files, pending adds, and anything under `.obsidian/` fall through to Obsidian's normal delete.

### When Perforce is unavailable

The status-bar dot shows the connection: green when connected, red when the server is unreachable or your login has expired, grey when you've chosen to work offline. The plugin checks the connection every 30 seconds while Obsidian has focus, and whenever you return to the window.

While the dot is red, the plugin guards against changes the depot can't record: tracked files stay read-only when you try to edit them, new files get a warning that they aren't tracked, and deleting a Perforce-managed file is blocked. Click the status bar to reconnect, or to log in again if your session expired.

**Work offline** (from the status-bar menu) turns the guards off deliberately: editing a tracked file just makes it writable, deletes work normally, and nothing is sent to Perforce until you choose *Connect to Perforce*. Reconcile anything you changed offline with `p4 reconcile` afterwards.

## Commands

| Command | Description |
|---------|-------------|
| Perforce Integration: Checkout current file (p4 edit) | `p4 edit` the active file |
| Perforce Integration: Revert current file (p4 revert) | `p4 revert` the active file |
| Perforce Integration: Show P4 status of current file | Show whether the file is tracked/checked out |
| Perforce Integration: Reconnect to Perforce server | Re-check connectivity; prompts for a login if the session expired |
| Perforce Integration: Refresh P4 state (full vault sweep) | Re-read status for every file from the server |

## License

[MIT](LICENSE)
