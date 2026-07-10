/**
 * mail/collect.ts — collect-result schema validation (03-tool-surface:
 * subagent_collect). PURE.
 *
 * subagent_collect sends the agent a collect-request message carrying a JSON
 * schema; the result arrives later as a report envelope whose payload.data is
 * validated against that schema on arrival, with the verdict attached to the
 * digest line (mail never blocks on validity — a violating result is still
 * delivered, labeled).
 *
 * Deliberately a RESTRICTED JSON-Schema subset, hand-rolled (no dependency,
 * mirroring typedefs/parse.ts's restricted-YAML stance): type (string, number,
 * integer, boolean, null, object, array), properties + required +
 * additionalProperties:false, items, enum, const. Schema keywords outside the
 * subset are IGNORED (validation stays permissive-but-honest rather than
 * failing on schemas we half-understand); an outright malformed schema reports
 * itself as a schema error instead of a data error.
 */

export interface ValidationResult {
	valid: boolean;
	/** Human-readable problems, path-prefixed (empty when valid). */
	errors: string[];
}

function typeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		default:
			return true; // unknown type keyword — outside the subset, ignore
	}
}

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function check(value: unknown, schema: unknown, path: string, errors: string[]): void {
	if (typeof schema === "boolean") {
		if (!schema) errors.push(`${path}: schema forbids any value`);
		return;
	}
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		errors.push(`${path}: malformed schema (expected an object)`);
		return;
	}
	const s = schema as Record<string, unknown>;

	if (s.const !== undefined && !deepEqual(value, s.const)) {
		errors.push(`${path}: expected const ${JSON.stringify(s.const)}, got ${JSON.stringify(value)}`);
	}
	if (Array.isArray(s.enum) && !s.enum.some((option) => deepEqual(value, option))) {
		errors.push(`${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(s.enum)}`);
	}

	if (typeof s.type === "string" || Array.isArray(s.type)) {
		const types = Array.isArray(s.type) ? s.type.filter((t): t is string => typeof t === "string") : [s.type];
		if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
			errors.push(`${path}: expected type ${types.join("|")}, got ${typeName(value)}`);
			return; // deeper checks would only cascade
		}
	}

	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;
		const properties =
			typeof s.properties === "object" && s.properties !== null && !Array.isArray(s.properties)
				? (s.properties as Record<string, unknown>)
				: undefined;
		if (Array.isArray(s.required)) {
			for (const key of s.required) {
				if (typeof key === "string" && !(key in obj)) errors.push(`${path}: missing required property "${key}"`);
			}
		}
		if (properties) {
			for (const [key, sub] of Object.entries(properties)) {
				if (key in obj) check(obj[key], sub, `${path}.${key}`, errors);
			}
			if (s.additionalProperties === false) {
				for (const key of Object.keys(obj)) {
					if (!(key in properties)) errors.push(`${path}: unexpected property "${key}"`);
				}
			}
		}
	}

	if (Array.isArray(value) && s.items !== undefined && !Array.isArray(s.items)) {
		value.forEach((item, i) => check(item, s.items, `${path}[${i}]`, errors));
	}
}

/** Validate a collect result's payload.data against the requested schema. */
export function validateAgainstSchema(data: unknown, schema: unknown): ValidationResult {
	const errors: string[] = [];
	check(data, schema, "$", errors);
	return { valid: errors.length === 0, errors };
}

/** The digest annotation for a collect-result report (attached on arrival). */
export function collectResultNote(result: ValidationResult): string {
	return result.valid
		? "[collect result — conforms to the requested schema]"
		: `[collect result — SCHEMA VIOLATIONS: ${result.errors.join("; ")}]`;
}
