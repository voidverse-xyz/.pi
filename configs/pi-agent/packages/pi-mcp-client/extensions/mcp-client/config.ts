import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SERVERS = 32;
const MAX_ARGS = 64;
const MAX_ENV_MAPPINGS = 64;
const MAX_STRING_LENGTH = 8 * 1024;
const SERVER_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const DEFAULT_EAGER_TOOL_LIMIT = 24;
export const DEFAULT_EAGER_SCHEMA_BYTES = 32 * 1024;
export const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

export type McpConfirmationMode = "always" | "never";

export interface McpServerConfig {
	id: string;
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	confirm: McpConfirmationMode;
	autoRestart: boolean;
	startupTimeoutMs: number;
	callTimeoutMs: number;
}

export interface McpClientConfig {
	path: string;
	found: boolean;
	eagerToolLimit: number;
	eagerSchemaBytes: number;
	servers: McpServerConfig[];
	warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(
	value: unknown,
	fallback: number,
	minimum: number,
	maximum: number,
	label: string,
	warnings: string[],
): number {
	if (value === undefined) return fallback;
	if (Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum) {
		return value as number;
	}
	warnings.push(`${label} must be an integer from ${minimum} to ${maximum}; using ${fallback}`);
	return fallback;
}

function optionalBoolean(
	value: unknown,
	fallback: boolean,
	label: string,
	warnings: string[],
): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	warnings.push(`${label} must be a boolean; using ${fallback}`);
	return fallback;
}

function parseStringArray(value: unknown, label: string, warnings: string[]): string[] | undefined {
	if (value === undefined) return [];
	if (
		!Array.isArray(value)
		|| value.length > MAX_ARGS
		|| value.some((entry) => typeof entry !== "string" || entry.length > MAX_STRING_LENGTH)
	) {
		warnings.push(`${label} must contain at most ${MAX_ARGS} strings of at most ${MAX_STRING_LENGTH} characters`);
		return undefined;
	}
	return [...value];
}

function parseEnvironmentMapping(
	value: unknown,
	label: string,
	warnings: string[],
): Record<string, string> | undefined {
	if (value === undefined) return {};
	if (!isRecord(value) || Object.keys(value).length > MAX_ENV_MAPPINGS) {
		warnings.push(`${label} must be an object with at most ${MAX_ENV_MAPPINGS} environment-variable mappings`);
		return undefined;
	}

	const mapping: Record<string, string> = {};
	for (const [childName, sourceName] of Object.entries(value)) {
		if (!ENV_NAME_RE.test(childName) || typeof sourceName !== "string" || !ENV_NAME_RE.test(sourceName)) {
			warnings.push(`${label} keys and values must be environment-variable names`);
			return undefined;
		}
		mapping[childName] = sourceName;
	}
	return mapping;
}

function parseServer(
	id: string,
	value: unknown,
	defaultCwd: string,
	warnings: string[],
): McpServerConfig | undefined {
	const label = `servers.${id}`;
	if (!SERVER_ID_RE.test(id)) {
		warnings.push(`${label} has an invalid id; use lowercase letters, digits, underscores, or hyphens`);
		return undefined;
	}
	if (!isRecord(value)) {
		warnings.push(`${label} must be an object`);
		return undefined;
	}

	const knownKeys = new Set([
		"enabled",
		"command",
		"args",
		"cwd",
		"env",
		"confirm",
		"autoRestart",
		"startupTimeoutMs",
		"callTimeoutMs",
	]);
	for (const key of Object.keys(value)) {
		if (!knownKeys.has(key)) warnings.push(`${label}.${key} is unknown and was ignored`);
	}

	if (value.enabled === false) return undefined;
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
		warnings.push(`${label}.enabled must be a boolean`);
		return undefined;
	}
	if (
		typeof value.command !== "string"
		|| value.command.trim().length === 0
		|| value.command.length > MAX_STRING_LENGTH
	) {
		warnings.push(`${label}.command must be a non-empty string of at most ${MAX_STRING_LENGTH} characters`);
		return undefined;
	}

	const args = parseStringArray(value.args, `${label}.args`, warnings);
	const env = parseEnvironmentMapping(value.env, `${label}.env`, warnings);
	if (!args || !env) return undefined;

	const cwd = value.cwd === undefined ? defaultCwd : value.cwd;
	if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.length > MAX_STRING_LENGTH) {
		warnings.push(`${label}.cwd must be an absolute path of at most ${MAX_STRING_LENGTH} characters`);
		return undefined;
	}

	const confirm = value.confirm ?? "always";
	if (confirm !== "always" && confirm !== "never") {
		warnings.push(`${label}.confirm must be "always" or "never"`);
		return undefined;
	}

	return {
		id,
		command: value.command.trim(),
		args,
		cwd,
		env,
		confirm,
		autoRestart: optionalBoolean(value.autoRestart, true, `${label}.autoRestart`, warnings),
		startupTimeoutMs: boundedInteger(
			value.startupTimeoutMs,
			DEFAULT_STARTUP_TIMEOUT_MS,
			1_000,
			300_000,
			`${label}.startupTimeoutMs`,
			warnings,
		),
		callTimeoutMs: boundedInteger(
			value.callTimeoutMs,
			DEFAULT_CALL_TIMEOUT_MS,
			1_000,
			600_000,
			`${label}.callTimeoutMs`,
			warnings,
		),
	};
}

