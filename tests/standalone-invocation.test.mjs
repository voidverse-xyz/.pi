#!/usr/bin/env node
import { createPiJiti } from "./runtime.mjs";

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";


const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..", "packages");
const jiti = await createPiJiti(import.meta.url);

const sources = [
	join(PACKAGE_ROOT, "pi-changes", "extensions", "changes", "ask.ts"),
	join(PACKAGE_ROOT, "pi-commit", "extensions", "commit", "subagent.ts"),
	join(PACKAGE_ROOT, "pi-merge", "extensions", "merge", "index.ts"),
];
const modules = await Promise.all(
	sources.map((source) => jiti.import(pathToFileURL(source).href, { default: false })),
);
const resolvers = modules.map((module, index) => {
	assert.equal(typeof module.getPiInvocation, "function", `${sources[index]} exports getPiInvocation`);
	return module.getPiInvocation;
});

const cliArgs = ["--mode", "json", "-p", "probe"];
const compiledEntries = [
	"/$bunfs/root/cli.js",
	"/~BUN/root/cli.js",
	"/%7EBUN/root/cli.js",
];
for (const resolve of resolvers) {
	for (const currentScript of compiledEntries) {
		const actual = resolve(cliArgs, {
			execPath: "/opt/pi/pi",
			currentScript,
			scriptExists() {
				throw new Error("compiled executables must not inspect virtual script paths");
			},
		});
		assert.deepEqual(actual, { command: "/opt/pi/pi", args: cliArgs });
	}

	for (const execPath of ["/usr/bin/node", "/usr/bin/nodejs"]) {
		assert.deepEqual(
			resolve(cliArgs, {
				execPath,
				currentScript: "/opt/pi/dist/cli.js",
				scriptExists: () => true,
			}),
			{ command: execPath, args: ["/opt/pi/dist/cli.js", ...cliArgs] },
			"Node installs retain their script path",
		);
	}
	assert.deepEqual(
		resolve(cliArgs, {
			execPath: "/usr/bin/bun",
			currentScript: undefined,
			scriptExists: () => false,
		}),
		{ command: "pi", args: cliArgs },
		"generic runtimes without a real script fall back to PATH",
	);
}

console.log(`standalone invocation ok — ${resolvers.length} child launchers cover compiled and script runtimes`);
