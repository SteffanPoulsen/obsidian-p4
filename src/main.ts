import { App, Menu, Modal, Notice, Plugin, Setting, TAbstractFile, TFile, TFolder } from "obsidian";
import { accessSync, chmodSync, constants, realpathSync, statSync } from "fs";
import { join } from "path";
import { DEFAULT_SETTINGS, P4PluginSettings, P4SettingTab } from "./settings";
import {
	p4Add, p4Delete, p4DeleteKeep, p4Edit, p4Fstat, p4Have, p4Info, p4Login, p4LoginStatus,
	p4Move, p4Opened, p4Revert, p4RevertKeep, p4RevertUnchanged, P4AuthError, P4Config, P4FileStatus,
} from "./p4";

// A single left-edge bar encodes a file's P4 status; the title text keeps its
// normal theme color. No bar = untracked; muted = tracked/clean; accent = open
// for edit; green = open for add; red = marked for delete.
//
// The bar is drawn as a `::after` pseudo-element, not box-shadow/border: the
// file explorer renders its hover/active/selected/drag highlight as a
// positioned `::before` on the row, which would paint over a box-shadow. An
// `::after` paints after (above) that `::before`, so the P4 bar always wins.
const P4_STYLES = `
.nav-file.p4-tracked > .nav-file-title,
.nav-file.p4-edit > .nav-file-title,
.nav-file.p4-add > .nav-file-title,
.nav-file.p4-delete > .nav-file-title,
.tree-item.p4-tracked > .tree-item-self,
.tree-item.p4-edit > .tree-item-self,
.tree-item.p4-add > .tree-item-self,
.tree-item.p4-delete > .tree-item-self {
	position: relative;
}
.nav-file.p4-tracked > .nav-file-title::after,
.nav-file.p4-edit > .nav-file-title::after,
.nav-file.p4-add > .nav-file-title::after,
.nav-file.p4-delete > .nav-file-title::after,
.tree-item.p4-tracked > .tree-item-self::after,
.tree-item.p4-edit > .tree-item-self::after,
.tree-item.p4-add > .tree-item-self::after,
.tree-item.p4-delete > .tree-item-self::after {
	content: "";
	position: absolute;
	left: 0;
	top: 0;
	bottom: 0;
	width: 3px;
	background-color: var(--p4-bar);
	pointer-events: none;
}
.nav-file.p4-tracked > .nav-file-title,
.tree-item.p4-tracked > .tree-item-self { --p4-bar: var(--text-muted); }
.nav-file.p4-edit > .nav-file-title,
.tree-item.p4-edit > .tree-item-self { --p4-bar: var(--text-accent); }
.nav-file.p4-add > .nav-file-title,
.tree-item.p4-add > .tree-item-self { --p4-bar: var(--color-green); }
.nav-file.p4-delete > .nav-file-title,
.tree-item.p4-delete > .tree-item-self { --p4-bar: var(--color-red); }

/* Connection dot in the status-bar item (green = connected, red = down,
   grey = working offline), like Obsidian Sync's indicator. */
.p4-status-dot {
	display: inline-block;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	margin-right: 5px;
	vertical-align: middle;
	background-color: var(--text-muted);
}
.p4-status-dot.p4-dot-green { background-color: var(--color-green); }
.p4-status-dot.p4-dot-red { background-color: var(--color-red); }
.p4-status-dot.p4-dot-grey { background-color: var(--text-muted); }
`;

/** A file's P4 status as reflected by the explorer bar. */
type P4Bar = "tracked" | "edit" | "add" | "delete";

/**
 * Prompts for a Perforce password to re-establish a login ticket. Calls back
 * with the entered password, or `null` if dismissed without submitting.
 */
class P4LoginModal extends Modal {
	private readonly onSubmit: (password: string | null) => void;
	private value = "";
	private resolved = false;

