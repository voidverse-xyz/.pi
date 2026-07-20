---
name: privacy
description: Prevent Claude, Codex, or any other agent from leaking private, local, or sensitive information into outward-facing artifacts (PR/issue/commit text, comments, public files, external services). Use before writing anything that leaves the local machine — especially PR descriptions, commit messages, issue bodies, and review comments. Also requires clear, explicit user confirmation before sending any data to a remote host outside the local network.
---

# Privacy

Anything that leaves the local machine is **publishing**. PR descriptions, issue
bodies, commit messages **and their trailers**, the **contents of any committed
file** (yes, including `.gitignore` comments, `AGENTS.md`, `README`), code review
comments, and content sent to external services can be cached, indexed, and read
by anyone — and stay visible even after you "delete" them. Treat every
outward-facing string as permanent and public.

## Confirm before any data leaves the machine for a remote host

Treat the **network boundary** as a gate, not just the publish step. Before any
action sends data to a host that is **not** loopback and **not** on the local
network — i.e. anything beyond `localhost`/`127.0.0.1`/`::1`, the private ranges
`10.*`, `172.16–31.*`, `192.168.*`, link-local, and `*.local`/mDNS names — **stop
and ask the user first**, unless they have already, in this session, explicitly
asked for that specific action.

This is broader than PRs and commits. It includes, for example:

- `git push`, `gh pr|issue|api`, and anything else touching GitHub/GitLab/etc.
- `curl`/`wget`/`fetch` that **upload** or POST data to a public URL
- Uploading files or images to image hosts, pastebins, gists, transfer/CDN services
- Publishing packages (`npm publish`, `pip upload`, container registries)
- Calling external/cloud APIs, webhooks, or **remote** MCP servers
- Any "share this" / "send this somewhere" that resolves to a public host

Why the gate exists: once data reaches a third-party server the user doesn't
control, it can be **logged, cached, indexed, retained, and read by others —
permanently, even after deletion** — and it cannot be pulled back. The
destination, the payload, and the *fact that it was sent* all leave the user's
hands the moment it crosses the boundary. That is the user's call to make, not
yours — and "the payload looks harmless" is not a reason to skip the ask.

### Make the confirmation clear and specific

A vague "OK to push?" is not enough. The ask must let the user decide with full
information, so spell out all four:

1. **What** data/content is being sent — name the file, the diff, the text.
2. **Where** it's going — the remote host/service by name (e.g. `github.com`,
   `img.shields.io`), and that it is **outside the local network**.
3. **Why** it needs to leave the machine for this task.
4. **What it means** — it becomes effectively public/retained and can't be
   reliably un-sent.

Template:

> ⚠️ This will send **<what>** to **<remote service / host>**, which is outside
> your local network. Once it's there, that service may store, cache, or index it,
> and it can't be reliably deleted. Want me to go ahead?

The only bypass is prior authorization: if the user said "push it", "open the PR",
or "upload the screenshot to X", that specific egress is covered — don't re-ask
for the thing they just told you to do. But authorization for one destination or
payload does **not** extend to another: pushing to GitHub ≠ uploading an image to
a third-party host. Confirm each new destination separately.

## The core rule: never describe what was hidden

If something is excluded for privacy (gitignored, redacted, kept local), do
**not** name it in any public artifact. **The exclusion itself is sensitive.**

Saying "I excluded `settings.json`, `start-agent.sh`, and
`.agent/settings.local.json`" leaks the exact filenames, paths, and existence
of the private files — handing a reader the map you were trying to withhold.

- ❌ "Personal files (`settings.json`, `start-agent.sh`, `.agent/settings.local.json`) are gitignored and excluded."
- ✅ "Local/personal config is gitignored." — or say nothing at all.
- ✅ Better: don't mention the exclusion in the public artifact; report it to the user **in chat** instead, where the detail is useful and stays private.

The distinction that matters: **chat with the user is private; the PR is public.**
Details that help the user (specific filenames, paths, IPs, what was excluded
and why) belong in your reply to them — never copied into the published text.

This applies to **committed files**, not just PR/commit prose:

- A committed `.gitignore` must list a pattern to ignore it, but keep its comments
  generic (`# local/personal — gitignored`); don't enumerate the personal
  filenames in editorial comments or repeat them in `AGENTS.md`/`README`/docs.
- Better still: a file that only exists on *your* machine (e.g. a personal
  launcher script) doesn't belong in the committed `.gitignore` at all — ignore it
  via `.git/info/exclude` (local, never committed) so its name is never published.
- ❌ committed `AGENTS.md`: "Keep machine-local files (`settings.json`,
  `start-agent.sh`, `.agent/`) out of git."
- ✅ committed `AGENTS.md`: "Machine-local config is gitignored; committed source of
  truth lives under `Agents/`." — names nothing personal.

