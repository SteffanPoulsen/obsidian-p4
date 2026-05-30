import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface P4Config {
	useP4Config: boolean;
	p4Port: string;
	p4Client: string;
	p4User: string;
}

export interface P4FileStatus {
	/**
	 * Whether the file is synced into this workspace (has a have-revision) —
	 * the same notion of "tracked" the sidebar uses (`p4 have`). A file that
	 * has only a `depotFile` record but no have-rev — deleted at head, or a
	 * depot path never synced into this workspace — reads as untracked, so
	 * delete/rename fall through to plain-file handling instead of issuing a
	 * p4 op the server would reject as "not on client".
	 */
	tracked: boolean;
	/** Whether the file is currently opened for edit */
	checkedOut: boolean;
	/** Whether the file is currently opened for add (new, not yet in depot) */
	openedForAdd: boolean;
	/** Whether the file is currently opened for delete */
	openedForDelete: boolean;
}

/**
 * Build the environment variables for p4 commands.
 * If useP4Config is true, we set P4CONFIG so p4 finds the config file.
 * Otherwise we pass P4PORT, P4CLIENT, P4USER directly.
 */
function buildEnv(config: P4Config, cwd: string): NodeJS.ProcessEnv {
	const env = { ...process.env };

	if (config.useP4Config) {
		env["P4CONFIG"] = ".p4config";
	} else {
		if (config.p4Port) env["P4PORT"] = config.p4Port;
		if (config.p4Client) env["P4CLIENT"] = config.p4Client;
		if (config.p4User) env["P4USER"] = config.p4User;
	}

	return env;
}

async function runP4(
	args: string,
	config: P4Config,
	cwd: string
): Promise<{ stdout: string; stderr: string }> {
	return execAsync(`p4 ${args}`, {
		cwd,
		env: buildEnv(config, cwd),
		timeout: 10000,
	});
}

/** Check server connectivity, return client/workspace name or null. */
export async function p4Info(
	config: P4Config,
	cwd: string
): Promise<string | null> {
	try {
		const { stdout } = await runP4("info", config, cwd);
		const match = stdout.match(/Client name:\s*(.+)/);
		return match && match[1] ? match[1].trim() : "connected";
	} catch {
		return null;
	}
}

// ── Actions ─────────────────────────────────────────────────────
//
// These are fire-and-forget requests to p4. They do not return
// state — the plugin reconciles via `p4Opened` after each action
// to learn what actually stuck.

export async function p4Edit(filePath: string, config: P4Config, cwd: string): Promise<void> {
	try { await runP4(`edit "${filePath}"`, config, cwd); } catch {}
}

export async function p4Revert(filePath: string, config: P4Config, cwd: string): Promise<void> {
	try { await runP4(`revert "${filePath}"`, config, cwd); } catch {}
}

/**
 * Clear a pending open (edit/add) in the server's metadata without touching
 * the workspace file (`-k`). Used before `delete -k` to drop an edit that
 * would otherwise block the delete, and so a file that's already gone from
 * disk isn't restored.
 */
export async function p4RevertKeep(filePath: string, config: P4Config, cwd: string): Promise<void> {
	try { await runP4(`revert -k "${filePath}"`, config, cwd); } catch {}
}

export async function p4RevertUnchanged(filePath: string, config: P4Config, cwd: string): Promise<void> {
	try { await runP4(`revert -a "${filePath}"`, config, cwd); } catch {}
}

export async function p4Add(filePath: string, config: P4Config, cwd: string): Promise<void> {
	try { await runP4(`add "${filePath}"`, config, cwd); } catch {}
}

export async function p4Delete(filePath: string, config: P4Config, cwd: string): Promise<void> {
	try { await runP4(`delete "${filePath}"`, config, cwd); } catch {}
}

/**
 * Open a file for delete on the server while leaving the workspace copy in
 * place (`-k`). Lets a staged deletion stay visible in the file explorer so
 * it can be colored — the depot drops the file on submit.
 */
export async function p4DeleteKeep(filePath: string, config: P4Config, cwd: string): Promise<void> {
	try { await runP4(`delete -k "${filePath}"`, config, cwd); } catch {}
}

/**
 * Move/rename. `-k` tells p4 the workspace file has already been
 * moved externally (Obsidian renamed it before our handler fires),
 * so p4 just updates its records. p4 leaves the new path read-only
 * after a -k move; the caller is responsible for the chmod.
 */
export async function p4Move(
	fromPath: string,
	toPath: string,
	config: P4Config,
	cwd: string
): Promise<void> {
	try {
		await runP4(`edit -k "${fromPath}"`, config, cwd);
		await runP4(`move -k "${fromPath}" "${toPath}"`, config, cwd);
	} catch {}
}

// ── Queries ─────────────────────────────────────────────────────

