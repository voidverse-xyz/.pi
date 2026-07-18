# pi-workflow

Claude Code-style workflow orchestration for Pi: the LLM calls the `workflow`
tool with a deterministic JavaScript script that fans out one-shot subagents.

```js
export const meta = { name: 'review', description: 'Review the diff', phases: ['Find', 'Verify'] };
phase('Find')
const findings = await parallel([
	() => agent('Review for bugs…', { label: 'bugs', schema: FINDINGS }),
	() => agent('Review for perf…', { label: 'perf', schema: FINDINGS }),
])
phase('Verify')
const verified = await pipeline(findings.filter(Boolean).flatMap(f => f.items),
	(f) => agent(`Adversarially verify: ${JSON.stringify(f)}`, { label: 'verify' }))
return { verified }
```

## Script API

- `agent(prompt, opts?)` — spawn a one-shot subagent (fresh in-process
  `AgentSession`, sandboxed coding tools), resolve its final text — or, with
  `opts.schema`, a validated JSON object delivered through a forced
  `structured_output` tool (invalid values are rejected in-turn; the model
  retries). `opts`: `{label, phase, schema, model ('provider/id'), thinking,
  tools (subset of read/bash/edit/write/grep/find/ls)}`.
- `parallel(thunks)` — concurrent; a failed thunk yields `null`.
- `pipeline(items, ...stages)` — per-item chains, no barrier between stages; a
  stage throw drops that item to `null`. Stages get `(prev, item, index)`.
- `phase(title)` / `log(msg)` / `args` — progress grouping, narrator lines, input.
- Determinism: `Date.now()`, zero-arg `new Date()`, and `Math.random()` throw
  (they would break resume). No `require`/`process`/`setTimeout`/`fetch`.
- Concurrency is capped (default 4; `~/.pi/agent/workflows.json`
  `{"maxConcurrent": n}`, clamp 1–64); excess calls queue FIFO.

## Surfaces

- **`workflow` tool** — `{script | name | scriptPath, args?, resumeFromRunId?}`
  (exactly one source). One run at a time. Result:
  `{runId, status: completed|stopped|failed, result, summary, runDir}`.
- **Resume** — every `agent()` result is journaled to
  `~/.pi/agent/sessions/<cwd-slug>/workflows/<runId>/journal.jsonl`. Re-run
  with `resumeFromRunId` and unchanged calls (hash of prompt+schema+model+
  thinking+tools) replay instantly from the cache; the first miss diverges and
  everything after runs live. Works across restarts and sessions.
- **Saved workflows** — `<cwd>/.pi/workflows/<name>.js` (wins; trust-gated)
  and `~/.pi/agent/workflows/<name>.js`; run via `name`. Meta header required.
- **`/workflows`** — list saved workflows + the active/last run;
  `/workflows <name>` shows meta; `/workflows stop` = the brake.
- **`alt+w`** — stop brake: aborts every running subagent; the tool returns
  `status: "stopped"` with partial results (resumable).
- **Widget** — live progress tree above the editor (phases, per-agent state,
  current tool, log tail); hidden when idle. It does not publish a footer status,
  so the shared directory/Git status line remains stable.
- **Safety** — subagent edit/write/bash go through the ported pi-subagents
  sandbox: hard deny on the run store and workflow library dirs, then human
  confirmation via pi-safety over the `workflow:confirm-request` bus channel
  (fail-closed when unclaimed).

## Layout

- `extensions/index.ts` — wiring (tool, command, shortcut, lifecycle).
- `extensions/workflow/` — `run.ts` orchestrator, `tool.ts`,
  `script/` (meta, vm compile, combinators), `runner/` (agent sessions,
  structured output, scheduler), `journal/` (layout, journal, replay cache),
  `library/` (saved workflows), `sandbox/` (system-deny, tools filter, safety
  bridge), `schema/` (validator, from pi-teams collect.ts), `tui/` (tree widget).

## Verify

```
./test/e2e/run.sh        # unit tests + strict typecheck + 5 live-SDK harnesses
```

Enable by adding the package path to `packages` in `~/.pi/agent/settings.json`,
then `/reload`. pi-safety ≥ this repo's version is required for confirmations
(it claims `workflow:confirm-request`).
