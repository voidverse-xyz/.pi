/**
 * schema/validate.ts — structured-output schema validation. PURE.
 *
 * Copied from pi-teams/extensions/teams/mail/collect.ts (the proven validator;
 * preferred over typebox Value whose behavior on arbitrary user JSON schemas is
 * unverified). Only the digest-note helper was dropped and checkSchemaShape is
 * exported for eager fail-fast validation before an agent slot is acquired.
 *
 * A RESTRICTED JSON-Schema subset, hand-rolled: type (object/array/string/
 * number/integer/boolean/null), properties + required + additionalProperties:
 * false, items, enum, const. Out-of-subset KEYWORDS are ignored
 * (permissive-but-honest); a malformed KNOWN keyword is a schema error.
 *
 * "Honest" is load-bearing: additionalProperties:false closes the object even
 * when properties is absent/partial; const/enum equality is JSON-semantic
 * (order-independent, recursive), not stringify-based; and a `type` naming an
 * unknown keyword is a schema error, not a silent match.
 */

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

function typeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

const TYPE_MATCHERS: Record<string, (value: unknown) => boolean> = {
	object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
	array: (v) => Array.isArray(v),
	string: (v) => typeof v === "string",
	number: (v) => typeof v === "number",
	integer: (v) => typeof v === "number" && Number.isInteger(v),
	boolean: (v) => typeof v === "boolean",
	null: (v) => v === null,
};

const KNOWN_TYPES = new Set(Object.keys(TYPE_MATCHERS));

/** JSON-semantic deep equality for const/enum (order-independent for objects). */
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
		if (aKeys.length !== Object.keys(bo).length) return false;
		return aKeys.every((key) => Object.prototype.hasOwnProperty.call(bo, key) && deepEqual(ao[key], bo[key]));
	}
	return false;
}

function isSchema(value: unknown): boolean {
	return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value));
}

export function checkSchemaShape(schema: unknown, path: string, errors: string[]): void {
	if (typeof schema === "boolean") return;
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		errors.push(`${path}: malformed schema (expected an object or boolean)`);
		return;
	}
	const s = schema as Record<string, unknown>;
	if ("enum" in s && (!Array.isArray(s.enum) || s.enum.length === 0)) {
		errors.push(`${path}: malformed schema — enum must be a non-empty array`);
	}
	if ("type" in s) {
		const rawTypes = Array.isArray(s.type) ? s.type : [s.type];
		if (rawTypes.length === 0 || rawTypes.some((t) => typeof t !== "string" || !KNOWN_TYPES.has(t)) || new Set(rawTypes).size !== rawTypes.length) {
			errors.push(`${path}: malformed schema — type must contain unique known type names`);
		}
	}
	if ("required" in s) {
		if (!Array.isArray(s.required) || s.required.some((k) => typeof k !== "string") || new Set(s.required).size !== s.required.length) {
			errors.push(`${path}: malformed schema — required must be an array of unique strings`);
		}
	}
	if ("properties" in s) {
		if (typeof s.properties !== "object" || s.properties === null || Array.isArray(s.properties)) {
			errors.push(`${path}: malformed schema — properties must be an object`);
		} else {
			for (const [key, child] of Object.entries(s.properties as Record<string, unknown>)) {
				checkSchemaShape(child, `${path}.properties.${key}`, errors);
			}
		}
	}
	if ("additionalProperties" in s && typeof s.additionalProperties !== "boolean") {
		errors.push(`${path}: malformed schema — additionalProperties must be a boolean`);
	}
	if ("items" in s) {
		if (!isSchema(s.items)) errors.push(`${path}: malformed schema — items must be an object or boolean schema`);
		else checkSchemaShape(s.items, `${path}.items`, errors);
	}
}

/**
 * Validate `value` against an already-shape-checked schema. Precondition:
 * checkSchemaShape reported no errors (validateAgainstSchema enforces this),
 * so type names here are known and enum/required/properties are well-formed.
 */
function check(value: unknown, schema: unknown, path: string, errors: string[]): void {
	if (typeof schema === "boolean") {
		if (!schema) errors.push(`${path}: schema forbids any value`);
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
		const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
		if (types.length > 0 && !types.some((t) => TYPE_MATCHERS[t]?.(value))) {
			errors.push(`${path}: expected type ${types.join("|")}, got ${typeName(value)}`);
			return;
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
				if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(obj, key)) {
					errors.push(`${path}: missing required property "${key}"`);
				}
			}
		}
		if (properties) {
			for (const [key, sub] of Object.entries(properties)) {
				if (Object.prototype.hasOwnProperty.call(obj, key)) check(obj[key], sub, `${path}.${key}`, errors);
			}
		}
		if (s.additionalProperties === false) {
			for (const key of Object.keys(obj)) {
				if (!(properties && Object.prototype.hasOwnProperty.call(properties, key))) {
					errors.push(`${path}: unexpected property "${key}"`);
				}
			}
		}
	}

	if (Array.isArray(value) && s.items !== undefined && !Array.isArray(s.items)) {
		value.forEach((item, i) => check(item, s.items, `${path}[${i}]`, errors));
	}
}

/** Validate a structured_output payload against the requested schema. */
export function validateAgainstSchema(data: unknown, schema: unknown): ValidationResult {
	const errors: string[] = [];
	checkSchemaShape(schema, "$", errors);
	if (errors.length === 0) check(data, schema, "$", errors);
	return { valid: errors.length === 0, errors };
}

/** Fail-fast shape check for a schema supplied to agent({schema}). */
export function schemaShapeErrors(schema: unknown): string[] {
	const errors: string[] = [];
	checkSchemaShape(schema, "$", errors);
	return errors;
}