/**
 * Ask p4 which files are opened by the current user. With no `paths`,
 * sweeps the workspace under `cwd`. With `paths`, queries each file
 * individually (in parallel) — needed because `p4 fstat` exits non-zero
 * when given a mix of opened and unopened paths, which would lose
 * partial output.
 *
 * Returns absolute local-OS paths paired with the visual action:
 *   'edit'   covers `edit` and `move/add` (the destination of a move).
 *   'add'    covers `add` and `branch`.
 *   'delete' covers `delete` and `move/delete`.
 * Files opened for delete are surfaced because the plugin stages them with
 * `delete -k`, which leaves the workspace file in place to be colored. A
 * `move/delete` (the source of a move) has no file on disk, so coloring it
 * is a harmless no-op.
 */
export async function p4Opened(
	config: P4Config,
	cwd: string,
	paths?: string[]
): Promise<{ localPath: string; action: "edit" | "add" | "delete" }[]> {
	if (paths && paths.length > 0) {
		const results = await Promise.all(paths.map(async (p) => {
			try {
				const { stdout } = await runP4(`-ztag fstat -Op "${p}"`, config, cwd);
				return parseOpenedRecords(stdout);
			} catch {
				return [];
			}
		}));
		return results.flat();
	}

	try {
		const { stdout } = await runP4("-ztag fstat -Ro -Op ./...", config, cwd);
		return parseOpenedRecords(stdout);
	} catch {
		return [];
	}
}

/**
 * List the files under `cwd` (or the given `paths`) that exist in the depot,
 * i.e. are tracked. Uses `p4 have`, whose lines read `<depotFile>#rev - <localPath>`;
 * we keep the local path. Files opened only for `add` aren't synced yet, so they
 * don't appear here — they're surfaced via `p4Opened` instead. Returns absolute
 * local-OS paths.
 */
export async function p4Have(
	config: P4Config,
	cwd: string,
	paths?: string[]
): Promise<string[]> {
	const parse = (stdout: string): string[] => {
		const out: string[] = [];
		for (const line of stdout.split("\n")) {
			const m = line.match(/ - (.+)$/);
			if (m && m[1]) out.push(m[1].trim());
		}
		return out;
	};

	if (paths && paths.length > 0) {
		const results = await Promise.all(paths.map(async (p) => {
			try {
				const { stdout } = await runP4(`have "${p}"`, config, cwd);
				return parse(stdout);
			} catch {
				return [];
			}
		}));
		return results.flat();
	}

	try {
		const { stdout } = await runP4("have ./...", config, cwd);
		return parse(stdout);
	} catch {
		return [];
	}
}

function parseOpenedRecords(
	stdout: string
): { localPath: string; action: "edit" | "add" | "delete" }[] {
	const result: { localPath: string; action: "edit" | "add" | "delete" }[] = [];
	const flush = (cur: { path?: string; action?: string }) => {
		if (!cur.path || !cur.action) return;
		let mapped: "edit" | "add" | "delete" | null = null;
		if (cur.action === "edit" || cur.action === "move/add") mapped = "edit";
		else if (cur.action === "add" || cur.action === "branch") mapped = "add";
		else if (cur.action === "delete" || cur.action === "move/delete") mapped = "delete";
		if (mapped) result.push({ localPath: cur.path, action: mapped });
	};

	let cur: { path?: string; action?: string } = {};
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") {
			flush(cur);
			cur = {};
			continue;
		}
		const m = line.match(/^\.\.\. (\S+) (.*)$/);
		if (!m) continue;
		if (m[1] === "path") cur.path = m[2];
		else if (m[1] === "action") cur.action = m[2];
	}
	flush(cur);
	return result;
}

/**
 * Get the P4 status of a file using fstat. Used as a query to branch
 * action handlers (e.g. rename → move vs add) — not as a state source
 * for sidebar coloring. Coloring goes through `p4Opened` + `reconcile`.
 */
export async function p4Fstat(
	filePath: string,
	config: P4Config,
	cwd: string
): Promise<P4FileStatus> {
	try {
		const { stdout } = await runP4(`fstat "${filePath}"`, config, cwd);
		// p4 fstat prints fields as `... <name> <value>` per line. Match each
		// field exactly — e.g. `action`, not `headAction` / `otherAction`.
		//
		// `tracked` keys off `haveRev`, not `depotFile`: `depotFile` is present
		// even for files deleted at head or never synced into this workspace,
		// whereas `haveRev` is the precise "I have this synced" signal — the
		// same files `p4 have` reports (the sidebar's tracked source).
		const tracked = /^\.\.\. haveRev /m.test(stdout);
		const checkedOut = /^\.\.\. action edit\b/m.test(stdout);
		const openedForAdd = /^\.\.\. action add\b/m.test(stdout);
		const openedForDelete = /^\.\.\. action (delete|move\/delete)\b/m.test(stdout);
		return { tracked, checkedOut, openedForAdd, openedForDelete };
	} catch {
		return { tracked: false, checkedOut: false, openedForAdd: false, openedForDelete: false };
	}
}
