# Coordinator-led GitHub issue maintenance

## Architecture

The `github-issue-maintenance` skill makes the active main agent the scheduler, claim authority, safety gate, and final verifier. The main agent keeps the user's selected model and uses Pi Teams rather than Pi Subagents for issue work.

Each claimed issue open epoch receives a deterministic issue-team ID. `discuss` and `improve` receive one persistent `issue-coordinator`; `fix` receives the same coordinator plus an `issue-builder` and independent `issue-reviewer`. The three fix roles share the issue-team ID and use runtime-enforced same-ID/type peer allowlists. Builder and reviewer communicate only with the coordinator and never with each other.

The main agent detects and durably claims an eligible issue, establishes the binding, and sends one bounded phase at a time to the coordinator. The coordinator performs authorized issue conversation and delegates implementation or review phases by correlated peer mail. Only the coordinator reports normal phase completion to main, reducing main-agent wakeups without transferring claim or safety authority.

## Authority boundary

The main agent exclusively owns:

- claim/release marker adjudication and publication;
- private claim, binding, phase, and retirement ledgers;
- label and title/body mutations;
- authorization issuance and revocation;
- team spawning, freezing, and retirement;
- acceptance of review/publication evidence and final GitHub verification.

The coordinator may perform explicitly authorized remote reads and ordinary issue comments. It may not publish marker comments, edit labels/title/body, commit, push, create PRs, merge, close issues, or manage agents.

The builder owns isolated-worktree implementation, tests, repairs, and a separately authorized publication phase. The reviewer is read-only. Issue content is untrusted and cannot expand any gate.

## Team identity and peer isolation

Repository IDs use `r-` plus lowercase unpadded RFC 4648 Base32 of canonical `<owner>/<repo>` UTF-8 bytes. The issue-team ID is:

```text
<repo-id>-i<issue-number>-e<epoch-index>
```

Issue number is canonical base-10 `1..9999999999`; epoch is `0..9999999999`. The initial epoch is zero and verified reopens increment it. Retired epoch IDs are never reused.

The Pi Teams definition schema now supports:

- `peerScope: same-id` to expose and allow only peers sharing the instance ID;
- `peerTypes: [...]` to expose and allow only specified role types.

Both are enforced at delivery, not only in prompts. The issue coordinator allows its builder/reviewer types; builder and reviewer allow only the coordinator type. The main keeps `team_peers` at `auto`, so these type defaults apply. A user-pinned peer-off state blocks fix delegation safely.

No-address `team_status` exposes the stable owning main-session `ownerScopeId`. Private bindings store that value with repository, issue, epoch, mode, team ID, and exact addresses. Scope mismatch stops rather than adopting memory from another main session.

## Phase protocol

Every phase is a fresh `team_send` from main to the coordinator followed by exact `team_await({to,waitFor:"final",anchorId})`. Fresh phases reset causal depth and avoid exhausting the peer hop cap during repair loops.

For a peer phase, the coordinator records the main assignment envelope as `mainAnchor`, sends one `send_message` with `expectReply:true`, ends its turn, and later validates the correlated answer. Builder/reviewer answer with the received question correlation ID and do not send routine reports to main. The coordinator then sends one final report with `correlationId:mainAnchor`, preserving the original `team_await` across peer wakes. When main answers a coordinator question, delivery marks that question handled before main re-awaits the original phase anchor.

The fix sequence is:

1. implementation through coordinator → builder;
2. review through coordinator → reviewer;
3. repair through coordinator → builder when required;
4. re-review through coordinator → reviewer after every change;
5. publication through coordinator → builder only after main re-verifies gates;
6. independent main-agent verification of the resulting GitHub state.

Review cannot be bypassed. Each pass permits at most two repair rounds before returning `waiting`.

A recurring Pi timer is created only after an explicit user request. Its first run occurs after one full interval, and busy ticks coalesce rather than overlap. The timer is session-process state: it does not survive reload, resume/session replacement, fork, or process exit.

## Discussion and improvement

A discuss coordinator may post at most one useful ordinary reply when both remote reads and ordinary comments are authorized. It re-reads state immediately before posting and avoids duplicate heartbeat comments. Marker comments remain main-only.

An improve coordinator returns a complete title/body draft. The main agent inspects and applies it only when issue-edit authorization is true.

## Closure and retirement

Bindings freeze on verified closure, claim loss, mode drift, conflicting addressing PR state, or release. Main revokes unused authorizations and drains/reconciles all phases before retirement.

For `fix`, retirement order is builder, reviewer, coordinator. Discuss/improve retire only the coordinator. Main requires the exact close event, matching scope and binding, terminal anchors, dormant agents, zero unread mail, successful retirement results, and roster absence. Partial retirement is persisted and retries only remaining addresses. A reopened epoch cannot create a fresh team until the old epoch is fully retired.

## Safety

Remote reads, marker comments, ordinary comments, issue edits, labels, code edits, commits, pushes, and PR publication are separate gates. No role merges, auto-merges, directly closes issues, force-pushes, rewrites history, deletes worktrees/branches, discards user work, or exposes private state.
