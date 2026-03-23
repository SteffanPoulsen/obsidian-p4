import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import { accessSync, constants } from "fs";
import { join } from "path";
import { DEFAULT_SETTINGS, P4PluginSettings, P4SettingTab } from "./settings";
import {
	p4Add, p4Delete, p4Edit, p4Fstat, p4Info, p4Move,
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

	/** Tracks P4 state of files: vault-relative path → 'edit' | 'add' */
	private fileStates: Map<string, "edit" | "add"> = new Map();

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
	}

	onunload(): void {
		this.revertIfUnchanged(this.lastOpenFile);
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

	private absPath(file: TAbstractFile): string {
		return join(this.vaultPath, file.path);
	}

	private absPathFromVaultPath(vaultPath: string): string {
		return join(this.vaultPath, vaultPath);
	}

	private async checkServer(): Promise<void> {
		const clientName = await p4Info(this.getP4Config(), this.vaultPath);
		this.serverAvailable = clientName !== null;
		this.updateStatusBar(clientName);
		if (!this.serverAvailable) {
			console.log("obsidian-p4: P4 server not reachable or not configured");
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

	private setFileState(vaultPath: string, state: "edit" | "add"): void {
		this.fileStates.set(vaultPath, state);
		this.applyColorToFile(vaultPath, state);
	}

	private clearFileState(vaultPath: string): void {
		this.fileStates.delete(vaultPath);
		this.applyColorToFile(vaultPath, null);
	}

	private applyColorToFile(vaultPath: string, state: "edit" | "add" | null): void {
		const explorers = this.app.workspace.getLeavesOfType("file-explorer");
		for (const leaf of explorers) {
			const fileItems = (leaf.view as any).fileItems as
				Record<string, { el: HTMLDivElement } | undefined> | undefined;
			if (!fileItems) continue;
			const item = fileItems[vaultPath];
			if (!item) continue;
			item.el.classList.remove("p4-edit", "p4-add");
			if (state) {
				item.el.classList.add(`p4-${state}`);
			}
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

		const success = await p4Edit(abs, this.getP4Config(), this.vaultPath);
		if (success) {
			this.setFileState(file.path, "edit");
		} else {
			console.warn(`obsidian-p4: Failed to checkout ${file.path}`);
		}
	}

	/** Let P4 decide if the file differs from depot — revert if not. */
	private async revertIfUnchanged(file: TFile | null): Promise<void> {
		if (!file || !this.serverAvailable) return;
		if (!this.shouldHandle(file.path)) return;

		const abs = this.absPath(file);
		const reverted = await p4RevertUnchanged(abs, this.getP4Config(), this.vaultPath);
		if (reverted) {
			this.clearFileState(file.path);
		}
	}

	// ── File lifecycle (create / delete / rename) ───────────────────

	private async onFileCreate(file: TAbstractFile): Promise<void> {
		if (!this.serverAvailable) return;
		if (!(file instanceof TFile)) return;
		if (!this.shouldHandle(file.path)) return;

		const abs = this.absPath(file);
		const success = await p4Add(abs, this.getP4Config(), this.vaultPath);
		if (success) {
			this.setFileState(file.path, "add");
			console.log(`obsidian-p4: Added ${file.path}`);
		}
	}

	private async onFileDelete(file: TAbstractFile): Promise<void> {
		if (!this.serverAvailable) return;
		if (!(file instanceof TFile)) return;
		if (!this.shouldHandle(file.path)) return;

		const abs = this.absPath(file);
		const status = await p4Fstat(abs, this.getP4Config(), this.vaultPath);

		if (status.openedForAdd) {
			await p4Revert(abs, this.getP4Config(), this.vaultPath);
			console.log(`obsidian-p4: Reverted add for ${file.path}`);
		} else if (status.tracked) {
			const success = await p4Delete(abs, this.getP4Config(), this.vaultPath);
			if (success) {
				console.log(`obsidian-p4: Deleted ${file.path}`);
			}
		}
		this.clearFileState(file.path);
	}

	private async onFileRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (!this.serverAvailable) return;
		if (!(file instanceof TFile)) return;
		if (!this.shouldHandle(file.path)) return;

		const absOld = this.absPathFromVaultPath(oldPath);
		const absNew = this.absPath(file);
		const status = await p4Fstat(absOld, this.getP4Config(), this.vaultPath);

		// Clear old state
		this.clearFileState(oldPath);

		if (status.openedForAdd) {
			await p4Revert(absOld, this.getP4Config(), this.vaultPath);
			await p4Add(absNew, this.getP4Config(), this.vaultPath);
			this.setFileState(file.path, "add");
			console.log(`obsidian-p4: Re-added as ${file.path}`);
		} else if (status.tracked) {
			const success = await p4Move(absOld, absNew, this.getP4Config(), this.vaultPath);
			if (success) {
				this.setFileState(file.path, "edit");
				console.log(`obsidian-p4: Moved ${oldPath} → ${file.path}`);
			}
		} else {
			await p4Add(absNew, this.getP4Config(), this.vaultPath);
			this.setFileState(file.path, "add");
		}
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
		const success = await p4Edit(abs, this.getP4Config(), this.vaultPath);
		if (success) {
			this.setFileState(file.path, "edit");
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
		const success = await p4Revert(abs, this.getP4Config(), this.vaultPath);
		if (success) {
			this.clearFileState(file.path);
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
