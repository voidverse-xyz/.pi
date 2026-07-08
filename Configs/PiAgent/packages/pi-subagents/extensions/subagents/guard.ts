/**
 * Sandbox guard — hard read-only / path enforcement for delegated children.
 *
 * delegate.ts spawns a sandboxed child with one or both of:
 *
 *   - PI_SUBAGENT_READONLY=1           the child may not mutate anything
 *   - PI_SUBAGENT_ALLOWED_PATHS=[...]  JSON array of absolute roots the child's
 *                                      file tools may touch
 *
 * This module runs IN THE CHILD (the extension loads in every pi process) and
 * enforces the policy with a blocking `tool_call` handler — a hard gate, not a
 * prompt suggestion. Because childEnv() spreads process.env, a sandboxed child
 * passes its own restrictions down to any grandchildren automatically, and
 * mergeSandbox() only ever tightens, so nesting can't escape the sandbox.
 *
 * Rules:
 *   - readOnly: `edit`/`write` are blocked; `bash` runs only commands that
 *     pi-command-safety's classifier proves read-only (classifyCommand === null).
 *   - allowedPaths: the built-in file tools (`read`, `edit`, `write`, `ls`,
 *     `find`, `grep`) may only touch paths inside the roots; `bash` additionally
 *     must be provably read-only, contain no `..` traversal, keep its absolute /
 *     `~` path tokens inside the roots, and the child's cwd itself must be inside
 *     a root (otherwise relative reads would silently escape — blocked instead).
 *
 * Known limits (documented, deliberate): containment uses lexical resolution
 * (no realpath), so a pre-existing symlink inside a root can point outside it;
 * tools from other extensions that take paths are not path-checked (readOnly
 * still blocks the built-in mutators, and bash stays classified). The bash rules
 * fail toward blocking — if the classifier can't be loaded, bash is blocked
 * entirely while sandboxed.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const READONLY_ENV = "PI_SUBAGENT_READONLY";
export const ALLOWED_PATHS_ENV = "PI_SUBAGENT_ALLOWED_PATHS";

/** The sandbox a delegated run should get: nothing, read-only, and/or path roots. */
export interface Sandbox {
	readOnly: boolean;
	/** Absolute roots. undefined = unrestricted paths. */
	allowedPaths?: string[];
}

/** The sandbox THIS process runs under (from env; empty at the unsandboxed top level). */
export function currentSandbox(): Sandbox {
	let allowedPaths: string[] | undefined;
	const raw = process.env[ALLOWED_PATHS_ENV];
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) allowedPaths = parsed.filter((p): p is string => typeof p === "string");
		} catch {
			// Unparseable env means an unknown policy — treat as "no paths allowed"
			// rather than unrestricted (fail toward blocking).
			allowedPaths = [];
		}
	}
	return { readOnly: process.env[READONLY_ENV] === "1", allowedPaths };
}

/** rel-based containment: p is root or inside it. Lexical (see header). */
function isWithin(root: string, p: string): boolean {
	const rel = path.relative(root, p);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function withinAny(roots: string[], p: string): boolean {
	return roots.some((r) => isWithin(r, p));
}

/**
 * Merge sandbox layers so the result only ever TIGHTENS: readOnly is sticky once
 * any layer sets it; allowedPaths intersect (an inner list is kept only where it
 * falls inside the outer roots — an inner root outside them is dropped, and if
 * nothing survives the effective set is empty = nothing reachable, never wider).
 * `base` is what this process inherited (currentSandbox()), `layers` are the
 * agent frontmatter and the per-call params, loosest-first. Relative roots in a
 * layer resolve against `cwd` (the child's spawn cwd).
 */
export function mergeSandbox(base: Sandbox, cwd: string, ...layers: Array<{ readOnly?: boolean; allowedPaths?: string[] } | undefined>): Sandbox {
	let readOnly = base.readOnly;
	let roots = base.allowedPaths?.map((p) => path.resolve(cwd, p));
	for (const layer of layers) {
		if (!layer) continue;
		if (layer.readOnly) readOnly = true;
		if (layer.allowedPaths && layer.allowedPaths.length > 0) {
			const next = layer.allowedPaths.map((p) => path.resolve(cwd, p));
			roots = roots === undefined ? next : next.filter((p) => withinAny(roots!, p));
		}
	}
	return { readOnly, allowedPaths: roots };
}

/** One-line summary for prompts/UI, e.g. "read-only; paths: ~/repo/src, ~/repo/docs". */
export function describeSandbox(sandbox: Sandbox): string {
	const bits: string[] = [];
	if (sandbox.readOnly) bits.push("read-only");
	if (sandbox.allowedPaths) {
		const home = os.homedir();
		const shown = sandbox.allowedPaths.map((p) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p));
		bits.push(`paths: ${shown.join(", ") || "(none)"}`);
	}
	return bits.join("; ");
}

