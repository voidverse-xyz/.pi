/**
 * Subagents (v2) — persistent Pi subagents, clean-slate rebuild.
 *
 * Design: ~/Agents/Documents/Configs/Subagent-Docs/ (revised decision log
 * D1'–D27'). This is the v2 reimplementation; the v1 package is archived at
 * packages/_archive/pi-agents-v1/.
 *
 * Key differences from v1:
 *  - Flat session-scoped state: ~/.pi/agent/sessions/<cwd-slug>/subagents/<sessionId>/ (D3).
 *  - In-process runtime, single host-scope lease (no per-agent run-owner locks) (D7).
 *  - Flat peer communication, no teams (D12).
 *  - No pi-agents sandbox: human confirmation delegated to pi-safety over pi.events;
 *    pi-agents keeps only a thin non-overridable system-deny guard (D10a/D20).
 *  - Completion: background-by-default, explicit subagent_await to join;
 *    all-mail auto-wake of idle main (D24'/D26'/D27').
 *
 * Build order (see plan): 1 data layer, 2 runtime+spawn/status, 3 mail,
 * 4 rails, 5 pi-safety integration, 6 TUI, 7 completion + polish.
 *
 * Install: packages/pi-agents2/extensions/subagents/index.ts. Reload: /reload.
 *
 * NOTE: skeleton entry — not yet enabled in settings.json. Tools/TUI/events are
 * wired here phase by phase; each phase talks only to the core facade.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {
	// Phase 0 skeleton. Registration is added incrementally:
	//   Phase 2 → subagent_spawn / subagent_status + session_start core lease
	//   Phase 3 → subagent_send / subagent_steer / subagent_collect
	//   Phase 5 → pi-safety confirmation bridge
	//   Phase 6 → /agents command + widget/picker/viewer
	//   Phase 7 → subagent_await + main-mail auto-wake
}
