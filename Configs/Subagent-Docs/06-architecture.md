# Extension Architecture — pi-subagents package

Decided 2026-07-09 (D23). Monorepo conventions: package under
~/Agents/Documents/Configs/PiAgent/packages/pi-subagents/, package.json with
keywords:["pi-package"] + pi.extensions:["./extensions"], enabled by absolute path
in ~/.pi/agent/settings.json packages[] (alphabetical), /reload to pick up.

## Layout

```
packages/pi-subagents/
  package.json
  extensions/subagents/
    index.ts                  # entry: register tools, /subagents, widget, keybinds; wire events
    core.ts                   # facade — the ONLY import for tools/ and tui/
    runtime/
      types.ts                # SubagentRuntime interface (D7 swap-point)
      in-process.ts           # v1: createAgentSession + SessionManager
      scheduler.ts            # maxConcurrent slots, run queue, queued state (D13)
    store/
      layout.ts               # EVERY disk path in one file
      registry.ts             # roster, states, vitals (D15)
      teams.ts                # membership, scrub-on-retire (D12/D13)
      archive.ts              # retire-move + N-day GC
    typedefs/
      discover.ts             # project/home merge, project wins (D6)
      parse.ts                # frontmatter validation (04-type-schema)
    mail/
      envelope.ts             # envelope type, ulid ids (02-envelope-contract)
      mailbox.ts              # file-per-message, .done/, at-least-once
      deliver.ts              # turn-boundary injection, team check, bounce, hops
      digest.ts               # wake-digest composer (D14) — pure
    rails/
      autonomy.ts             # shared turn/token pool, pause state (D21)
      hops.ts                 # chain-depth check — pure
    sandbox/
      tools-filter.ts         # type allowlist → Pi tool set
      paths.ts                # readOnly > deny > write, realpath (D20) — pure
      bash-guard.ts           # mutation heuristics → escalation
      escalation.ts           # waiting state, approve-once/deny plumbing (D22)
    context/
      compose.ts              # D18 layers: identity block, roster, projectContext — pure
    tools/
      main-agent.ts           # the seven subagent_* tools (03-tool-surface)
      sub-agent.ts            # peers' send/queue pair
    tui/
      widget.ts  picker.ts  viewer.ts  escalation-modal.ts   # (05-tui-spec)
  test/
    e2e/                      # jiti-alias harness (proven pattern)
```

## Structural rules

1. core.ts is a facade; runtime/types.ts is an interface. tools/ and tui/ never
   import in-process.ts — daemon/RPC runtimes later are one new file implementing
   one interface; nothing else moves. Interface mirrors the power matrix
   deliberately: spawn, send, steer, interrupt, retire, status, peek, onEvent —
   the matrix IS the API.
2. store/layout.ts owns every path. "The directory is the truth" (D3/D5/D13) only
   holds if no other module invents paths.
3. Pure modules (unit-testable without a live agent): digest, paths, hops, parse,
   compose. The e2e harness covers wiring only.

## Build order (each phase independently verifiable)

1. Data layer — store/ + typedefs/ + envelope. Verify: dirs/files correct; bad
   frontmatter rejected.
2. One agent runs — minimal runtime/ + spawn/status tools. Verify: spawn a type,
   JSONL lands correctly, get-or-create wakes with memory.
3. Mail — mail/ + send + digest + non-blocking questions. Verify: Q → dormant →
   A → wake round-trip with digest.
4. Teams + rails — D12 enforcement, hops, autonomy pool, scheduler cap. Verify:
   out-of-team bounce; forced ping-pong dies at hop 8.
5. Sandbox — filter/paths/bash-guard/escalation + waiting state. Verify:
   out-of-scope write escalates; deny feeds tool-error.
6. TUI — widget → picker → viewer → modal (each useful alone).
7. Polish — collect, archive GC, vitals, oneshot auto-retire end-to-end.

Phases 1–3 = usable (spawn, talk, observe); 4–5 = safe; 6 = pleasant.
