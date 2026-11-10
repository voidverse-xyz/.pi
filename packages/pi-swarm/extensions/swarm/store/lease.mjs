import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { requireCondition } from "../errors.mjs";
import { lstatSync, mkdirSync, rmdirSync, unlinkSync } from "node:fs";
import { atomicJson, invariant, privateDirectory, readPrivate, syncDirectory, validId } from "./files.mjs";

export const LEASE_RUNTIME_VERSION = 1;

function readReservation(path) {
	try {
		const value = JSON.parse(readPrivate(path));
		invariant(value && Object.keys(value).sort().join() === "runId,version" && value.version === 1 && validId(value.runId), "Invalid checkout reservation");
		return value;
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

// A live lock never expires automatically. A crash requires explicit recovery,
// since a PID disappearing does not prove its spawned commands have stopped.
export function acquireLease(layout, { ownerSessionId, requireUnreserved = false } = {}) {
	privateDirectory(layout.stateRoot);
	const token = randomUUID();
	mkdirSync(layout.ownerPath, { mode: 0o700 });
	const identity = lstatSync(layout.ownerPath);
	const tokenPath = join(layout.ownerPath, "owner.json");
	let closed = false;
	try {
		syncDirectory(layout.stateRoot);
		atomicJson(tokenPath, { version: 1, token, runId: layout.runId, pid: process.pid, ownerSessionId: ownerSessionId ?? null });
	} catch (error) {
		// No reservation or controller was published yet. Remove only our own
		// unchanged directory/token; an unexpected entry makes rmdir fail closed.
		try {
			const current = lstatSync(layout.ownerPath);
			invariant(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino,
				"Controller lease initialization directory changed");
			try {
				const owner = JSON.parse(readPrivate(tokenPath));
				invariant(owner.token === token && owner.runId === layout.runId, "Controller lease initialization token changed");
				unlinkSync(tokenPath);
			} catch (missing) { if (missing.code !== "ENOENT") throw missing; }
			rmdirSync(layout.ownerPath);
			syncDirectory(layout.stateRoot);
		} catch { /* Ambiguous initialization must stay fenced, not be stolen. */ }
		throw error;
	}

	function assertLiveOwner() {
		invariant(!closed, "Controller lease is closed");
		const current = lstatSync(layout.ownerPath);
		invariant(current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino, "Controller lease was replaced");
		const owner = JSON.parse(readPrivate(tokenPath));
		invariant(owner.token === token && owner.runId === layout.runId, "Controller lease lost");
	}

	function assertOwned() {
		assertLiveOwner();
		invariant(readReservation(layout.reservationPath)?.runId === layout.runId, "Checkout reservation lost");
	}

	function release({ retainReservation = true } = {}) {
		assertLiveOwner();
		if (!retainReservation) {
			const reservation = readReservation(layout.reservationPath);
			invariant(reservation?.runId === layout.runId, "Checkout reservation lost");
			unlinkSync(layout.reservationPath);
			syncDirectory(layout.stateRoot);
		}
		unlinkSync(tokenPath);
		syncDirectory(layout.ownerPath);
		rmdirSync(layout.ownerPath);
		syncDirectory(layout.stateRoot);
		closed = true;
	}

	let reservationAttempted = false;
	try {
		const reservation = readReservation(layout.reservationPath);
		requireCondition(requireUnreserved ? !reservation : !reservation || reservation.runId === layout.runId,
			"RESERVED", "Checkout belongs to another running or paused swarm");
		if (!reservation) {
			reservationAttempted = true;
			atomicJson(layout.reservationPath, { version: 1, runId: layout.runId });
		}
	} catch (error) {
		// No capability was published. Only a reservation this attempt created
		// may be released; pre-existing or malformed metadata stays untouched.
		try {
			const reservation = reservationAttempted ? readReservation(layout.reservationPath) : null;
			release({ retainReservation: !reservationAttempted || !reservation });
		} catch { /* Lost ownership or ambiguous metadata remains fenced. */ }
		throw error;
	}
	return { assertOwned, release };
}

/** Read-only ownership observation; never removes or repairs reservations. */
export function inspectReservation(layout) { return readReservation(layout.reservationPath); }

/** Read-only disclosure. A dead PID alone never authorizes reclaiming a lease. */
export function inspectLease(layout) {
	try { return JSON.parse(readPrivate(join(layout.ownerPath, "owner.json"))); }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** Explicit host attestation, compare-before-unlink, and live-process refusal. */
export function releaseStaleLease(layout, expected, { settled, identity } = {}) {
	invariant(settled === true && expected?.token, "Explicit settlement attestation required");
	if (identity) {
		const directory = lstatSync(layout.ownerPath);
		const stamp = lstatSync(layout.ownerPath, { bigint: true });
		invariant(directory.isDirectory() && !directory.isSymbolicLink() &&
			directory.dev === identity.dev && directory.ino === identity.ino &&
			directory.mode === identity.mode && directory.uid === identity.uid &&
			String(stamp.mtimeNs) === identity.mtimeNs && String(stamp.ctimeNs) === identity.ctimeNs,
			"Controller lease directory changed during confirmation");
	}
	const current = inspectLease(layout);
	invariant(JSON.stringify(current) === JSON.stringify(expected), "Controller lease changed during confirmation");
	if (Number.isSafeInteger(current.pid) && current.pid > 0) {
		try { process.kill(current.pid, 0); throw new Error("The previous controller process is still alive"); }
		catch (error) { if (error.code !== "ESRCH") throw error; }
	}
	unlinkSync(join(layout.ownerPath, "owner.json"));
	syncDirectory(layout.ownerPath);
	rmdirSync(layout.ownerPath);
	syncDirectory(layout.stateRoot);
}
