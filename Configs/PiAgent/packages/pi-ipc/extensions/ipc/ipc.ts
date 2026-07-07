/**
 * Generic parent↔subagent IPC channel.
 *
 * A subagent runs as a headless child `pi` process (spawned by delegate.ts), so any
 * capability that needs the interactive TUI — confirming a gated command, asking the
 * user a question — has no local UI. This module is the transport that lets the child
 * ask its parent (which DOES have the TUI) to do it on its behalf, and forward the
 * answer back.
 *
 * It is a minimal JSON-RPC-over-pipe, deliberately purpose-agnostic: callers pick a
 * `method` string and shape their own params/result. command-safety ("safety.confirm")
 * and ask-user ("user.ask") are the first two consumers.
 *
 * Transport: a dedicated bidirectional pipe on a separate fd (NOT stdout, so control
 * traffic never interleaves with pi's JSON event stream). delegate.ts spawns the child
 * with a 4th stdio "pipe" and passes the fd number in PI_IPC_FD. Messages are
 * newline-delimited JSON (JSON.stringify never emits raw newlines, so framing is safe
 * at any size):
 *
 *   request       child → parent:  {id, method, params, from}
 *   notification  child → parent:  {method, params, from}      (no id, no reply)
 *   response      parent → child:  {id, result}  |  {id, error}
 *
 * `from` is the agent path from the direct child down to the originator (built up a
 * hop at a time by attachIpc — see below), so a handler always knows WHO is asking
 * even across nested subagents.
 *
 * The child side (ipcRequest / ipcNotify) is used by the in-child consumers. The
 * parent side (attachIpc) is used by delegate.ts, which resolves each request on its
 * TUI — or, if it is ITSELF a headless subagent, forwards it further up its own
 * channel, so a deeply nested subagent's request still surfaces at the top-level TUI.
 */

import { Socket } from "node:net";
import type { Duplex } from "node:stream";

/** Env var carrying the inherited fd of the child→parent IPC channel. */
export const IPC_FD_ENV = "PI_IPC_FD";

/** Discriminated result: either a value, or a transport/handler error string. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Context handed to a parent-side handler: the method plus the asker chain. */
export interface IpcMeta {
	method: string;
	/** Agent names, direct child first, originating subagent last (e.g. ["worker","reviewer"]). */
	from: string[];
}

/** A usable pipe fd from the env, or null — the single source of truth for both
 * hasIpcChannel() (the claim probe) and getClient() (the actual connection), so a
 * claim is never made on a channel that getClient() would then reject. */
function parseChannelFd(): number | null {
	const raw = process.env[IPC_FD_ENV];
	if (!raw) return null;
	const fd = Number(raw);
	if (!Number.isInteger(fd) || fd < 3) return null;
	return fd;
}

/** True when this process was spawned with a usable parent IPC channel to reach. */
export function hasIpcChannel(): boolean {
	return parseChannelFd() !== null;
}

interface Envelope {
	id?: number;
	method?: string;
	params?: unknown;
	from?: string[];
	result?: unknown;
	error?: string;
}

// ---- child side ------------------------------------------------------------

// Reads/writes the inherited fd as a line-delimited request/response socket. One
// lazily-created singleton per process (the fd never changes within a process).
class IpcClient {
	private readonly socket: Socket;
	private buffer = "";
	private nextId = 1;
	private readonly pending = new Map<number, (r: IpcResult<unknown>) => void>();

	constructor(fd: number) {
		this.socket = new Socket({ fd, readable: true, writable: true });
		this.socket.setEncoding("utf8");
		// Ref/unref is managed per-request: reffed only while a call is in flight, so the
		// child survives the await (a pending Promise alone does NOT pin Node's event
		// loop) yet an idle channel never keeps a finished subagent process alive.
		this.socket.unref();
		this.socket.on("data", (chunk: string) => this.onData(chunk));
		const failAll = () => {
			for (const resolve of this.pending.values()) resolve({ ok: false, error: "ipc channel closed" });
			this.pending.clear();
			this.socket.unref();
		};
		this.socket.on("close", failAll);
		this.socket.on("error", failAll);
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (!line.trim()) continue;
			let msg: Envelope;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof msg.id !== "number") continue;
			const resolve = this.pending.get(msg.id);
			if (!resolve) continue;
			this.pending.delete(msg.id);
			if (this.pending.size === 0) this.socket.unref();
			if (typeof msg.error === "string") resolve({ ok: false, error: msg.error });
			else resolve({ ok: true, value: msg.result });
		}
	}

	request<T>(method: string, params: unknown, from: string[]): Promise<IpcResult<T>> {
		const id = this.nextId++;
		return new Promise<IpcResult<T>>((resolve) => {
			if (this.pending.size === 0) this.socket.ref();
			this.pending.set(id, resolve as (r: IpcResult<unknown>) => void);
			try {
				this.socket.write(`${JSON.stringify({ id, method, params, from })}\n`);
			} catch {
				this.pending.delete(id);
				if (this.pending.size === 0) this.socket.unref();
				resolve({ ok: false, error: "ipc write failed" });
			}
		});
	}

	notify(method: string, params: unknown, from: string[]): void {
		try {
			this.socket.write(`${JSON.stringify({ method, params, from })}\n`);
		} catch {
			/* best-effort; notifications are fire-and-forget */
		}
	}
}

