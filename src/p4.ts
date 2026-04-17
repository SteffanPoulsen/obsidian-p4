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
	/** Whether the file exists in the depot */
	tracked: boolean;
	/** Whether the file is currently opened for edit */
	checkedOut: boolean;
	/** Whether the file is currently opened for add (new, not yet in depot) */
	openedForAdd: boolean;
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
 *   'edit' covers `edit` and `move/add` (the destination of a move).
 *   'add'  covers `add` and `branch`.
 * `move/delete` and `delete` are intentionally skipped — they describe
 * paths that no longer exist on disk and have no sidebar item to color.
 */
export async function p4Opened(
	config: P4Config,
	cwd: string,
	paths?: string[]
): Promise<{ localPath: string; action: "edit" | "add" }[]> {
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

function parseOpenedRecords(
	stdout: string
): { localPath: string; action: "edit" | "add" }[] {
	const result: { localPath: string; action: "edit" | "add" }[] = [];
	const flush = (cur: { path?: string; action?: string }) => {
		if (!cur.path || !cur.action) return;
		let mapped: "edit" | "add" | null = null;
		if (cur.action === "edit" || cur.action === "move/add") mapped = "edit";
		else if (cur.action === "add" || cur.action === "branch") mapped = "add";
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
		// Match the `action` field exactly — not `headAction` / `otherAction`.
		// p4 fstat prints fields as `... <name> <value>` per line.
		const tracked = /^\.\.\. depotFile /m.test(stdout);
		const checkedOut = /^\.\.\. action edit\b/m.test(stdout);
		const openedForAdd = /^\.\.\. action add\b/m.test(stdout);
		return { tracked, checkedOut, openedForAdd };
	} catch {
		return { tracked: false, checkedOut: false, openedForAdd: false };
	}
}
