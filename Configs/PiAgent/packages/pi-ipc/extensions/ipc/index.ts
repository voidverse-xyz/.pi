/**
 * IPC — the parent↔subagent transport, as a standalone extension.
 *
 * A subagent runs as a headless child `pi` process (spawned by the subagents
 * delegation tool), so any capability that needs the interactive TUI — confirming a
 * gated command, asking the user a question — has no local UI. This extension owns the
 * transport (ipc.ts: JSON-RPC over a dedicated fd) that lets the child ask its parent
 * (which DOES have the TUI) to do it and forward the answer back.
 *
 * It is exposed to other extensions ONLY over `pi.events` — so command-safety,
 * user-inputs, and subagents depend on it through channel-name strings, never an import.
 * If this extension is not installed, consumers see no claim on their probe and degrade
 * gracefully (safety blocks the command, ask_user errors, delegation still runs — the
 * child just can't reach the parent for confirm/ask).
 *
 * Channels:
 *   ipc:client  {method, claim}      A consumer running IN a headless child asks to reach
 *                                    its parent. We claim iff this process has a channel.
 *   ipc:attach  {stream, childName}  subagents/delegate hands us a spawned child's control
 *                                    pipe to serve.
 *   ipc:serve   {method, claim}      We re-probe for a local capability (with a live TUI)
 *                                    to actually render the confirm / ask.
 *
 * The "claim probe": the consumer emits with a `claim` callback; a live provider calls
 * `claim(fn)` SYNCHRONOUSLY during the emit (before any await), so if nothing claimed by
 * the time `emit()` returns, the consumer degrades immediately — no timeouts, and a
 * blocking human confirm can never be mistaken for an absent provider.
 *
 * Install: ~/.pi/agent/extensions/ipc/
 * Reload: /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Duplex } from "node:stream";
import { attachIpcDispatch, hasIpcChannel, type IpcMeta, ipcRequest } from "./ipc.ts";

type ClaimFn = (params: unknown, meta: IpcMeta) => Promise<unknown> | unknown;
interface ClaimProbe {
	method: string;
	claim: (fn: ClaimFn) => void;
}

// Only one TUI panel can be on screen at once, but parallel subagents each ask for one
// concurrently — presenting two at once drops all but one. Serialize every LOCAL
// presentation (confirm / ask_user) through this chain. Process-wide, so it covers
// every child of every subagent call. Forwarded requests deliberately DON'T take this
// lock: they present at whatever ancestor owns the TUI, which serializes them there.
let uiLock: Promise<unknown> = Promise.resolve();
function withUiLock<T>(present: () => Promise<T> | T): Promise<T> {
	const run = uiLock.then(present, present);
	uiLock = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export default function ipc(pi: ExtensionAPI) {
	// (1) Child side: a same-process consumer (command-safety / user-inputs running in a
	// headless child) wants to reach the parent over the inherited fd. Claim only when
	// this process actually has a parent channel; otherwise leave it unclaimed so the
	// consumer degrades. Claim MUST be synchronous so the consumer's probe sees it.
	pi.events.on("ipc:client", (data) => {
		const { method, claim } = data as ClaimProbe;
		if (!hasIpcChannel()) return;
		claim(async (params, meta) => {
			const res = await ipcRequest(method, params, meta?.from ?? []);
			if (!res.ok) throw new Error(res.error);
			return res.value;
		});
	});

	// (2) Parent side: subagents/delegate hands us each spawned child's control stream.
	// One generic dispatcher per child: prefer a local capability that can render (probe
	// ipc:serve); else, if we're ourselves a headless subagent, bubble the request up our
	// own parent channel; else fail. Local presentations serialize via withUiLock; a
	// forwarded one does not (it serializes at the ancestor that owns the TUI). The `from`
	// asker chain is preserved by attachIpcDispatch (it prepends childName).
	pi.events.on("ipc:attach", (data) => {
		const { stream, childName } = data as { stream: Duplex; childName: string };
		attachIpcDispatch(stream, childName, async (method, params, meta) => {
			let claimed: ClaimFn | null = null;
			pi.events.emit("ipc:serve", {
				method,
				claim: (fn: ClaimFn) => {
					claimed = fn;
				},
			});
			if (claimed) return withUiLock(() => (claimed as ClaimFn)(params, meta));
			if (hasIpcChannel()) {
				const res = await ipcRequest(method, params, meta.from);
				if (!res.ok) throw new Error(res.error);
				return res.value;
			}
			throw new Error(`no handler for ipc method: ${method}`);
		});
	});
}
