import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Load every top-level .json catalog in a directory, sorted for deterministic startup. */
export function loadJsonCatalogs(directory) {
    const root = resolve(directory);
    const entries = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .sort((a, b) => a.name.localeCompare(b.name));

    if (entries.length === 0) throw new Error(`No JSON language catalogs found in ${root}`);

    const catalogs = [];
    const ids = new Set();

    for (const entry of entries) {
        const file = join(root, entry.name);
        let catalog;
        try {
            catalog = JSON.parse(readFileSync(file, "utf8"));
        } catch (error) {
            throw new Error(`Cannot parse language catalog ${file}: ${error.message}`, { cause: error });
        }

        if (typeof catalog.id !== "string" || catalog.id.trim().length === 0) {
            throw new Error(`Language catalog has no id: ${file}`);
        }
        if (ids.has(catalog.id)) throw new Error(`Duplicate language catalog id ${catalog.id}: ${file}`);

        ids.add(catalog.id);
        catalogs.push(catalog);
    }

    return catalogs;
}