	constructor(app: App, onSubmit: (password: string | null) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		this.titleEl.setText("Perforce login");
		const { contentEl } = this;
		contentEl.createEl("p", {
			text: "Your Perforce session has expired. Enter your password to log back in.",
		});

		new Setting(contentEl).setName("Password").addText((text) => {
			text.inputEl.type = "password";
			text.setPlaceholder("Perforce password");
			text.onChange((v) => { this.value = v; });
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") { e.preventDefault(); this.finish(this.value); }
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Log in").setCta().onClick(() => this.finish(this.value)))
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	private finish(password: string): void {
		if (this.resolved) return;
		this.resolved = true;
		this.onSubmit(password);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.onSubmit(null);
		}
	}
}

export default class P4Plugin extends Plugin {
	settings: P4PluginSettings = DEFAULT_SETTINGS;

	/** The file that was most recently open (so we can detect close/switch) */
	private lastOpenFile: TFile | null = null;

	/** Whether P4 server is reachable (derived: connectionStatus === "connected"). */
	private serverAvailable = false;

	/**
	 * Connection state the status bar renders from; written only by
	 * setConnectionState. "offline" is the voluntary Work-offline mode (guards
	 * off, no automation); "expired"/"unreachable" are involuntary down states
	 * that engage the fail-closed guards.
	 */
	private connectionStatus: "connected" | "unreachable" | "expired" | "offline" = "unreachable";

	/** Guards against overlapping checkServer probes (e.g. window-focus storms). */
	private checkInFlight = false;

	/** Guards against overlapping heartbeat probes. */
	private heartbeatInFlight = false;

	/**
	 * Set once the first connectivity probe has completed. Until then the status
	 * is the unconfirmed initial "unreachable", so guards stay silent — warning
	 * from that un-probed state would fire on every startup.
	 */
	private connectionProbed = false;

	/** Last throttled warning shown, to suppress repeats for the same path. */
	private lastWarn: { path: string; at: number } | null = null;

	/** Status bar element, and the colored dot + text spans inside it. */
	private statusBarEl: HTMLElement | null = null;
	private statusDotEl: HTMLElement | null = null;
	private statusTextEl: HTMLElement | null = null;

	/** Injected style element for file explorer coloring */
	private styleEl: HTMLStyleElement | null = null;

	/**
	 * P4 open state of files: vault-relative path → 'edit' | 'add' | 'delete'.
	 * The ONLY writer is `reconcile()`. Action handlers fire p4 commands
	 * and then call `reconcile([paths])` to observe what stuck.
	 */
	private fileStates: Map<string, "edit" | "add" | "delete"> = new Map();

	/**
	 * Vault-relative paths that exist in the depot (tracked but not necessarily
	 * open). Sourced from `p4 have`, written only by `reconcile()`. Drives the
	 * muted "tracked" bar and the context-menu's tracked-vs-untracked logic.
	 */
	private trackedFiles: Set<string> = new Set();

	/** Scheduled revert-if-unchanged sweeps for pre-checked-out backlinks */
	private pendingReverts: Map<string, ReturnType<typeof setTimeout>> = new Map();

	/** Original FileManager.promptForDeletion, saved so onunload can restore it. */
	private origPromptForDeletion: ((file: TAbstractFile) => Promise<boolean>) | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new P4SettingTab(this.app, this));

		// Inject CSS for file explorer coloring
		this.styleEl = document.createElement("style");
		this.styleEl.textContent = P4_STYLES;
		document.head.appendChild(this.styleEl);

		// Status bar — a colored connection dot + text, clickable to toggle
		// Work-offline / reconnect.
		const statusBarEl = this.addStatusBarItem();
		this.statusBarEl = statusBarEl;
		statusBarEl.addClass("mod-clickable");
		this.statusDotEl = statusBarEl.createSpan({ cls: "p4-status-dot" });
		this.statusTextEl = statusBarEl.createSpan({ cls: "p4-status-text" });
		this.registerDomEvent(statusBarEl, "click", (e) => this.showStatusMenu(e));
		this.setConnectionState("unreachable");

		// Check P4 connectivity on startup
		this.checkServer();

		// Proactively detect a dropped session (and recover from one) on a timer,
		// so the down-state is known before the user acts on it.
		this.registerInterval(window.setInterval(() => this.heartbeat(), 30000));

		// Make Obsidian's native delete P4-aware: tracked files are staged
		// for delete and kept on disk (so they stay visible and turn red)
		// instead of being removed outright. See patchDeletePrompt.
		this.patchDeletePrompt();

		// Track the open file so we can revert it on switch if it's unchanged.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				this.onFileOpen(file);
			})
		);

		// Checkout on first edit, not on open: a tracked file stays read-only
		// (just the muted "tracked" bar) until the user actually changes it, at
		// which point we unlock it and open it for edit. Reading no longer
		// checks a file out.
		this.registerEvent(
			this.app.workspace.on("editor-change", (_editor, info) => {
				const file = info.file;
				if (file) this.ensureCheckedOut(file);
			})
		);

		// Re-apply sidebar bars when the file explorer re-renders
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.refreshExplorerColors();
			})
		);

		// Bespoke Perforce section in the file/folder right-click menu
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				this.buildFileMenu(menu, file);
			})
		);

		// File lifecycle — p4 add / delete / move.
		//
		// Obsidian replays a `create` for every existing file while it loads the
		// vault; registering this handler only once layout is ready means we see
		// genuine post-load creations, not that startup replay.
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					this.onFileCreate(file);
				})
			);
		});

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
			// Voluntary offline is a sink — don't auto-probe out of it.
			if (this.connectionStatus === "offline") return;
			// When down, re-probe so we recover once the user has re-logged in;
			// otherwise just reconcile against ground truth.
			if (this.serverAvailable) this.reconcile();
			else this.checkServer();
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
		// Restore the original delete handler we wrapped in onload.
		if (this.origPromptForDeletion) {
			(this.app.fileManager as any).promptForDeletion = this.origPromptForDeletion;
			this.origPromptForDeletion = null;
		}

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
		if (this.checkInFlight) return;
		// Voluntary offline is a true sink: nothing probes out of it (this also
		// closes the saveSettings → checkServer leak). goOnline leaves the sink
		// before calling here.
		if (this.connectionStatus === "offline") return;
		this.checkInFlight = true;
		try {
			const clientName = await p4Info(this.getP4Config(), this.vaultPath);
			if (clientName === null) {
				this.setConnectionState("unreachable");
				console.log("obsidian-p4: P4 server not reachable or not configured");
				return;
			}
			// Enable the gate so reconcile can probe with auth-requiring
			// queries; it downgrades to "expired" (returning false) if the
			// ticket is dead. Announce "connected" only once it comes back ok,
			// so a repeated focus re-probe doesn't re-fire the expiry notice.
			this.serverAvailable = true;
			if (await this.reconcile()) {
				this.setConnectionState("connected", clientName);
			}
		} finally {
			this.checkInFlight = false;
			this.connectionProbed = true;
		}
	}

	/**
	 * Periodic liveness probe so a dropped session is detected before the user
	 * acts on it. Skips voluntary offline (a sink) and a backgrounded window
	 * (no point probing). When up, a cheap `login -s` confirms the ticket still
	 * lives and downgrades to expired/unreachable on failure; when down, retry
	 * checkServer to recover once the user has re-logged in.
	 */
	private async heartbeat(): Promise<void> {
		if (this.heartbeatInFlight) return;
		if (this.connectionStatus === "offline") return;
		if (!document.hasFocus()) return;
		this.heartbeatInFlight = true;
		try {
			if (this.serverAvailable) {
				const status = await p4LoginStatus(this.getP4Config(), this.vaultPath);
				if (status === "expired") this.setConnectionState("expired");
				else if (status === "unreachable") this.setConnectionState("unreachable");
			} else {
				await this.checkServer();
			}
		} finally {
			this.heartbeatInFlight = false;
		}
	}

	/**
	 * Read p4's view of which files are opened (`p4 opened`) and which are in
	 * the depot (`p4 have`), then update `fileStates` / `trackedFiles` and the
	 * explorer bars to match. This is the single source of truth for both maps
	 * — no other code path mutates them.
	 *
	 * - `paths` omitted → full sweep. Anything in either map not present in
	 *   p4's response is dropped.
	 * - `paths` provided → scoped reconcile for just those vault paths. Any
	 *   input path not reported by p4 is dropped from both maps.
	 */
	async reconcile(paths?: string[]): Promise<boolean> {
		if (!this.serverAvailable) return false;

		const realVault = this.resolveRealPath(this.vaultPath);
		const prefix = realVault.endsWith("/") ? realVault : realVault + "/";
		const toVaultRel = (localPath: string): string | null => {
			if (!localPath.startsWith(prefix)) return null;
			const rel = localPath.substring(prefix.length);
			return this.shouldHandle(rel) ? rel : null;
		};

		const queryPaths = paths?.map((p) => this.absPathFromVaultPath(p));
		const result = await Promise.all([
			p4Opened(this.getP4Config(), realVault, queryPaths),
			p4Have(this.getP4Config(), realVault, queryPaths),
		]).catch((e) => {
			// The only error the queries rethrow is auth: the ticket expired
			// mid-session. Mark expired and leave bars/maps untouched.
			if (e instanceof P4AuthError) this.setConnectionState("expired");
			return null;
		});
		if (!result) return false;
		const [opened, have] = result;

		const newStates = new Map<string, "edit" | "add" | "delete">();
		for (const { localPath, action } of opened) {
			const rel = toVaultRel(localPath);
			if (rel) newStates.set(rel, action);
		}
		const newTracked = new Set<string>();
		for (const localPath of have) {
			const rel = toVaultRel(localPath);
			if (rel) newTracked.add(rel);
		}

		const scope: Set<string> = paths
			? new Set(paths)
			: new Set([
				...this.fileStates.keys(), ...this.trackedFiles,
				...newStates.keys(), ...newTracked,
			]);

		const submittedDeletes: string[] = [];
		for (const p of scope) {
			const prevBar = this.barFor(p);
			const wasDelete = this.fileStates.get(p) === "delete";

			const nextState = newStates.get(p) ?? null;
			if (nextState === null) this.fileStates.delete(p);
			else this.fileStates.set(p, nextState);

			if (newTracked.has(p)) this.trackedFiles.add(p);
			else this.trackedFiles.delete(p);

			// A staged delete that now shows no bar has either been submitted
			// or reverted; confirm which before removing the kept -k copy.
			if (wasDelete && this.barFor(p) === null) submittedDeletes.push(p);

			// Only touch the DOM when the resulting bar actually changes.
			if (this.barFor(p) !== prevBar) this.applyBar(p);
		}

		for (const p of submittedDeletes) {
			await this.cleanupSubmittedDelete(p);
		}
		return true;
	}

	/**
	 * Remove the workspace copy a `delete -k` left behind, once the deletion
	 * has actually been submitted. Confirms via fstat that the depot head is a
	 * deletion and the file is no longer synced (`!tracked`) — a positive
	 * signal, never inferred from absence in a query that may have failed — so
	 * a flaky server can't cause a wrongful delete. A reverted delete still has
	 * a have-rev, so it's kept. Trashed (recoverable), not permanently removed.
	 */
	private async cleanupSubmittedDelete(vaultPath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (!(file instanceof TFile)) return; // already gone (e.g. move/delete source)

		const status = await p4Fstat(this.absPath(file), this.getP4Config(), this.vaultPath);
		if (!status.deletedAtHead || status.tracked) return;

		// Honor the user's "Deleted files" preference for system trash, but
		// never permanently delete — fall back to the vault's local .trash so
		// an auto-removal is always recoverable.
		const system = (this.app.vault as any).getConfig?.("trashOption") === "system";
		await this.app.vault.trash(file, system);
	}

	/**
	 * Single writer of connection state. Sets the derived `serverAvailable`
	 * gate, renders the status bar, and announces an expiry once — on the
	 * transition into "expired" — so a dead ticket can't pass unnoticed.
	 */
	private setConnectionState(
		status: "connected" | "unreachable" | "expired" | "offline",
		clientName?: string
	): void {
		const prev = this.connectionStatus;
		this.connectionStatus = status;
		this.serverAvailable = status === "connected";

		if (this.statusTextEl) {
			this.statusTextEl.setText(
				status === "connected"
					? `P4: ${clientName ?? "connected"}`
					: status === "offline"
						? "P4: working offline"
						: status === "expired"
							? "P4: session expired"
							: "P4: disconnected"
			);
		}
		if (this.statusDotEl) {
			this.statusDotEl.classList.remove("p4-dot-green", "p4-dot-red", "p4-dot-grey");
			this.statusDotEl.classList.add(
				status === "connected" ? "p4-dot-green"
					: status === "offline" ? "p4-dot-grey"
						: "p4-dot-red"
			);
		}

		if (status === "expired" && prev !== "expired") {
			new Notice(
				"Perforce session expired — run 'p4 login', then use the " +
				"'Reconnect to Perforce server' command.",
				8000
			);
		}

		if (status === "offline" && prev !== "offline") {
			new Notice("Working offline — Perforce paused; reconnect to resume", 5000);
		}
	}

	private async reconnect(): Promise<void> {
		new Notice("P4: reconnecting…", 1500);
		await this.checkServer();
		if (this.serverAvailable) {
			new Notice("P4: connected", 2000);
		} else if (this.connectionStatus === "expired") {
			// Reached the server but the ticket is dead — only a login fixes it.
			this.promptLogin();
		} else {
			new Notice("P4: can't reach the Perforce server — check P4PORT / network", 5000);
		}
	}

	/**
	 * Prompt for a password, run `p4 login`, and re-probe on success. The
	 * password is handed straight to p4 and never stored; a wrong password or
	 * unreachable server surfaces as a toast with p4's own reason.
	 */
	private promptLogin(): void {
		new P4LoginModal(this.app, async (password) => {
			if (!password) return; // dismissed or empty
			new Notice("P4: logging in…", 1500);
			const result = await p4Login(this.getP4Config(), this.vaultPath, password);
			if (!result.ok) {
				new Notice(`P4: login failed — ${result.message}`, 6000);
				return;
			}
			await this.checkServer();
			new Notice(
				this.serverAvailable
					? "P4: logged in"
					: "P4: logged in, but couldn't reconnect — try again",
				3000
			);
		}).open();
	}

	// ── Status-bar control (Work offline / reconnect) ────────────────

	/** Menu shown when the status-bar item is clicked. */
	private showStatusMenu(evt: MouseEvent): void {
		const menu = new Menu();
		if (this.connectionStatus === "offline") {
			menu.addItem((item) =>
				item.setTitle("Connect to Perforce").setIcon("plug-zap")
					.onClick(() => { void this.goOnline(); })
			);
		} else {
			// An expired ticket needs a login; an unreachable server needs a
			// re-probe. Neither shows when we're already connected.
			if (this.connectionStatus === "expired") {
				menu.addItem((item) =>
					item.setTitle("Log in to Perforce…").setIcon("log-in")
						.onClick(() => this.promptLogin())
				);
			} else if (!this.serverAvailable) {
				menu.addItem((item) =>
					item.setTitle("Reconnect").setIcon("refresh-cw")
						.onClick(() => { void this.reconnect(); })
				);
			}
			menu.addItem((item) =>
				item.setTitle("Work offline").setIcon("plug")
					.onClick(() => this.workOffline())
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/** Enter voluntary Work-offline mode: guards off, no automation. */
	private workOffline(): void {
		this.setConnectionState("offline");
	}

	/**
	 * Leave Work-offline and try to reconnect. Drops the sink first so
	 * checkServer's offline early-return doesn't refuse to run; a failed probe
	 * lands in unreachable, where the heartbeat keeps retrying.
	 */
	private async goOnline(): Promise<void> {
		this.setConnectionState("unreachable");
		await this.checkServer();
		if (!this.serverAvailable) {
			new Notice("P4: still offline — couldn't reconnect", 3000);
		}
	}

	private shouldHandle(path: string): boolean {
		if (path.startsWith(".obsidian/")) return false;
		if (path.startsWith(".trash/")) return false;
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

	/**
	 * Whether the fail-closed guards are active: P4 is involuntarily down
	 * (expired or unreachable) and the user hasn't deliberately gone offline.
	 * Derived from the boolean, not the status enum, so it drops the instant a
	 * reconnecting checkServer raw-sets `serverAvailable` — no spurious "locked"
	 * warning during the reconnect tick.
	 */
	private guardsEngaged(): boolean {
		return !this.serverAvailable && this.connectionStatus !== "offline";
	}

	/** Add the owner-write bit so an imminent write lands on a writable file. */
	private makeWritable(abs: string): void {
		try {
			chmodSync(abs, statSync(abs).mode | 0o200);
		} catch (e) {
			console.warn(`obsidian-p4: chmod +w failed for ${abs}`, e);
		}
	}

	/** Clear the write bits, restoring P4's locked (read-only) state. */
	private makeReadOnly(abs: string): void {
		try {
			chmodSync(abs, statSync(abs).mode & ~0o222);
		} catch (e) {
			console.warn(`obsidian-p4: chmod -w failed for ${abs}`, e);
		}
	}

	/**
	 * Show a Notice, suppressing a repeat for the same path within ~10s so a
	 * burst of opens/creates against a downed server doesn't spam the user.
	 */
	private warnThrottled(path: string, msg: string): void {
		const now = Date.now();
		if (this.lastWarn && this.lastWarn.path === path && now - this.lastWarn.at < 10000) {
			return;
		}
		this.lastWarn = { path, at: now };
		new Notice(msg, 5000);
	}

	// ── File explorer bars ──────────────────────────────────────────

	/** The status bar a path should show: open state wins over plain tracked. */
	private barFor(vaultPath: string): P4Bar | null {
		return this.fileStates.get(vaultPath)
			?? (this.trackedFiles.has(vaultPath) ? "tracked" : null);
	}

	private applyBar(vaultPath: string, retries = 10): void {
		const bar = this.barFor(vaultPath);
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
			item.el.classList.remove("p4-tracked", "p4-edit", "p4-add", "p4-delete");
			if (bar) {
				item.el.classList.add(`p4-${bar}`);
			}
		}
		if (!found && bar !== null && retries > 0) {
			requestAnimationFrame(() => this.applyBar(vaultPath, retries - 1));
		}
	}

	private refreshExplorerColors(): void {
		const paths = new Set([...this.fileStates.keys(), ...this.trackedFiles]);
		for (const path of paths) {
			this.applyBar(path);
		}
	}

	// ── Checkout on edit ────────────────────────────────────────────
	//
	// A tracked file is left read-only when merely opened — it just shows the
	// muted "tracked" bar. The checkout happens on the first edit (the
	// editor-change event), so reading a file never opens it for edit. The two
	// reverts still keep the pending changelist clean: revert-if-unchanged when
	// switching away (below), and again on unload.

	private async onFileOpen(file: TFile | null): Promise<void> {
		// Revert the file we're leaving if it's unchanged vs depot, so a
		// touched-then-undone file doesn't linger open for edit.
		if (this.lastOpenFile && this.lastOpenFile !== file) {
			await this.revertIfUnchanged(this.lastOpenFile);
		}
		this.lastOpenFile = file;
	}

	/**
	 * First-edit checkout. Fired on editor-change (every content edit), it
	 * unlocks and opens a tracked file the moment the user starts changing it.
	 * The synchronous chmod makes the file writable in time for Obsidian's
	 * imminent (debounced) autosave; the async p4 edit registers the open. The
	 * read-only check doubles as the keystroke-storm guard — once the first edit
	 * unlocks the file, every later keystroke short-circuits here.
	 */
	private ensureCheckedOut(file: TFile): void {
		if (!this.shouldHandle(file.path)) return;
		if (this.fileStates.has(file.path)) return; // already open for edit/add

		const abs = this.absPath(file);
		if (!this.isReadOnly(abs)) return; // untracked or already unlocked

		// Work-offline: just unlock so the edit can save. No p4 edit — the same
		// no-server semantics as before, only deferred to the actual edit.
		if (this.connectionStatus === "offline") {
			this.makeWritable(abs);
			return;
		}

		// Involuntarily down: keep the file locked and say so, rather than let an
		// edit accumulate against a server that can't accept the checkout.
		if (this.guardsEngaged()) {
			if (this.connectionProbed) {
				this.warnThrottled(file.path, `Perforce offline — ${file.name} is locked`);
			}
			return;
		}

		this.makeWritable(abs); // sync: the imminent autosave lands on a writable file
		void this.checkoutForEdit(file); // async: register the open with p4
	}

	/**
	 * Register the open with P4 after ensureCheckedOut unlocked the file. Only a
	 * tracked, not-yet-open file needs `p4 edit`; an untracked one is the create
	 * handler's job. If nothing ends up open (server rejected it, or the file
	 * wasn't really tracked), re-lock it so a checkout that didn't land fails the
	 * save loudly rather than diverging silently — an on-disk edit P4 never opened.
	 */
	private async checkoutForEdit(file: TFile): Promise<void> {
		const abs = this.absPath(file);
		const status = await p4Fstat(abs, this.getP4Config(), this.vaultPath);
		if (status.tracked && !status.checkedOut && !status.openedForAdd && !status.openedForDelete) {
			await p4Edit(abs, this.getP4Config(), this.vaultPath);
			await this.reconcile([file.path]);
		}
		if (!this.fileStates.has(file.path)) {
			this.makeReadOnly(abs);
		}
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
		if (!(file instanceof TFile)) return;
		if (!this.shouldHandle(file.path)) return;

		// Voluntary offline: no automation, no noise.
		if (this.connectionStatus === "offline") return;

		// Involuntarily down: the file lands untracked and reconcile-on-reconnect
		// won't add it, so warn that it needs a manual Add once back online.
		if (this.guardsEngaged()) {
			if (this.connectionProbed) {
				this.warnThrottled(file.path, `${file.name} created while Perforce offline — not tracked`);
			}
			return;
		}

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
		} else if (status.tracked && !status.openedForDelete) {
			// p4 won't delete a file that's still open for edit; clear the
			// open first, without restoring the already-gone file to disk.
			if (status.checkedOut) {
				await p4RevertKeep(abs, this.getP4Config(), this.vaultPath);
			}
			await p4Delete(abs, this.getP4Config(), this.vaultPath);
		}
		await this.reconcile([file.path]);
	}

	// ── Native delete interception ───────────────────────────────────
	//
	// Obsidian's file-explorer Delete, the "Delete current file" command,
	// and its hotkey all route through FileManager.promptForDeletion — a
	// public API. Wrapping it lets a tracked file be staged for delete and
	// kept on disk (visible + colored) instead of removed outright. Untracked
	// files, add-pending files, and an unreachable server fall through to
	// Obsidian's normal deletion; programmatic deletes that bypass this funnel
	// are still caught by onFileDelete.

	private patchDeletePrompt(): void {
		const fm = this.app.fileManager as any;
		const original = fm.promptForDeletion;
		if (typeof original !== "function") {
			console.warn(
				"obsidian-p4: app.fileManager.promptForDeletion not found — " +
				"native delete won't be P4-aware on this Obsidian version"
			);
			return;
		}
		this.origPromptForDeletion = original;
		fm.promptForDeletion = (file: TAbstractFile): Promise<boolean> =>
			this.handleDeletePrompt(file);
	}

	private callOriginalDelete(file: TAbstractFile): Promise<boolean> {
		if (!this.origPromptForDeletion) return Promise.resolve(false);
		return this.origPromptForDeletion.call(this.app.fileManager, file);
	}

	private async handleDeletePrompt(file: TAbstractFile): Promise<boolean> {
		if (!this.shouldHandle(file.path)) {
			return this.callOriginalDelete(file);
		}
		// Voluntary offline: guards off, you're on your own — normal delete.
		if (this.connectionStatus === "offline") {
			return this.callOriginalDelete(file);
		}
		// Involuntarily down: block deleting anything P4 is managing so a
		// deletion can't silently diverge from the depot.
		if (this.guardsEngaged()) {
			return this.blockDeleteWhileOffline(file);
		}
		try {
			if (file instanceof TFolder) return await this.markFolderForDelete(file);
			if (file instanceof TFile) return await this.markFileForDelete(file);
		} catch (e) {
			// Never let a P4 hiccup turn into a lost file — leave it in place.
			console.error("obsidian-p4: mark-for-delete failed", e);
			new Notice(`P4: couldn't mark ${file.name} for delete — left in place`);
			return false;
		}
		return this.callOriginalDelete(file);
	}

	/**
	 * Whether a file looks P4-managed using only offline-safe signals: the live
	 * on-disk read-only bit (P4's locked state) plus the cached open/tracked
	 * maps. No server call, so it's usable while down.
	 */
	private isManagedOffline(file: TFile): boolean {
		return (
			this.isReadOnly(this.absPath(file)) ||
			this.fileStates.has(file.path) ||
			this.trackedFiles.has(file.path)
		);
	}

	/**
	 * Delete handler while involuntarily down. Blocks deletion of anything P4 is
	 * managing — a folder counts as managed if any file under it is — so a
	 * deletion can't slip past the depot; a writable, untracked scratch file
	 * falls through to a normal delete.
	 */
	private blockDeleteWhileOffline(file: TAbstractFile): Promise<boolean> {
		const managed = file instanceof TFolder
			? this.collectFiles(file).some((c) => this.isManagedOffline(c))
			: file instanceof TFile
				? this.isManagedOffline(file)
				: false;

		if (managed) {
			new Notice(`Perforce offline — can't delete ${file.name}, reconnect first`, 5000);
			return Promise.resolve(false);
		}
		return this.callOriginalDelete(file);
	}

	/**
	 * Stage a single file for delete. A tracked depot file is opened for
	 * delete with its workspace copy kept (so it stays visible and turns
	 * red); add-pending and untracked files fall through to a real delete,
	 * after which onFileDelete reverts any pending add.
	 */
	private async markFileForDelete(file: TFile): Promise<boolean> {
		const abs = this.absPath(file);
		const status = await p4Fstat(abs, this.getP4Config(), this.vaultPath);

		if (!status.tracked || status.openedForAdd) {
			return this.callOriginalDelete(file);
		}
		if (status.openedForDelete) {
			new Notice(`Already marked for delete: ${file.name}`);
			return false;
		}

		await this.stageDelete(abs, status);
		await this.reconcile([file.path]);
		if (this.fileStates.get(file.path) === "delete") {
			new Notice(`Marked for delete: ${file.name}`);
		} else {
			new Notice(`P4: couldn't mark ${file.name} for delete`);
		}
		return false;
	}

	/**
	 * Stage every tracked file under a folder for delete, keeping each on
	 * disk. Untracked / add-pending children are left untouched, so the
	 * folder stays put holding the now-red files. If nothing under the folder
	 * is in the depot, fall through to Obsidian's normal folder delete.
	 */
	private async markFolderForDelete(folder: TFolder): Promise<boolean> {
		const cfg = this.getP4Config();
		const children = this.collectFiles(folder);
		const statuses = await Promise.all(
			children.map(async (child) => ({
				child,
				status: await p4Fstat(this.absPath(child), cfg, this.vaultPath),
			}))
		);
		const tracked = statuses.filter(
			(s) => s.status.tracked && !s.status.openedForAdd && !s.status.openedForDelete
		);

		if (tracked.length === 0) {
			return this.callOriginalDelete(folder);
		}

		await Promise.all(
			tracked.map(({ child, status }) => this.stageDelete(this.absPath(child), status))
		);
		await this.reconcile(tracked.map((s) => s.child.path));
		new Notice(`Marked ${tracked.length} file(s) for delete in ${folder.name}`);
		return false;
	}

	/**
	 * Open a tracked file for delete while keeping the workspace copy. p4
	 * refuses to delete a file that's open for edit, so clear that first
	 * with revert -k (which also leaves the file on disk untouched).
	 */
	private async stageDelete(abs: string, status: P4FileStatus): Promise<void> {
		if (status.checkedOut) {
			await p4RevertKeep(abs, this.getP4Config(), this.vaultPath);
		}
		await p4DeleteKeep(abs, this.getP4Config(), this.vaultPath);
	}

	// ── Perforce context menu ────────────────────────────────────────
	//
	// A bespoke "Perforce" section on the file/folder right-click menu, built
	// synchronously from the cached fileStates / trackedFiles so items show
	// only when they apply. Lets you choose what to track (Add), undo pending
	// work including a staged deletion (Revert), and stage a delete here too.

	private buildFileMenu(menu: Menu, file: TAbstractFile): void {
		if (!this.serverAvailable || !this.shouldHandle(file.path)) return;

		if (file instanceof TFolder) {
			const children = this.collectFiles(file);
			const untracked = children.filter((c) => this.isUntracked(c.path));
			const opened = children.filter((c) => this.fileStates.has(c.path));
			const deletable = children.filter(
				(c) => this.trackedFiles.has(c.path) && this.fileStates.get(c.path) !== "delete"
			);
			if (untracked.length) {
				this.addMenuItem(menu, "Add folder to Perforce", "plus-circle",
					() => this.menuAdd(untracked, file.name));
			}
			if (opened.length) {
				this.addMenuItem(menu, "Revert folder", "rotate-ccw",
					() => this.menuRevert(opened, file.name));
			}
			if (deletable.length) {
				this.addMenuItem(menu, "Mark folder for delete", "trash-2",
					() => { void this.markFolderForDelete(file); });
			}
			return;
		}

		if (!(file instanceof TFile)) return;
		const state = this.fileStates.get(file.path) ?? null;
		const tracked = this.trackedFiles.has(file.path);

		if (this.isUntracked(file.path)) {
			this.addMenuItem(menu, "Add to Perforce", "plus-circle",
				() => this.menuAdd([file]));
		}
		if (state) {
			this.addMenuItem(menu, "Revert", "rotate-ccw",
				() => this.menuRevert([file]));
		}
		if (tracked && state !== "delete") {
			this.addMenuItem(menu, "Mark for delete", "trash-2",
				() => { void this.markFileForDelete(file); });
		}
	}

	private isUntracked(vaultPath: string): boolean {
		return !this.trackedFiles.has(vaultPath) && !this.fileStates.has(vaultPath);
	}

	private addMenuItem(menu: Menu, title: string, icon: string, onClick: () => void): void {
		menu.addItem((item) => {
			item.setTitle(title).setIcon(icon).setSection("perforce").onClick(onClick);
		});
	}

	/** `p4 add` a set of files, then reconcile and report. */
	private async menuAdd(files: TFile[], folderName?: string): Promise<void> {
		if (!files.length) return;
		const cfg = this.getP4Config();
		await Promise.all(files.map((f) => p4Add(this.absPath(f), cfg, this.vaultPath)));
		await this.reconcile(files.map((f) => f.path));
		const added = files.filter((f) => this.fileStates.get(f.path) === "add").length;
		const name = files[0]?.name ?? "file";
		new Notice(folderName
			? `Added ${added}/${files.length} file(s) in ${folderName}`
			: added ? `Added: ${name}` : `P4: couldn't add ${name}`);
	}

	/**
	 * `p4 revert` a set of files — restores a staged deletion, discards edits,
	 * or drops a pending add (the workspace file is kept in every case). Asks
	 * first if any are open for edit, since reverting that discards real work.
	 */
	private async menuRevert(files: TFile[], folderName?: string): Promise<void> {
		if (!files.length) return;
		const name = files[0]?.name ?? "file";
		const discardsEdits = files.some((f) => this.fileStates.get(f.path) === "edit");
		if (discardsEdits) {
			const what = folderName ? `open files in ${folderName}` : name;
			if (!confirm(`Revert ${what}? This discards pending Perforce edits.`)) return;
		}
		const cfg = this.getP4Config();
		await Promise.all(files.map((f) => p4Revert(this.absPath(f), cfg, this.vaultPath)));
		await this.reconcile(files.map((f) => f.path));
		new Notice(folderName
			? `Reverted ${files.length} file(s) in ${folderName}`
			: `Reverted: ${name}`);
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
			this.makeWritable(absNew);
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
		} catch (e) {
			console.warn(`obsidian-p4: stat failed for ${vaultPath}`, e);
			return;
		}
		this.makeWritable(abs);

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
