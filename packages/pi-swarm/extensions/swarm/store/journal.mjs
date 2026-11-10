import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { checkedFile, invariant, syncDirectory, writeAll } from "./files.mjs";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

function digest(sequence, previous, payload) {
	return createHash("sha256").update(JSON.stringify({ sequence, previous, payload })).digest("hex");
}

export function openJournal(path, assertOwned, io = { writeAll, sync: fsyncSync }) {
	assertOwned();
	let created = false;
	let fd;
	try {
		fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		created = true;
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
	}
	let records = [];
	let expectedSize;
	let expectedStamp;
	let poisoned = false;
	let closed = false;
	try {
		const file = checkedFile(fd);
		assertJournalPath(path, file);
		expectedSize = file.size;
		if (created) { fsyncSync(fd); syncDirectory(dirname(path)); }
		records = decodeJournal(readFileSync(fd));
		expectedStamp = fstatSync(fd, { bigint: true });
	} catch (error) {
		closeSync(fd);
		throw error;
	}

	return {
		readAll() { return structuredClone(records.map(record => record.payload)); },
		append(payload) {
			invariant(!closed && !poisoned, "Journal is closed or has uncertain writes");
			assertOwned();
			const current = checkedFile(fd);
			assertJournalPath(path, current);
			invariant(current.size === expectedSize, "Journal changed outside its writer");
			const stamp = fstatSync(fd, { bigint: true });
			invariant(stamp.mtimeNs === expectedStamp.mtimeNs && stamp.ctimeNs === expectedStamp.ctimeNs, "Journal metadata changed outside its writer");
			const copy = JSON.parse(JSON.stringify(payload));
			const sequence = records.length + 1;
			const previous = records.at(-1)?.hash ?? null;
			const record = { version: 1, sequence, previous, payload: copy, hash: digest(sequence, previous, copy) };
			const bytes = Buffer.from(JSON.stringify(record) + "\n");
			try {
				io.writeAll(fd, bytes);
				io.sync(fd);
				expectedStamp = fstatSync(fd, { bigint: true });
			} catch (error) {
				// The caller cannot know whether the event reached stable storage.
				// Do not retry it on this handle or acknowledge dependent work.
				poisoned = true;
				throw error;
			}
			expectedSize += bytes.length;
			records.push(record);
			return sequence;
		},
		close() {
			if (!closed) { closeSync(fd); closed = true; }
		},
	};
}

/** Strict, read-only snapshot. Never creates or repairs a journal. */
export function inspectJournal(path) {
	const ancestry = journalAncestry(path);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		assertJournalPath(path, checkedFile(fd));
		const before = journalStamp(fd);
		const bytes = readFileSync(fd);
		const records = decodeJournal(bytes);
		invariant(journalStamp(fd) === before, "Journal changed during inspection");
		assertJournalPath(path, checkedFile(fd));
		invariant(journalAncestry(path) === ancestry, "Journal ancestry changed during inspection");
		// Detect a rewrite even when an external writer preserves ordinary timestamps.
		const verifyFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			assertJournalPath(path, checkedFile(verifyFd));
			invariant(journalStamp(verifyFd) === before && readFileSync(verifyFd).equals(bytes) && journalStamp(verifyFd) === before && journalStamp(fd) === before, "Journal changed during inspection");
		} finally { closeSync(verifyFd); }
		assertJournalPath(path, checkedFile(fd));
		invariant(journalAncestry(path) === ancestry, "Journal ancestry changed during inspection");
		const fingerprint = createHash("sha256").update(before).update(ancestry).update(bytes).digest("hex");
		return { events: records.map(record => record.payload), fingerprint };
	} finally { closeSync(fd); }
}

function decodeJournal(bytes) {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	invariant(text.length === 0 || text.endsWith("\n"), "Incomplete journal record; reconciliation required");
	const records = [];
	let previous = null;
	for (const line of text.split("\n").slice(0, -1)) {
		const record = JSON.parse(line);
		invariant(record !== null && typeof record === "object" && !Array.isArray(record) && Object.keys(record).sort().join() === "hash,payload,previous,sequence,version", "Invalid journal envelope");
		invariant(record.version === 1 && record.sequence === records.length + 1, "Invalid journal sequence/version");
		invariant(record.previous === previous, "Broken journal chain");
		invariant(record.hash === digest(record.sequence, previous, record.payload), "Journal checksum mismatch");
		records.push(record);
		previous = record.hash;
	}
	return records;
}

function journalStamp(fd) {
	const stat = fstatSync(fd, { bigint: true });
	return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.nlink].join(":");
}

function journalAncestry(path) {
	const identities = [];
	let directory = dirname(resolve(path));
	let immediate = true;
	for (;;) {
		const stat = lstatSync(directory, { bigint: true });
		invariant(stat.isDirectory() && !stat.isSymbolicLink(), "Unsafe journal ancestry");
		if (immediate) invariant(process.platform === "win32" || (stat.uid === BigInt(process.getuid()) && (stat.mode & 0o077n) === 0n), "Journal directory must be private and owned by this user");
		identities.push([directory, String(stat.dev), String(stat.ino), String(stat.mode), String(stat.uid)]);
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
		immediate = false;
	}
	return JSON.stringify(identities);
}

/** O_NOFOLLOW is not enforced on every platform. Validate the opened path before IO. */
function assertJournalPath(path, file) {
	const current = lstatSync(path);
	invariant(current.isFile() && !current.isSymbolicLink() && current.dev === file.dev && current.ino === file.ino, "Journal path was aliased or replaced");
}
