import {
	openSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	existsSync,
	realpathSync,
	readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { reduceEvent } from "./state.mjs";
import { requireCondition } from "./errors.mjs";
import { prepareLayout } from "./store/layout.mjs";
import { inspectJournal } from "./store/journal.mjs";
import { checkedFile, invariant, validId } from "./store/files.mjs";

/** Disclosure only: no lease acquisition, release, journal repair, or dispatch. */
export function inspectRecovery(workspace, runId, { agentDir } = {}) {
	const layout = prepareLayout(realpathSync(workspace), runId, { agentDir });
	try { lstatSync(layout.journalPath); }
	catch (error) {
		if (error.code !== "ENOENT") throw error;
		requireCondition(!existsSync(join(layout.workspaceRoot, ".swarms", runId)), "LEGACY_RUN", "This run was created by an older Swarm version and cannot be restored. Its files were preserved.");
		requireCondition(false, "NOT_FOUND", "Run does not exist");
	}
	const privateRoot = dirname(dirname(dirname(layout.stateRoot)));
	const ancestry = inspectAncestry(layout.runRoot, privateRoot);
	const journal = inspectJournal(layout.journalPath);
	let state = null;
	const operations = new Set();
	for (const event of journal.events) {
		requireCondition(!operations.has(event.operationId), "DUPLICATE", "Duplicate operation in journal");
		state = reduceEvent(state, event);
		operations.add(event.operationId);
	}
	requireCondition(state !== null, "NOT_FOUND", "Run does not exist");
	requireCondition(state.runId === runId && state.workspaceRoot === layout.workspaceRoot, "IDENTITY", "Run belongs to a different workspace");
	const ownership = inspectOwnership(layout, privateRoot);
	const again = inspectOwnership(layout, privateRoot);
	invariant(JSON.stringify(ownership) === JSON.stringify(again), "Recovery ownership changed during inspection");
	invariant(inspectJournal(layout.journalPath).fingerprint === journal.fingerprint, "Journal changed during recovery inspection");
	invariant(inspectAncestry(layout.runRoot, privateRoot) === ancestry, "Recovery ancestry changed during inspection");
	invariant(JSON.stringify(ownership) === JSON.stringify(inspectOwnership(layout, privateRoot)), "Recovery ownership changed during inspection");
	return {
		state, journalFingerprint: journal.fingerprint,
		lease: ownership.lease, leaseIdentity: ownership.leaseIdentity,
		reservation: ownership.reservation, reservationFingerprint: ownership.reservationFingerprint,
	};
}

function inspectOwnership(layout, privateRoot) {
	let lease = null;
	let leaseIdentity = null;
	const directory = optionalStat(layout.ownerPath);
	if (directory) {
		const ancestry = inspectAncestry(layout.ownerPath, privateRoot);
		const owner = inspectJson(join(layout.ownerPath, "owner.json"));
		invariant(owner !== null, "Controller lease owner metadata is missing");
		lease = owner.value;
		invariant(lease && typeof lease === "object" && !Array.isArray(lease), "Invalid controller lease");
		const keys = Object.keys(lease);
		invariant(keys.every(key => ["version", "token", "runId", "pid", "ownerSessionId"].includes(key)), "Invalid controller lease fields");
		invariant(lease.version === 1 && typeof lease.token === "string" && lease.token.length > 0 && lease.token.length <= 256 && validId(lease.runId), "Invalid controller lease");
		invariant(lease.pid === undefined || lease.pid === null || (Number.isSafeInteger(lease.pid) && lease.pid > 0), "Invalid controller lease PID");
		invariant(lease.ownerSessionId === undefined || lease.ownerSessionId === null || (typeof lease.ownerSessionId === "string" && lease.ownerSessionId.trim().length > 0 && lease.ownerSessionId.length <= 32768), "Invalid controller lease owner");
		requireCondition(lease.runId === layout.runId, "IDENTITY", "Controller lease belongs to another run");
		const current = lstatSync(layout.ownerPath);
		invariant(directory.dev === current.dev && directory.ino === current.ino && directory.mtimeMs === current.mtimeMs && directory.ctimeMs === current.ctimeMs && inspectAncestry(layout.ownerPath, privateRoot) === ancestry, "Controller lease changed during inspection");
		const stamp = lstatSync(layout.ownerPath, { bigint: true });
		leaseIdentity = { dev: current.dev, ino: current.ino, mode: current.mode, uid: current.uid, mtimeNs: String(stamp.mtimeNs), ctimeNs: String(stamp.ctimeNs), fingerprint: owner.fingerprint, ancestry };
	}
	const reservationFile = inspectJson(layout.reservationPath);
	const reservation = reservationFile?.value ?? null;
	if (reservationFile) {
		invariant(reservation && Object.keys(reservation).sort().join() === "runId,version" && reservation.version === 1 && validId(reservation.runId), "Invalid checkout reservation");
		requireCondition(reservation.runId === layout.runId, "RESERVED", "Checkout belongs to another running or paused swarm");
	}
	return { lease, leaseIdentity, reservation, reservationFingerprint: reservationFile?.fingerprint ?? null };
}

function inspectJson(path) {
	if (!optionalStat(path)) return null;
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const file = checkedFile(fd);
		const before = fileStamp(fstatSync(fd, { bigint: true }));
		const current = lstatSync(path);
		invariant(current.isFile() && !current.isSymbolicLink() && current.dev === file.dev && current.ino === file.ino, "Recovery metadata path was aliased or replaced");
		const bytes = readFileSync(fd);
		const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		invariant(fileStamp(fstatSync(fd, { bigint: true })) === before && fileStamp(lstatSync(path, { bigint: true })) === before, "Recovery metadata changed during inspection");
		return { value, fingerprint: createHash("sha256").update(before).update(bytes).digest("hex") };
	} finally { closeSync(fd); }
}

function inspectAncestry(path, privateRoot) {
	const identities = [];
	let directory = resolve(path);
	const boundary = resolve(privateRoot);
	let privateRequired = true;
	for (;;) {
		const stat = lstatSync(directory);
		invariant(stat.isDirectory() && !stat.isSymbolicLink(), "Unsafe recovery ancestry");
		if (privateRequired) invariant(process.platform === "win32" || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0), "Recovery ancestry must be private and owned by this user");
		identities.push([directory, stat.dev, stat.ino, stat.mode, stat.uid]);
		if (directory === boundary) privateRequired = false;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return JSON.stringify(identities);
}

function optionalStat(path) {
	try { return lstatSync(path); }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function fileStamp(stat) {
	return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink].join(":");
}