## Never put these in outward-facing text

- Absolute home/user paths (`/home/<user>/...`, `/Users/<user>/...`)
- Private/LAN IPs and hostnames (`192.168.*`, `10.*`, internal DNS names)
- Other projects, clients, or repos unrelated to the current one
- Names of gitignored / redacted / `.local.*` / `.env*` files
- Tokens, keys, credentials, emails, session URLs (obvious, but scan anyway)
- Machine-specific or harness-specific config (permission modes, local aliases)
- **Agent session URLs / IDs in commit trailers** (`Claude-Session: https://claude.ai/code/session_...`, `Codex-Session: ...`) — never commit these
- **Harness/model-build detail bolted onto trailers or generated-by text** (`(1M context)`, `(fast mode)`, internal model IDs, local sandbox/permission details)

## Commit trailers — the one safe shape

Commit messages may get auto-appended trailers, and they are committed history
the same as the message body. Claude, Codex, and other agent tools can all leak
through this channel. Watch for these:

- **Session trailers** such as `Claude-Session:`, `Codex-Session:`,
  `OpenAI-Session:`, or any other session URL/ID. A session URL/ID is a private
  identifier for the conversation — it is on the never-publish list above.
  **Strip it from every commit.** It must never reach a pushed branch.
- **`Co-Authored-By:` with extra parenthetical or harness details.** If a tool
  appends a co-author trailer, the only acceptable shape is a neutral agent/model
  name + the normal noreply address, nothing else:

  - ✅ `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
  - ✅ `Co-Authored-By: Codex <noreply@openai.com>` if that is the tool's normal neutral identity
  - ❌ `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  - ❌ `Co-Authored-By: Codex (sandbox: workspace-write, model build: internal) <noreply@openai.com>`
  - ❌ any `Claude-Session:`, `Codex-Session:`, `OpenAI-Session:`, or session-URL line
- **Generated-by footers** that include session links, local paths, internal model
  identifiers, sandbox settings, or execution environment details. Remove the
  private detail; if attribution is needed, keep it generic.

Before committing, read the trailers and generated-by footers, not just the
message body. These ride along on *every* commit, so one leaked session URL
becomes one-per-commit across a branch.

## Before publishing, do a leak pass

Before `gh pr create/edit`, `gh issue ...`, `git commit`, posting a review
comment, or sending content to any external service, re-read the exact text and
grep your own draft for: home paths, private IPs, other project names, and the
names of anything you deliberately excluded. If a detail is only useful to the
user, move it to chat.

Also, before committing, run the pass over the parts that aren't the message body:

- **Commit trailers** — `git log <base>..HEAD --format='%(trailers)'` (or just read
  them): no `Claude-Session:`, `Codex-Session:`, other session trailers, or
  session URLs; co-author lines use the exact safe shape.
- **Committed files you're adding/editing** — does any `.gitignore` comment,
  `AGENTS.md`, `README`, or doc *name* an excluded personal file or describe what
  was withheld? `git grep -nE 'start-(claude|codex|agent)|settings\.json|\.env|/home/|/Users/' -- <staged paths>`.

## If you already leaked

Fix it immediately, then tell the user:

- PR/issue body or title: `gh pr edit <n> --body ...` / `gh issue edit`.
- Review/issue comment: edit or delete it (`gh api` for comment endpoints).
- Commit message or trailer: amend if unpushed; if pushed, warn the user that
  history rewrite + force-push is required and that the old content may persist in
  forks, caches, and the provider's reflog. A leak in *one* commit is
  `git commit --amend`; the same trailer across *many* commits needs a
  `git rebase` reword (or `git filter-repo --message-callback`) over the range.
- Treat any leaked secret as compromised — rotation, not just deletion, is the
  real fix.

## Why this skill exists

An agent listed three gitignored personal filenames in a public PR description
while explaining that they'd been excluded — defeating the exclusion. The
exclusion was correct; advertising it in a public artifact was the leak.

A later incident leaked two more ways at once: every commit on a pushed branch
carried an agent session URL and a `Co-Authored-By: ... (1M context)` trailer,
and a committed `AGENTS.md` + `.gitignore` comment spelled out machine-local
filenames. The message *bodies* and the PR description were clean — the leaks
were entirely in trailers and committed-file prose, the parts that are easy to
skip on a leak pass. This applies equally to Claude, Codex, and any other agent
that writes commit text, docs, comments, or outbound payloads.

The same principle extends to the **network boundary itself**: sending data to any
third-party host the user didn't ask you to contact is a leak waiting to happen,
no matter how innocuous the payload looks. The user, not the agent, decides what
is allowed to leave their machine — so ask first, clearly, every new destination.
