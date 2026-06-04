import { exec, spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Thrown by runP4 when a p4 command fails with an authentication error — an
 * expired login ticket or a missing/invalid password. Lets the plugin tell a
 * dead session apart from an ordinary command failure and mark itself expired.
 */
export class P4AuthError extends Error {}

/**
 * Detect the signature of a Perforce auth failure in command stderr. Matched
 * broadly and case-insensitively so minor server-version wording differences
 * still register.
 */
export function isAuthFailure(stderr: string): boolean {
	const s = stderr.toLowerCase();
	return (
		s.includes("session has expired") ||
		s.includes("password (p4passwd) invalid or unset") ||
		s.includes("logged out, please login again")
	);
}

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
	/**
	 * Whether the depot head revision is itself a deletion (`headAction
	 * delete` / `move/delete`). Combined with `!tracked` (no have-rev) this is
	 * the affirmative "deleted at head and no longer synced" signal — a staged
	 * delete that has been submitted — used to clean up the kept `-k` copy.
	 */
	deletedAtHead: boolean;
}

/**
 * Walk up from `cwd` to the nearest `.p4config` and parse its KEY=VALUE lines.
 * Returns {} if none is found or it can't be read. Lets the plugin supply the
 * connection params itself rather than depending on p4's cwd-based walk-up or
 * on the variables being present in the (GUI) environment.
 */
function readP4Config(cwd: string): Record<string, string> {
	let dir = cwd;
	for (;;) {
		try {
			return parseP4Config(readFileSync(join(dir, ".p4config"), "utf8"));
		} catch {
			const parent = dirname(dir);
			if (parent === dir) return {};
			dir = parent;
		}
	}
}

function parseP4Config(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		out[trimmed.substring(0, eq).trim()] = trimmed.substring(eq + 1).trim();
	}
	return out;
}

/**
 * Build the environment for p4 commands from the plugin's own configuration —
 * never from ambient P4 variables, which the GUI environment usually lacks.
 * In .p4config mode we read the file ourselves and inject its values (and keep
 * P4CONFIG set, so p4's walk-up still applies where it can; identical values
 * when it does). In manual mode we pass the settings fields directly. Either
 * way the connection is exactly what the user configured, independent of how
 * Obsidian was launched or whether `cwd` reaches the config file.
 */
function buildEnv(config: P4Config, cwd: string): NodeJS.ProcessEnv {
	const env = { ...process.env };

	if (config.useP4Config) {
		Object.assign(env, readP4Config(cwd));
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
	try {
		return await execAsync(`p4 ${args}`, {
			cwd,
			env: buildEnv(config, cwd),
			timeout: 10000,
		});
	} catch (e: any) {
		// exec rejects with an Error carrying the captured stderr/stdout. If
		// it's an auth failure, surface a typed error so the plugin can mark
		// the session expired; otherwise propagate the original unchanged.
		const stderr = `${e?.stderr ?? ""} ${e?.message ?? ""}`;
		if (isAuthFailure(stderr)) throw new P4AuthError(stderr.trim());
		throw e;
	}
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

/**
 * Probe whether the current login ticket is still valid, cheaply. `p4 login -s`
 * touches the server but does no work, so it's the canonical "is my session
 * alive" check. Maps the outcome onto the three states the heartbeat cares
 * about:
 *   "ok"          — ticket valid, session live.
 *   "expired"     — reached the server but the ticket is dead (P4AuthError).
 *   "unreachable" — couldn't talk to the server at all.
 */
export async function p4LoginStatus(
	config: P4Config,
	cwd: string
): Promise<"ok" | "expired" | "unreachable"> {
	try {
		await runP4("login -s", config, cwd);
		return "ok";
	} catch (e) {
		return e instanceof P4AuthError ? "expired" : "unreachable";
	}
}

/** Flatten p4's multi-line output to a single line and drop the password prompt. */
function collapseOutput(s: string): string {
	return s
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.join(" ")
		.replace(/^enter password:\s*/i, "")
		.trim();
}

/**
 * Obtain a session ticket by feeding the password to `p4 login` on stdin — the
 * non-interactive path p4 takes when stdin isn't a TTY. Spawned directly rather
 * than shelled through a string, so the password never lands in a command line
 * or needs escaping. The ticket persists in P4TICKETS, so later commands
 * authenticate until it next expires; the password is used transiently here and
 * never stored. Resolves (never rejects) with the outcome and a toast-ready
 * message on failure.
 */
export async function p4Login(
	config: P4Config,
	cwd: string,
	password: string
): Promise<{ ok: boolean; message: string }> {
	return new Promise((resolve) => {
		const child = spawn("p4", ["login"], { cwd, env: buildEnv(config, cwd) });
		let stdout = "";
		let stderr = "";
		let settled = false;

		let timer: ReturnType<typeof setTimeout>;
		const finish = (r: { ok: boolean; message: string }): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(r);
		};
		timer = setTimeout(() => {
			finish({ ok: false, message: "login timed out — is the server reachable?" });
			child.kill();
		}, 15000);

		child.stdout.on("data", (d) => { stdout += d.toString(); });
		child.stderr.on("data", (d) => { stderr += d.toString(); });
		child.on("error", (e) => finish({ ok: false, message: e.message }));
		child.on("close", (code) => {
			if (code === 0) finish({ ok: true, message: collapseOutput(stdout) });
			else finish({
				ok: false,
				message: collapseOutput(stderr || stdout) || `p4 login exited ${code}`,
			});
		});

		child.stdin.write(password + "\n");
		child.stdin.end();
	});
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
			} catch (e) {
				if (e instanceof P4AuthError) throw e;
				return [];
			}
		}));
		return results.flat();
	}

	try {
		const { stdout } = await runP4("-ztag fstat -Ro -Op ./...", config, cwd);
		return parseOpenedRecords(stdout);
	} catch (e) {
		if (e instanceof P4AuthError) throw e;
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
			} catch (e) {
				if (e instanceof P4AuthError) throw e;
				return [];
			}
		}));
		return results.flat();
	}

	try {
		const { stdout } = await runP4("have ./...", config, cwd);
		return parse(stdout);
	} catch (e) {
		if (e instanceof P4AuthError) throw e;
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
		const deletedAtHead = /^\.\.\. headAction (delete|move\/delete)\b/m.test(stdout);
		return { tracked, checkedOut, openedForAdd, openedForDelete, deletedAtHead };
	} catch {
		return { tracked: false, checkedOut: false, openedForAdd: false, openedForDelete: false, deletedAtHead: false };
	}
}
