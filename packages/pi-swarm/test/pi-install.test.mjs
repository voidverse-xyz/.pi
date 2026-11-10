import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { resolvePiPackageDir } from "./pi-install.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

const MARKER = { kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" };

function temp(t) {
	const dir = mkdtempSync(join(tmpdir(), "swarm-pi-install-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function install(root, { marker = JSON.stringify(MARKER), version = "1.0.4\n", release = true } = {}) {
	mkdirSync(root, { recursive: true });
	if (marker !== undefined) writeFileSync(join(root, "managed-install.json"), marker);
	if (version !== null) writeFileSync(join(root, "current-version"), version);
	const packageDir = join(root, "releases", version?.trim() ?? "", "node_modules", "@earendil-works", "pi-coding-agent");
	if (release) {
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "package.json"), "{}");
	}
	return packageDir;
}

test("managed install resolves from the default, PI_CODING_AGENT_DIR, and PI_MANAGED_INSTALL_ROOT roots", t => {
	const home = temp(t);
	const homePackage = install(join(home, ".pi", "agent", "install"));
	assert.equal(resolvePiPackageDir({}, home), homePackage);
	const agent = temp(t);
	const agentPackage = install(join(agent, "install"));
	assert.equal(resolvePiPackageDir({ PI_CODING_AGENT_DIR: agent }, home), agentPackage);
	const root = temp(t);
	const rootPackage = install(root);
	assert.equal(resolvePiPackageDir({ PI_MANAGED_INSTALL_ROOT: root, PI_CODING_AGENT_DIR: agent }, home), rootPackage);
});

test("PI_SDK_DIR overrides the managed install and must hold a package", t => {
	const home = temp(t);
	install(join(home, ".pi", "agent", "install"));
	const sdk = temp(t);
	writeFileSync(join(sdk, "package.json"), "{}");
	assert.equal(resolvePiPackageDir({ PI_SDK_DIR: sdk }, home), sdk);
	assert.equal(resolvePiPackageDir({ PI_SDK_DIR: sdk }, temp(t)), sdk);
	assert.throws(() => resolvePiPackageDir({ PI_SDK_DIR: join(sdk, "missing") }, home), /PI_SDK_DIR has no package\.json/);
});

test("missing or mismatched managed-install markers are rejected", t => {
	const root = temp(t);
	assert.throws(() => resolvePiPackageDir({ PI_MANAGED_INSTALL_ROOT: root }, temp(t)),
		error => error.message === `No managed Pi installation found at ${root}; install Pi with its installer, or set PI_SDK_DIR.`);
	const markers = [{ ...MARKER, kind: "npm" }, { ...MARKER, schemaVersion: 2 }, { ...MARKER, schemaVersion: "1" }, { ...MARKER, layout: "flat" }];
	for (const marker of [...markers.map(value => JSON.stringify(value)), "not json", "null"]) {
		const bad = temp(t);
		install(bad, { marker });
		assert.throws(() => resolvePiPackageDir({ PI_MANAGED_INSTALL_ROOT: bad }, temp(t)), /Managed Pi install marker is invalid/, marker);
	}
});

test("current-version is validated like Pi's launcher", t => {
	for (const version of ["..", ".", "", "  \n", "1.0/4", "..\\x", null]) {
		const root = temp(t);
		install(root, { version, release: false });
		assert.throws(() => resolvePiPackageDir({ PI_MANAGED_INSTALL_ROOT: root }, temp(t)),
			error => error.message === `Managed Pi version file is invalid: ${join(root, "current-version")}`, String(version));
	}
});

test("a missing release names the expected package directory", t => {
	const root = temp(t);
	const expected = install(root, { release: false });
	assert.throws(() => resolvePiPackageDir({ PI_MANAGED_INSTALL_ROOT: root }, temp(t)),
		error => error.message === `Managed Pi release is missing: ${expected}`);
});
