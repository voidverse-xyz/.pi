#!/usr/bin/env node

import { resolve } from "node:path";
import { loadJsonCatalogs } from "../assets/load-json-catalogs.mjs";

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;
const PLURAL_KEYS = new Set(["zero", "one", "two", "few", "many", "other"]);

function placeholders(text) {
    return new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]));
}

function isPluralMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.other !== "string") return false;
    return Object.keys(value).every((key) => PLURAL_KEYS.has(key) || /^=-?\d+(?:\.\d+)?$/.test(key));
}

function flattenMessages(node, prefix = "", output = new Map()) {
    if (typeof node === "string") {
        output.set(prefix, { type: "text", variants: { text: node } });
        return output;
    }

    if (isPluralMap(node)) {
        output.set(prefix, { type: "plural", variants: node });
        return output;
    }

    if (!node || typeof node !== "object" || Array.isArray(node)) {
        throw new Error(`Message ${prefix || "<root>"} must be text, a plural map, or a nested object.`);
    }

    for (const [key, value] of Object.entries(node)) {
        flattenMessages(value, prefix ? `${prefix}.${key}` : key, output);
    }
    return output;
}

function unionPlaceholders(entry) {
    const result = new Set();
    for (const text of Object.values(entry.variants)) {
        if (typeof text !== "string") throw new Error("Every plural branch must be text.");
        for (const name of placeholders(text)) result.add(name);
    }
    return result;
}

function sameSet(left, right) {
    return left.size === right.size && [...left].every((value) => right.has(value));
}

function validateCatalogShape(catalog) {
    if (!catalog.name || !["ltr", "rtl"].includes(catalog.dir)) {
        throw new Error(`Catalog ${catalog.id} requires name and dir (ltr|rtl).`);
    }
    if (!catalog.messages || typeof catalog.messages !== "object" || Array.isArray(catalog.messages)) {
        throw new Error(`Catalog ${catalog.id} requires a messages object.`);
    }

    try {
        Intl.getCanonicalLocales(catalog.id);
        for (const alias of catalog.locales ?? []) Intl.getCanonicalLocales(alias);
    } catch (error) {
        throw new Error(`Catalog ${catalog.id} contains an invalid BCP-47 locale.`, { cause: error });
    }
}

const directory = resolve(process.argv[2] ?? "");
const requestedDefault = process.argv[3];
if (!process.argv[2]) {
    console.error("Usage: node validate-catalogs.mjs <catalog-directory> [default-locale]");
    process.exit(2);
}

const catalogs = loadJsonCatalogs(directory);
for (const catalog of catalogs) validateCatalogShape(catalog);

const defaultCatalog = requestedDefault
    ? catalogs.find((catalog) => catalog.id === requestedDefault)
    : catalogs[0];
if (!defaultCatalog) throw new Error(`Default catalog not found: ${requestedDefault}`);

const baseline = flattenMessages(defaultCatalog.messages);
const failures = [];
const aliasOwners = new Map();

for (const catalog of catalogs) {
    for (const alias of [catalog.id, ...(catalog.locales ?? [])]) {
        const canonical = Intl.getCanonicalLocales(alias)[0].toLowerCase();
        const owner = aliasOwners.get(canonical);
        if (owner && owner !== catalog.id) failures.push(`Locale alias ${alias} is claimed by ${owner} and ${catalog.id}.`);
        aliasOwners.set(canonical, catalog.id);
    }

    const messages = flattenMessages(catalog.messages);
    for (const key of baseline.keys()) {
        if (!messages.has(key)) failures.push(`${catalog.id}: missing key ${key}`);
    }
    for (const key of messages.keys()) {
        if (!baseline.has(key)) failures.push(`${catalog.id}: extra key ${key}`);
    }

    for (const [key, expected] of baseline) {
        const actual = messages.get(key);
        if (!actual) continue;
        if (actual.type !== expected.type) failures.push(`${catalog.id}: ${key} changes message type (${expected.type} -> ${actual.type})`);

        const expectedParams = unionPlaceholders(expected);
        const actualParams = unionPlaceholders(actual);
        if (!sameSet(expectedParams, actualParams)) {
            failures.push(`${catalog.id}: ${key} placeholder mismatch (expected ${[...expectedParams]}, found ${[...actualParams]})`);
        }
    }
}

if (failures.length > 0) {
    console.error(`Catalog validation failed (${failures.length} issue${failures.length === 1 ? "" : "s"}):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(`Validated ${catalogs.length} catalogs and ${baseline.size} message keys. Default: ${defaultCatalog.id}`);