export function resolveMcpConfigPath(agentDir: string, override = process.env.PI_MCP_CONFIG): string {
	if (!override?.trim()) return join(agentDir, "mcp.json");
	if (!isAbsolute(override)) {
		throw new Error("PI_MCP_CONFIG must be an absolute path");
	}
	return override;
}

export async function loadMcpConfig(path: string, defaultCwd: string): Promise<McpClientConfig> {
	const warnings: string[] = [];
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				path,
				found: false,
				eagerToolLimit: DEFAULT_EAGER_TOOL_LIMIT,
				eagerSchemaBytes: DEFAULT_EAGER_SCHEMA_BYTES,
				servers: [],
				warnings,
			};
		}
		return {
			path,
			found: true,
			eagerToolLimit: DEFAULT_EAGER_TOOL_LIMIT,
			eagerSchemaBytes: DEFAULT_EAGER_SCHEMA_BYTES,
			servers: [],
			warnings: ["MCP configuration could not be read"],
		};
	}

	if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
		return {
			path,
			found: true,
			eagerToolLimit: DEFAULT_EAGER_TOOL_LIMIT,
			eagerSchemaBytes: DEFAULT_EAGER_SCHEMA_BYTES,
			servers: [],
			warnings: [`MCP configuration exceeds ${MAX_CONFIG_BYTES} bytes`],
		};
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return {
			path,
			found: true,
			eagerToolLimit: DEFAULT_EAGER_TOOL_LIMIT,
			eagerSchemaBytes: DEFAULT_EAGER_SCHEMA_BYTES,
			servers: [],
			warnings: ["MCP configuration is not valid JSON"],
		};
	}
	if (!isRecord(raw)) {
		return {
			path,
			found: true,
			eagerToolLimit: DEFAULT_EAGER_TOOL_LIMIT,
			eagerSchemaBytes: DEFAULT_EAGER_SCHEMA_BYTES,
			servers: [],
			warnings: ["MCP configuration root must be an object"],
		};
	}

	for (const key of Object.keys(raw)) {
		if (!new Set(["version", "eagerToolLimit", "eagerSchemaBytes", "servers"]).has(key)) {
			warnings.push(`${key} is unknown and was ignored`);
		}
	}
	if (raw.version !== 1) warnings.push("version must be 1; no MCP servers were loaded");
	if (raw.version !== 1 || !isRecord(raw.servers)) {
		if (raw.version === 1) warnings.push("servers must be an object");
		return {
			path,
			found: true,
			eagerToolLimit: DEFAULT_EAGER_TOOL_LIMIT,
			eagerSchemaBytes: DEFAULT_EAGER_SCHEMA_BYTES,
			servers: [],
			warnings,
		};
	}

	const entries = Object.entries(raw.servers);
	if (entries.length > MAX_SERVERS) {
		warnings.push(`servers contains more than ${MAX_SERVERS} entries; no MCP servers were loaded`);
		return {
			path,
			found: true,
			eagerToolLimit: DEFAULT_EAGER_TOOL_LIMIT,
			eagerSchemaBytes: DEFAULT_EAGER_SCHEMA_BYTES,
			servers: [],
			warnings,
		};
	}

	const servers: McpServerConfig[] = [];
	for (const [id, value] of entries) {
		const server = parseServer(id, value, defaultCwd, warnings);
		if (server) servers.push(server);
	}

	return {
		path,
		found: true,
		eagerToolLimit: boundedInteger(
			raw.eagerToolLimit,
			DEFAULT_EAGER_TOOL_LIMIT,
			0,
			128,
			"eagerToolLimit",
			warnings,
		),
		eagerSchemaBytes: boundedInteger(
			raw.eagerSchemaBytes,
			DEFAULT_EAGER_SCHEMA_BYTES,
			0,
			256 * 1024,
			"eagerSchemaBytes",
			warnings,
		),
		servers,
		warnings,
	};
}
