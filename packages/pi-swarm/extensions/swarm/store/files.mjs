import {
	openSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	writeSync,
	existsSync,
	renameSync,
	unlinkSync,
	realpathSync,
	readFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

// Bump when storage admission/cleanup contracts change; native imports can survive /reload.
export const FILES_RUNTIME_VERSION = 1;

export function invariant(condition, message) {
	if (!condition) throw new Error(message);
}

export function validId(value) {
	return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
}

export function syncDirectory(path) {
	if (process.platform === "win32") return;
	const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function privateDirectory(path) {
	const parent = dirname(path);
	if (!existsSync(parent)) privateDirectory(parent);
	invariant(realpathSync(parent) === resolve(parent), "Unsafe state directory ancestry");
	try {
		mkdirSync(path, { mode: 0o700, recursive: true });
		syncDirectory(dirname(path));
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	const stat = lstatSync(path);
	invariant(stat.isDirectory() && !stat.isSymbolicLink(), "Unsafe state directory");
	invariant(process.platform === "win32" || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0), "State directory must be private and owned by this user");
	return stat;
}

export function checkedFile(fd) {
	const stat = fstatSync(fd);
	invariant(stat.isFile() && stat.nlink === 1, "State file must be a regular, single-link file");
	invariant(process.platform === "win32" || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0), "State file must be private and owned by this user");
	return stat;
}

export function readPrivate(path) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		checkedFile(fd);
		return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd));
	} finally { closeSync(fd); }
}

export function writeAll(fd, bytes) {
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(fd, bytes, offset, bytes.length - offset);
		invariant(written > 0, "Unable to advance durable write");
		offset += written;
	}
}

export function atomicJson(path, value) {
	const temporary = join(dirname(path), `.pending-${randomUUID()}`);
	const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		writeAll(fd, Buffer.from(JSON.stringify(value) + "\n"));
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		try { unlinkSync(temporary); } catch { /* Preserve the original write error. */ }
		throw error;
	}
	const identity = fstatSync(fd, { bigint: true });
	closeSync(fd);
	try {
		renameSync(temporary, path);
		syncDirectory(dirname(path));
	} catch (error) {
		// A failed rename must not strand this write's unpublished temporary.
		// Never unlink a replaced/changed file, or the destination after rename.
		try {
			const current = lstatSync(temporary, { bigint: true });
			if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino
				&& current.size === identity.size && current.mtimeNs === identity.mtimeNs && current.ctimeNs === identity.ctimeNs) unlinkSync(temporary);
		} catch { /* Preserve the original IO error and ambiguous files. */ }
		throw error;
	}
}
