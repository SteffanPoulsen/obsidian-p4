import { Notice, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import { accessSync, chmodSync, constants, realpathSync, statSync } from "fs";
import { join } from "path";
import { DEFAULT_SETTINGS, P4PluginSettings, P4SettingTab } from "./settings";
import {
	p4Add, p4Delete, p4Edit, p4Fstat, p4Info, p4Move, p4Opened,
	p4Revert, p4RevertUnchanged, P4Config,
} from "./p4";

const P4_STYLES = `
.nav-file.p4-edit > .nav-file-title > .nav-file-title-content,
.tree-item.p4-edit > .tree-item-self > .tree-item-inner {
	color: var(--text-accent) !important;
}
.nav-file.p4-add > .nav-file-title > .nav-file-title-content,
.tree-item.p4-add > .tree-item-self > .tree-item-inner {
	color: var(--color-green) !important;
}
`;

export default class P4Plugin extends Plugin {
	settings: P4PluginSettings = DEFAULT_SETTINGS;

	/** The file that was most recently open (so we can detect close/switch) */
	private lastOpenFile: TFile | null = null;

	/** Whether P4 server is reachable */
	private serverAvailable = false;

	/** Status bar element */
	private statusBarEl: HTMLElement | null = null;

	/** Injected style element for file explorer coloring */
	private styleEl: HTMLStyleElement | null = null;

	/**
	 * P4 state of files: vault-relative path → 'edit' | 'add'.
	 * The ONLY writer is `reconcile()`. Action handlers fire p4 commands
	 * and then call `reconcile([paths])` to observe what stuck.
	 */
	private fileStates: Map<string, "edit" | "add"> = new Map();

	/** Scheduled revert-if-unchanged sweeps for pre-checked-out backlinks */
	private pendingReverts: Map<string, ReturnType<typeof setTimeout>> = new Map();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new P4SettingTab(this.app, this));

		// Inject CSS for file explorer coloring
		this.styleEl = document.createElement("style");
		this.styleEl.textContent = P4_STYLES;
		document.head.appendChild(this.styleEl);

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar(null);

		// Check P4 connectivity on startup
		this.checkServer();

		// Auto-checkout when a file is opened
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				this.onFileOpen(file);
			})
		);

		// Re-apply sidebar colors when the file explorer re-renders
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.refreshExplorerColors();
			})
		);

		// File lifecycle — p4 add / delete / move
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				this.onFileCreate(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.onFileDelete(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.onFileRename(file, oldPath);
			})
		);

		// Reconcile against ground truth whenever the user comes back to
		// Obsidian — catches state changes made outside the plugin
		// (submits from p4v, reverts from CLI, etc.).
		this.registerDomEvent(window, "focus", () => {
			this.reconcile();
		});

		// Manual commands
		this.addCommand({
			id: "p4-edit",
			name: "Checkout current file (p4 edit)",
			callback: () => this.manualCheckout(),
		});

		this.addCommand({
			id: "p4-revert",
			name: "Revert current file (p4 revert)",
			callback: () => this.manualRevert(),
		});

		this.addCommand({
			id: "p4-status",
			name: "Show P4 status of current file",
			callback: () => this.showStatus(),
		});

		this.addCommand({
			id: "p4-reconnect",
			name: "Reconnect to Perforce server",
			callback: () => this.reconnect(),
		});

		this.addCommand({
			id: "p4-refresh",
			name: "Refresh P4 state (full vault sweep)",
			callback: () => this.reconcile(),
		});
	}

	onunload(): void {
		for (const t of this.pendingReverts.values()) clearTimeout(t);
		this.pendingReverts.clear();
		// Best-effort revert on shutdown — don't bother reconciling, we're
		// tearing down.
		const last = this.lastOpenFile;
		if (last && this.serverAvailable && this.shouldHandle(last.path)) {
			p4RevertUnchanged(this.absPath(last), this.getP4Config(), this.vaultPath);
		}
		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = null;
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<P4PluginSettings>
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.checkServer();
	}

	private get vaultPath(): string {
		return (this.app.vault.adapter as any).getBasePath() as string;
	}

	private getP4Config(): P4Config {
		return {
			useP4Config: this.settings.useP4Config,
			p4Port: this.settings.p4Port,
			p4Client: this.settings.p4Client,
			p4User: this.settings.p4User,
		};
	}

	/** Resolve symlinks so p4 sees the real depot-mapped path. */
	private resolveRealPath(abs: string): string {
		try {
			return realpathSync(abs);
		} catch {
			return abs;
		}
	}

	private absPath(file: TAbstractFile): string {
		return this.resolveRealPath(join(this.vaultPath, file.path));
	}

	private absPathFromVaultPath(vaultPath: string): string {
		return this.resolveRealPath(join(this.vaultPath, vaultPath));
	}

	private async checkServer(): Promise<void> {
		const clientName = await p4Info(this.getP4Config(), this.vaultPath);
		this.serverAvailable = clientName !== null;
		this.updateStatusBar(clientName);
		if (!this.serverAvailable) {
			console.log("obsidian-p4: P4 server not reachable or not configured");
			return;
		}
		await this.reconcile();
	}

	/**
	 * Read p4's view of which files are opened, then update `fileStates`
	 * and sidebar colors to match. This is the single source of truth for
	 * state — no other code path mutates `fileStates`.
	 *
	 * - `paths` omitted → full sweep. Anything in `fileStates` not present
	 *   in p4's response is dropped.
	 * - `paths` provided → scoped reconcile for just those vault paths.
	 *   Any input path not present in p4's response is dropped from
	 *   `fileStates` (it's no longer opened).
	 */
	async reconcile(paths?: string[]): Promise<void> {
		if (!this.serverAvailable) return;

		const realVault = this.resolveRealPath(this.vaultPath);
		const prefix = realVault.endsWith("/") ? realVault : realVault + "/";

		const queryPaths = paths?.map((p) => this.absPathFromVaultPath(p));
		const opened = await p4Opened(this.getP4Config(), realVault, queryPaths);

		const newStates = new Map<string, "edit" | "add">();
		for (const { localPath, action } of opened) {
			if (!localPath.startsWith(prefix)) continue;
			const vaultRel = localPath.substring(prefix.length);
			if (!this.shouldHandle(vaultRel)) continue;
			newStates.set(vaultRel, action);
		}

		const scope: Set<string> = paths
			? new Set(paths)
			: new Set([...this.fileStates.keys(), ...newStates.keys()]);

		for (const p of scope) {
			const next = newStates.get(p) ?? null;
			const prev = this.fileStates.get(p) ?? null;
			if (next === prev) continue;
			if (next === null) this.fileStates.delete(p);
			else this.fileStates.set(p, next);
			this.applyColorToFile(p, next);
		}
	}

	private updateStatusBar(clientName: string | null): void {
		if (!this.statusBarEl) return;
		if (clientName) {
			this.statusBarEl.setText(`P4: ${clientName}`);
		} else {
			this.statusBarEl.setText("P4: disconnected");
		}
	}

	private async reconnect(): Promise<void> {
		new Notice("P4: reconnecting...", 1500);
		await this.checkServer();
		if (this.serverAvailable) {
			new Notice("P4: connected", 2000);
		} else {
			new Notice("P4: connection failed", 3000);
		}
	}

	private shouldHandle(path: string): boolean {
		if (path.startsWith(".obsidian/")) return false;
		return true;
	}

	private isReadOnly(absPath: string): boolean {
		try {
			accessSync(absPath, constants.W_OK);
			return false;
		} catch {
			return true;
		}
	}

	// ── File explorer coloring ──────────────────────────────────────

	private applyColorToFile(vaultPath: string, state: "edit" | "add" | null, retries = 10): void {
		const explorers = this.app.workspace.getLeavesOfType("file-explorer");
		let found = false;
		for (const leaf of explorers) {
			const fileItems = (leaf.view as any).fileItems as
				Record<string, { el: HTMLDivElement; file?: { path: string } } | undefined> | undefined;
			if (!fileItems) continue;
			let item = fileItems[vaultPath];
			if (!item) {
				// fileItems isn't always re-keyed immediately after a
				// rename — fall back to matching the entry's TFile.path
				// so we still find the right DOM node.
				for (const key in fileItems) {
					const candidate = fileItems[key];
					if (candidate?.file?.path === vaultPath) {
						item = candidate;
						break;
					}
				}
			}
			if (!item) continue;
			found = true;
			item.el.classList.remove("p4-edit", "p4-add");
			if (state) {
				item.el.classList.add(`p4-${state}`);
			}
		}
		if (!found && state !== null && retries > 0) {
			requestAnimationFrame(() => this.applyColorToFile(vaultPath, state, retries - 1));
		}
	}

	private refreshExplorerColors(): void {
		for (const [path, state] of this.fileStates) {
			this.applyColorToFile(path, state);
		}
	}

	// ── Auto-checkout on file open ──────────────────────────────────

	private async onFileOpen(file: TFile | null): Promise<void> {
		// Revert previous file if unchanged (compares against depot)
		if (this.lastOpenFile && this.lastOpenFile !== file) {
			await this.revertIfUnchanged(this.lastOpenFile);
		}

		this.lastOpenFile = file;

		if (!file || !this.serverAvailable) return;
		if (!this.shouldHandle(file.path)) return;

		const abs = this.absPath(file);

		// Only checkout if the file is read-only (P4's default state)
		if (!this.isReadOnly(abs)) return;

		// Check if this file is actually tracked in P4
		const status = await p4Fstat(abs, this.getP4Config(), this.vaultPath);
		if (!status.tracked || status.checkedOut) return;

		await p4Edit(abs, this.getP4Config(), this.vaultPath);
		await this.reconcile([file.path]);
	}

	/** Let P4 decide if the file differs from depot — revert if not. */
	private async revertIfUnchanged(file: TFile | null): Promise<void> {
		if (!file || !this.serverAvailable) return;
		if (!this.shouldHandle(file.path)) return;

		const abs = this.absPath(file);
		await p4RevertUnchanged(abs, this.getP4Config(), this.vaultPath);
		await this.reconcile([file.path]);
	}

	// ── File lifecycle (create / delete / rename) ───────────────────

	private async onFileCreate(file: TAbstractFile): Promise<void> {
		if (!this.serverAvailable) return;
		if (!(file instanceof TFile)) return;
		if (!this.shouldHandle(file.path)) return;

		const abs = this.absPath(file);
		await p4Add(abs, this.getP4Config(), this.vaultPath);
		await this.reconcile([file.path]);
	}

	private async onFileDelete(file: TAbstractFile): Promise<void> {
		if (!this.serverAvailable) return;
		if (!(file instanceof TFile)) return;
		if (!this.shouldHandle(file.path)) return;

		const abs = this.absPath(file);
		const status = await p4Fstat(abs, this.getP4Config(), this.vaultPath);

		if (status.openedForAdd) {
			await p4Revert(abs, this.getP4Config(), this.vaultPath);
		} else if (status.tracked) {
			await p4Delete(abs, this.getP4Config(), this.vaultPath);
		}
		await this.reconcile([file.path]);
	}

	private async onFileRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (!this.serverAvailable) return;
		if (!this.shouldHandle(file.path)) return;

		if (file instanceof TFolder) {
			// Obsidian fires one rename for the folder; child files don't
			// get individual events. Walk the tree and p4-move each so the
			// depot follows the move instead of waiting for reconcile.
			const children = this.collectFiles(file);
			const oldPrefix = oldPath;
			const newPrefix = file.path;
			await Promise.all(children.map((child) => {
				const oldChildPath = oldPrefix + child.path.substring(newPrefix.length);
				return this.handleFileRename(child, oldChildPath);
			}));
			// Folder renames touch many paths and per-child reconciles
			// can race with each other on the old paths — full sweep is
			// both simpler and cheaper at this scale.
			await this.reconcile();
			return;
		}

		if (!(file instanceof TFile)) return;
		await this.handleFileRename(file, oldPath);
		await this.reconcile([oldPath, file.path]);
	}

	private async handleFileRename(file: TFile, oldPath: string): Promise<void> {
		if (!this.shouldHandle(file.path)) return;

		// Pre-emptively check out files that link to this one. Obsidian is
		// about to rewrite their wikilinks; without this, those writes hit
		// read-only files and silently fail.
		this.checkoutBacklinks(file, oldPath);

		const absOld = this.absPathFromVaultPath(oldPath);
		const absNew = this.absPath(file);
		const status = await p4Fstat(absOld, this.getP4Config(), this.vaultPath);

		if (status.openedForAdd) {
			await p4Revert(absOld, this.getP4Config(), this.vaultPath);
			await p4Add(absNew, this.getP4Config(), this.vaultPath);
		} else if (status.tracked) {
			await p4Move(absOld, absNew, this.getP4Config(), this.vaultPath);
			// p4 move -k skipped the workspace operation, so the new path
			// is still read-only on disk. Flip it ourselves — harmless if
			// the move call quietly failed, and necessary if it succeeded.
			try {
				const mode = statSync(absNew).mode;
				chmodSync(absNew, mode | 0o200);
			} catch (e) {
				console.warn(`obsidian-p4: chmod +w failed for ${file.path}`, e);
			}
		} else {
			await p4Add(absNew, this.getP4Config(), this.vaultPath);
		}
	}

	private collectFiles(folder: TFolder): TFile[] {
		const out: TFile[] = [];
		const walk = (f: TFolder): void => {
			for (const child of f.children) {
				if (child instanceof TFile) out.push(child);
				else if (child instanceof TFolder) walk(child);
			}
		};
		walk(folder);
		return out;
	}

	/**
	 * Find every file that wikilinks to the renamed file and checkout each
	 * one before Obsidian rewrites its links. Uses `resolvedLinks`, which
	 * still reflects pre-rename state when this fires.
	 */
	private checkoutBacklinks(file: TFile, oldPath: string): void {
		const resolved = this.app.metadataCache.resolvedLinks;
		const sources = new Set<string>();
		for (const sourcePath of Object.keys(resolved)) {
			const targets = resolved[sourcePath];
			if (!targets) continue;
			if (!(oldPath in targets) && !(file.path in targets)) continue;
			if (sourcePath === oldPath || sourcePath === file.path) continue;
			if (!this.shouldHandle(sourcePath)) continue;
			sources.add(sourcePath);
		}

		for (const sourcePath of sources) {
			this.preCheckoutBacklink(sourcePath);
		}
	}

	/**
	 * Two-step checkout: synchronous chmod +w (sub-millisecond) so Obsidian's
	 * imminent wikilink write lands on a writable file, then async `p4 edit`
	 * to register the open with P4. If the file wasn't actually tracked,
	 * the reconcile that follows will leave it out of `fileStates`; restore
	 * the original mode in that case so we don't leave a writable-but-
	 * untracked file behind.
	 */
	private async preCheckoutBacklink(vaultPath: string): Promise<void> {
		const abs = this.absPathFromVaultPath(vaultPath);
		if (this.fileStates.has(vaultPath)) return;
		if (!this.isReadOnly(abs)) return;

		let originalMode: number;
		try {
			originalMode = statSync(abs).mode;
			chmodSync(abs, originalMode | 0o200);
		} catch (e) {
			console.warn(`obsidian-p4: chmod +w failed for ${vaultPath}`, e);
			return;
		}

		await p4Edit(abs, this.getP4Config(), this.vaultPath);
		await this.reconcile([vaultPath]);

		if (this.fileStates.has(vaultPath)) {
			// If the user declined the link-update prompt (or the link
			// didn't actually change), this checkout has no diff. Sweep
			// it after a few seconds — `p4 revert -a` keeps it open if
			// the file was modified, drops it otherwise.
			this.scheduleRevertIfUnchanged(vaultPath, 5000);
		} else {
			try { chmodSync(abs, originalMode); } catch {}
		}
	}

	private scheduleRevertIfUnchanged(vaultPath: string, delayMs: number): void {
		const existing = this.pendingReverts.get(vaultPath);
		if (existing) clearTimeout(existing);
		const t = setTimeout(async () => {
			this.pendingReverts.delete(vaultPath);
			const abs = this.absPathFromVaultPath(vaultPath);
			await p4RevertUnchanged(abs, this.getP4Config(), this.vaultPath);
			await this.reconcile([vaultPath]);
		}, delayMs);
		this.pendingReverts.set(vaultPath, t);
	}

	// ── Manual commands ──────────────────────────────────────────────

	private async manualCheckout(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active file");
			return;
		}
		if (!this.serverAvailable) {
			new Notice("P4 server not reachable");
			return;
		}

		const abs = this.absPath(file);
		await p4Edit(abs, this.getP4Config(), this.vaultPath);
		await this.reconcile([file.path]);
		if (this.fileStates.get(file.path) === "edit") {
			new Notice(`Checked out: ${file.name}`);
		} else {
			new Notice(`Failed to checkout: ${file.name}`);
		}
	}

	private async manualRevert(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active file");
			return;
		}
		if (!this.serverAvailable) {
			new Notice("P4 server not reachable");
			return;
		}

		const abs = this.absPath(file);
		await p4Revert(abs, this.getP4Config(), this.vaultPath);
		await this.reconcile([file.path]);
		if (!this.fileStates.has(file.path)) {
			new Notice(`Reverted: ${file.name}`);
		} else {
			new Notice(`Failed to revert: ${file.name}`);
		}
	}

	private async showStatus(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active file");
			return;
		}
		if (!this.serverAvailable) {
			new Notice("P4 server not reachable");
			return;
		}

		const abs = this.absPath(file);
		const status = await p4Fstat(abs, this.getP4Config(), this.vaultPath);

		if (!status.tracked) {
			new Notice(`${file.name}: Not tracked in Perforce`);
		} else if (status.checkedOut) {
			new Notice(`${file.name}: Checked out for edit`);
		} else {
			new Notice(`${file.name}: Tracked, not checked out`);
		}
	}
}
