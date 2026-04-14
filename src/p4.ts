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

/** Open a file for edit (checkout). */
export async function p4Edit(
	filePath: string,
	config: P4Config,
	cwd: string
): Promise<boolean> {
	try {
		const { stdout } = await runP4(`edit "${filePath}"`, config, cwd);
		// p4 edit prints "//depot/path#rev - opened for edit" on success
		return stdout.includes("opened for edit");
	} catch {
		return false;
	}
}

/** Revert a file (undo checkout, restore read-only). */
export async function p4Revert(
	filePath: string,
	config: P4Config,
	cwd: string
): Promise<boolean> {
	try {
		const { stdout } = await runP4(`revert "${filePath}"`, config, cwd);
		return stdout.includes("reverted") || stdout.includes("was edit");
	} catch {
		return false;
	}
}

/** Revert a file only if its content matches the depot version. */
export async function p4RevertUnchanged(
	filePath: string,
	config: P4Config,
	cwd: string
): Promise<boolean> {
	try {
		const { stdout } = await runP4(`revert -a "${filePath}"`, config, cwd);
		return stdout.includes("reverted");
	} catch {
		return false;
	}
}

/** Mark a new file for add. */
export async function p4Add(
	filePath: string,
	config: P4Config,
	cwd: string
): Promise<boolean> {
	try {
		const { stdout } = await runP4(`add "${filePath}"`, config, cwd);
		return stdout.includes("opened for add");
	} catch {
		return false;
	}
}

/** Mark a file for delete. */
export async function p4Delete(
	filePath: string,
	config: P4Config,
	cwd: string
): Promise<boolean> {
	try {
		const { stdout } = await runP4(`delete "${filePath}"`, config, cwd);
		return stdout.includes("opened for delete");
	} catch {
		return false;
	}
}

/** Move/rename a file. Requires the source to be opened for edit. */
export async function p4Move(
	fromPath: string,
	toPath: string,
	config: P4Config,
	cwd: string
): Promise<boolean> {
	try {
		// Ensure source is open for edit first
		await runP4(`edit "${fromPath}"`, config, cwd);
		const { stdout } = await runP4(`move "${fromPath}" "${toPath}"`, config, cwd);
		return stdout.includes("moved from");
	} catch {
		return false;
	}
}

/**
 * List all files currently opened (for edit/add/move) in the workspace
 * under `cwd`. Returns absolute local filesystem paths paired with the
 * simplified action ('edit' covers edit and move/add|delete; 'add' covers
 * add and branch). Used at startup to seed the sidebar coloring cache.
 */
export async function p4Opened(
	config: P4Config,
	cwd: string
): Promise<{ localPath: string; action: "edit" | "add" }[]> {
	try {
		// -Ro: only files opened by the current user
		// -Op: emit 'path' field in local-OS syntax (e.g. /home/… or C:\…)
		const { stdout } = await runP4(
			"-ztag fstat -Ro -Op ./...",
			config,
			cwd
		);

		const result: { localPath: string; action: "edit" | "add" }[] = [];
		const flush = (cur: { path?: string; action?: string }) => {
			if (!cur.path || !cur.action) return;
			let mapped: "edit" | "add" | null = null;
			if (cur.action === "edit" || cur.action.startsWith("move/")) mapped = "edit";
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
	} catch {
		return [];
	}
}

/**
 * Get the P4 status of a file using fstat.
 * Returns whether the file is tracked and whether it's currently checked out.
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
		// "no such file" or connection errors
		return { tracked: false, checkedOut: false, openedForAdd: false };
	}
}