/** True when the sandbox actually restricts something. */
export function isSandboxed(sandbox: Sandbox): boolean {
	return sandbox.readOnly || sandbox.allowedPaths !== undefined;
}

// Built-in mutating tools (blocked under readOnly) and path-taking tools
// (containment-checked under allowedPaths). Built-ins all use `input.path`;
// `file_path` is checked too for tolerance toward same-shaped custom tools.
const MUTATING_TOOLS = new Set(["edit", "write"]);
const PATH_TOOLS = new Set(["read", "edit", "write", "ls", "find", "grep"]);

/** Absolute (`/…`) and `~…` tokens in a bash command, resolved; best-effort. */
function bashPathTokens(command: string): string[] {
	const tokens = command.split(/[\s"'`;|&<>()=]+/).filter(Boolean);
	const out: string[] = [];
	for (const t of tokens) {
		if (t.startsWith("/")) out.push(path.resolve(t));
		else if (t === "~" || t.startsWith("~/")) out.push(path.resolve(os.homedir(), t.slice(2)));
	}
	return out;
}

/**
 * Register the blocking tool_call gate. No-op unless this process was spawned
 * sandboxed (env present), so the top level and unsandboxed children pay nothing.
 */
export function registerSandboxGuard(pi: ExtensionAPI): void {
	const sandbox = currentSandbox();
	if (!isSandboxed(sandbox)) return;

	const roots = sandbox.allowedPaths;

	// pi-command-safety's zero-dep classifier: classifyCommand(cmd) === null means
	// "provably read-only". Imported lazily from the sibling monorepo package (no
	// package exports to go through); if it can't be loaded, bash is blocked
	// entirely while sandboxed — fail toward blocking, never toward allowing.
	const classifierPromise: Promise<((cmd: string) => unknown) | null> = import(
		"../../../pi-command-safety/extensions/command-safety/categories.ts"
	).then(
		(m) => (typeof m.classifyCommand === "function" ? m.classifyCommand : null),
		() => null,
	);

	pi.on("tool_call", async (event) => {
		const toolName = event.toolName;
		const input = (event.input ?? {}) as Record<string, unknown>;

		if (sandbox.readOnly && MUTATING_TOOLS.has(toolName)) {
			return { block: true, reason: `sandbox: this agent is read-only — ${toolName} is not available.` };
		}

		if (roots && PATH_TOOLS.has(toolName)) {
			const rawPath = (typeof input.path === "string" && input.path) || (typeof input.file_path === "string" && input.file_path) || undefined;
			// Optional-path tools (ls/find/grep) default to cwd — check that too.
			const target = path.resolve(process.cwd(), rawPath ?? ".");
			if (!withinAny(roots, target)) {
				return {
					block: true,
					reason:
						`sandbox: "${target}" is outside this agent's allowed paths ` +
						`(${roots.join(", ") || "none"}). Pass a path inside them.`,
				};
			}
		}

		if (toolName === "bash") {
			const command = typeof input.command === "string" ? input.command : "";
			const classify = await classifierPromise;
			if (!classify) {
				return { block: true, reason: "sandbox: bash is unavailable (command classifier not loaded)." };
			}
			if (classify(command) !== null) {
				return {
					block: true,
					reason:
						"sandbox: only provably read-only commands may run here (e.g. ls, cat, grep, rg, find, git status/log/diff; " +
						"no redirections, pipes to unknown tools, or command substitution). Use the read/grep/find tools instead.",
				};
			}
			if (roots) {
				if (/(^|[\s/"'=:])\.\.(\/|$|[\s"':])/.test(command)) {
					return { block: true, reason: "sandbox: `..` path traversal is not allowed under a path sandbox." };
				}
				if (!withinAny(roots, process.cwd())) {
					return {
						block: true,
						reason:
							"sandbox: bash is blocked because the working directory is outside the allowed paths " +
							"(relative paths would escape). Use the read/grep/find/ls tools with explicit allowed paths.",
					};
				}
				for (const p of bashPathTokens(command)) {
					if (!withinAny(roots, p)) {
						return {
							block: true,
							reason: `sandbox: "${p}" is outside this agent's allowed paths (${roots.join(", ")}).`,
						};
					}
				}
			}
		}

		return undefined;
	});
}
