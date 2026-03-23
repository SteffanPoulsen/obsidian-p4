# Obsidian Perforce Integration

Seamless [Perforce (Helix Core)](https://www.perforce.com/products/helix-core) integration for [Obsidian](https://obsidian.md). Automatically checks out files when you open them and reverts unchanged files when you navigate away — so you can edit version-controlled documentation without thinking about P4.

Built for teams that keep documentation alongside code in Perforce workspaces.

## Features

- **Auto-checkout** — opens files for edit (`p4 edit`) when you click on them in Obsidian
- **Auto-revert** — reverts unchanged files (`p4 revert -a`) when you navigate away, keeping your changelist clean
- **File lifecycle** — automatically runs `p4 add`, `p4 delete`, and `p4 move` when you create, delete, or rename files
- **Sidebar coloring** — files opened for edit show in your theme's accent color, new files show in green
- **Status bar** — displays your P4 workspace name and connection state
- **Manual commands** — checkout, revert, and status commands available in the command palette
- **Reconnect** — command palette action to reconnect if the server was unavailable at startup

## Setup

1. Install the plugin (see [Installation](#installation))
2. Place a `.p4config` file (or symlink) in your vault root, or configure the connection manually in settings
3. Enable the plugin — files will be checked out automatically when you open them

### Connection Settings

**Option A: .p4config (recommended)**

If your vault lives inside a Perforce workspace, symlink or copy your `.p4config` into the vault root:

```bash
ln -s /path/to/project/.p4config /path/to/vault/.p4config
```

The plugin reads `P4PORT`, `P4CLIENT`, and `P4USER` from this file.

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
| Open a read-only `.md` file | `p4 fstat` → `p4 edit` (file becomes writable) |
| Navigate away from an opened file | `p4 revert -a` (reverts if content matches depot) |
| Create a new file | `p4 add` |
| Delete a file | `p4 delete` (tracked) or `p4 revert` (pending add) |
| Rename a file | `p4 move` (tracked) or revert + re-add (pending add) |

Files inside `.obsidian/` are always ignored.

## Commands

| Command | Description |
|---------|-------------|
| Perforce Integration: Checkout current file | `p4 edit` the active file |
| Perforce Integration: Revert current file | `p4 revert` the active file |
| Perforce Integration: Show P4 status | Show whether the file is tracked/checked out |
| Perforce Integration: Reconnect | Re-check P4 server connectivity |

## License

[MIT](LICENSE)
