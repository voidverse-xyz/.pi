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
 *
 * "Honest" is load-bearing (finding 9): `additionalProperties:false` closes the
 * object even when `properties` is absent/partial (unknown keys are rejected,
 * not accepted); `const`/`enum` equality is JSON-SEMANTIC (order-independent for
 * objects, recursive), not stringify-based; and a `type` whose VALUE is not a
 * known type keyword is reported as a schema error rather than silently matching
 * every value. Out-of-subset KEYWORDS are still ignored; a malformed known
 * keyword is not.
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

/** The type keywords the restricted subset understands. */
const KNOWN_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

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
			// Unreachable: unknown type strings are caught as a schema error before
			// matchesType is consulted (see check). Never silently pass (finding 9c).
			return false;
	}
}

/**
 * JSON-semantic deep equality for const/enum (finding 9b). The old
 * `JSON.stringify(a) === JSON.stringify(b)` made object equality depend on
 * property INSERTION ORDER, so `{a:1,b:2}` failed against a `{b:2,a:1}` const
 * even though the two are the same JSON value. This compares by value:
 * order-independent for objects, positional for arrays, recursive throughout.
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return a === b;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => deepEqual(item, b[i]));
	}
	if (typeof a === "object") {
		const ao = a as Record<string, unknown>;
		const bo = b as Record<string, unknown>;
		const aKeys = Object.keys(ao);
		const bKeys = Object.keys(bo);
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every(
			(key) => Object.prototype.hasOwnProperty.call(bo, key) && deepEqual(ao[key], bo[key]),
		);
	}
	return false; // distinct primitives (strict-=== above already caught equal ones)
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

	if (s.type !== undefined) {
		// A `type` keyword that isn't a string or array of type strings — or that
		// names a type outside the subset — is a MALFORMED schema, not a silent
		// pass (finding 9c). Report it and stop: we can't honestly validate value
		// shape against a type we don't understand.
		const rawTypes = Array.isArray(s.type) ? s.type : [s.type];
		const malformed = rawTypes.filter((t) => typeof t !== "string" || !KNOWN_TYPES.has(t));
		if (malformed.length > 0) {
			errors.push(`${path}: malformed schema — unknown type ${JSON.stringify(s.type)}`);
			return;
		}
		const types = rawTypes as string[];
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
		}
		// additionalProperties:false rejects unknown keys even when `properties`
		// is absent or only partially declared (finding 9a): with no declared
		// properties the closed object admits NO keys, so every key is unexpected.
		if (s.additionalProperties === false) {
			for (const key of Object.keys(obj)) {
				if (!(properties && key in properties)) errors.push(`${path}: unexpected property "${key}"`);
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