let client: IpcClient | null = null;

function getClient(): IpcClient | null {
	const fd = parseChannelFd();
	if (fd === null) return null;
	if (!client) client = new IpcClient(fd);
	return client;
}

/**
 * Call a method on the parent and await its result. Resolves {ok:false} when there is
 * no channel, the write fails, or the pipe closes — so the fail direction is always
 * explicit and the caller picks the fallback. `from` is normally omitted by an
 * originating child (its parent stamps identity); it is only passed when re-forwarding.
 */
export async function ipcRequest<T = unknown>(
	method: string,
	params: unknown,
	from: string[] = [],
): Promise<IpcResult<T>> {
	const c = getClient();
	if (!c) return { ok: false, error: "no ipc channel" };
	return c.request<T>(method, params, from);
}

/** Fire-and-forget a method at the parent (no response awaited). */
export function ipcNotify(method: string, params: unknown, from: string[] = []): void {
	getClient()?.notify(method, params, from);
}

// ---- parent side -----------------------------------------------------------

export type IpcHandler = (params: unknown, meta: IpcMeta) => Promise<unknown> | unknown;
export type IpcHandlers = Record<string, IpcHandler>;
/** Resolve any method by name — the single-function form used by attachIpcDispatch. */
export type IpcDispatch = (method: string, params: unknown, meta: IpcMeta) => Promise<unknown> | unknown;

/**
 * Serve IPC messages arriving from a child over `stream` (the parent end of the child's
 * fd pipe), routing every method through one `dispatch` function. `childName` is that
 * direct child's agent name; it is prepended to each message's `from` path so the
 * dispatcher — and any further upstream forward — always sees the full asker chain. A
 * thrown dispatch replies with an error; notifications (no id) get no reply.
 *
 * This is the generic transport half. The routing policy (which capability serves a
 * method, when to forward upward) lives in the caller — see the `ipc` extension.
 */
export function attachIpcDispatch(stream: Duplex, childName: string, dispatch: IpcDispatch): void {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		buffer += chunk;
		let idx: number;
		while ((idx = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (!line.trim()) continue;
			let msg: Envelope;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof msg.method !== "string") continue;

			const method = msg.method;
			const meta: IpcMeta = {
				method,
				from: [childName, ...(Array.isArray(msg.from) ? msg.from : [])],
			};
			const id = msg.id;
			const isRequest = typeof id === "number";
			const reply = (env: { result?: unknown; error?: string }) => {
				if (!isRequest) return;
				try {
					stream.write(`${JSON.stringify({ id, ...env })}\n`);
				} catch {
					/* child already gone — nothing to answer */
				}
			};

			Promise.resolve()
				.then(() => dispatch(method, msg.params, meta))
				.then(
					(result) => reply({ result }),
					(err) => reply({ error: err instanceof Error ? err.message : String(err) }),
				);
		}
	});
	// The child owns this pipe's lifecycle; swallow errors so a mid-flight close
	// (e.g. the subagent aborted) never throws in the parent.
	stream.on("error", () => {});
}

/**
 * Serve IPC messages using a fixed handler map (thin wrapper over attachIpcDispatch).
 * Unknown methods reply with an error.
 */
export function attachIpc(stream: Duplex, childName: string, handlers: IpcHandlers): void {
	attachIpcDispatch(stream, childName, (method, params, meta) => {
		const handler = handlers[method];
		if (!handler) throw new Error(`unknown ipc method: ${method}`);
		return handler(params, meta);
	});
}
