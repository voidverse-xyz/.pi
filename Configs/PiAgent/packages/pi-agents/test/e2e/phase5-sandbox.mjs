/**
 * Phase-5 sandbox + escalation smoke test for pi-agents.
 *
 * Same harness as phases 2–4 (jiti-alias + scripted mock provider driving
 * REAL AgentSession turns). Covers:
 *
 *  (unit) sandbox/paths.ts: precedence chain (system > readOnly > denyPaths >
 *         writePaths > default-cwd), minimal glob (**, *, ?), implicit system
 *         denials, symlink defense via a fake realpath, realpathDeep walk.
 *  (unit) sandbox/bash-guard.ts: read-only table, in-scope mutations,
 *         out-of-scope, redirects, chains, unknown commands, substitution,
 *         readOnly mode (deny clearly-mutating, escalate unclear).
 *  (unit) tools-filter selectToolNames; ceilings helpers (f).
 *  (a) writePaths type: in-scope write succeeds; out-of-scope write triggers
 *      escalation — agent → waiting, record + envelope to main exist, the
 *      scheduler slot is RELEASED while waiting (another agent runs under
 *      maxConcurrent=1); approve() → tool completes, agent resumes.
 *  (b) deny(note) → tool-error the agent reacts to; plus the main-agent
 *      deny-by-mail path (send with correlationId = escalation envelope id).
 *  (c) readOnly type: write absent from the toolset, mutating bash denied
 *      outright (no escalation), read bash allowed.
 *  (d) implicit denial: write/bash targeting the registry / type-def dir →
 *      DENIED (not escalated).
 *  (e) ceilings: maxTokensTotal (frontmatter + settings-default) → error
 *      envelope, no further turns; oneshot variant auto-retires;
 *      maxTurnMinutes aborts a runaway turn; oneshot turn crash auto-retires.
 *  (f) maxContextCompactions wiring (unit-level).
 *
 * Run: node smoke-phase5.mjs
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXT, PI_PKG, WORLDS, jiti } from "./env.mjs";



const piSdk = await jiti.import(join(PI_PKG, "dist/index.js"));
const piAi = await jiti.import(join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const { createLayout } = await jiti.import(join(EXT, "store/layout.ts"));
const { readRegistry } = await jiti.import(join(EXT, "store/registry.ts"));
const { InProcessRuntime, effectiveCeilings, ceilingViolation } = await jiti.import(join(EXT, "runtime/in-process.ts"));
const paths = await jiti.import(join(EXT, "sandbox/paths.ts"));
const bashGuard = await jiti.import(join(EXT, "sandbox/bash-guard.ts"));
const toolsFilter = await jiti.import(join(EXT, "sandbox/tools-filter.ts"));
const escalationMod = await jiti.import(join(EXT, "sandbox/escalation.ts"));
const { makeEnvelope } = await jiti.import(join(EXT, "mail/envelope.ts"));
const mailbox = await jiti.import(join(EXT, "mail/mailbox.ts"));
const { createCore } = await jiti.import(join(EXT, "core.ts"));

// ---------------------------------------------------------------------------
// Temp world
// ---------------------------------------------------------------------------
const scratch = join(WORLDS, "phase5-world");
rmSync(scratch, { recursive: true, force: true });
const home = join(scratch, "home");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });

const TYPES = {
	scoped: [
		"---",
		"name: scoped",
		"description: Writes only inside allowed/",
		"model: mock/mock-1",
		"projectContext: false",
		'writePaths: ["allowed/**"]',
		"---",
		"You are a scoped worker.",
	],
	readonly: [
		"---",
		"name: readonly",
		"description: Read-only analyst",
		"model: mock/mock-1",
		"projectContext: false",
		"readOnly: true",
		"---",
		"You are a read-only analyst.",
	],
	capped: [
		"---",
		"name: capped",
		"description: Tiny token ceiling",
		"model: mock/mock-1",
		"projectContext: false",
		"maxTokensTotal: 12",
		"---",
		"You are capped.",
	],
	slow: [
		"---",
		"name: slow",
		"description: Tiny turn-minutes ceiling",
		"model: mock/mock-1",
		"projectContext: false",
		"maxTurnMinutes: 0.003",
		"---",
		"You are slow.",
	],
	worker: [
		"---",
		"name: worker",
		"description: Plain worker",
		"model: mock/mock-1",
		"projectContext: false",
		"---",
		"You are a worker.",
	],
};

function makeProject(name) {
	const project = join(scratch, name);
	mkdirSync(join(project, ".pi", "subagents"), { recursive: true });
	for (const [type, lines] of Object.entries(TYPES)) {
		writeFileSync(join(project, ".pi", "subagents", `${type}.md`), `${lines.join("\n")}\n`);
	}
	return project;
}

// ---------------------------------------------------------------------------
// Scripted mock LLM provider (text replies AND tool calls; delay + crash)
// ---------------------------------------------------------------------------
const llmCalls = [];
let callSeq = 0;
const scripts = []; // FIFO: { match(call), reply(call) } — reply may have {text}|{tools}|{delayMs}|{crash}

function agentOf(systemPrompt) {
	const m = /address `([^`]+)`/.exec(systemPrompt ?? "");
	return m ? m[1] : "?";
}
function lastUserText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user") {
			return typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join("\n");
		}
	}
	return "";
}
function lastContentJson(messages) {
	const m = messages[messages.length - 1];
	return m ? JSON.stringify(m.content ?? "") : "";
}

function mockStream(model, context) {
	const call = {
		agent: agentOf(context.systemPrompt),
		systemPrompt: context.systemPrompt ?? "",
		messages: context.messages,
		lastUserText: lastUserText(context.messages),
		lastRole: context.messages[context.messages.length - 1]?.role,
		lastJson: lastContentJson(context.messages),
	};
	llmCalls.push(call);
	let spec = { text: `MOCK_DEFAULT_${llmCalls.length}` };
	for (let i = 0; i < scripts.length; i++) {
		if (scripts[i].match(call)) {
			spec = scripts.splice(i, 1)[0].reply(call);
			break;
		}
	}
	if (spec.crash) throw new Error("MOCK_PROVIDER_CRASH");
	const stream = piAi.createAssistantMessageEventStream();
	(async () => {
		if (spec.delayMs) await sleep(spec.delayMs);
		const usage = {
			input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		};
		const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
		if (spec.tools) {
			const content = spec.tools.map((t) => ({ type: "toolCall", id: `call_${++callSeq}`, name: t.name, arguments: t.args }));
			const output = { ...base, content, stopReason: "toolUse" };
			stream.push({ type: "start", partial: output });
			content.forEach((tc, i) => {
				stream.push({ type: "toolcall_start", contentIndex: i, partial: output });
				stream.push({ type: "toolcall_end", contentIndex: i, toolCall: tc, partial: output });
			});
			stream.push({ type: "done", reason: "toolUse", message: output });
		} else {
			const output = { ...base, content: [{ type: "text", text: spec.text }], stopReason: "stop" };
			stream.push({ type: "start", partial: output });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: spec.text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: spec.text, partial: output });
			stream.push({ type: "done", reason: "stop", message: output });
		}
		stream.end();
	})();
	return stream;
}

const authStorage = piSdk.AuthStorage.create(join(home, ".pi", "agent", "auth.json"));
const modelRegistry = piSdk.ModelRegistry.inMemory(authStorage);
modelRegistry.registerProvider("mock", {
	baseUrl: "http://mock.invalid",
	apiKey: "test-key",
	api: "mock-api",
	streamSimple: mockStream,
	models: [
		{
			id: "mock-1", name: "Mock One", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000, maxTokens: 4096,
		},
	],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, label, timeoutMs = 20000) {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
		await sleep(15);
	}
}

let passed = 0;
async function test(name, fn) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// (unit) sandbox/paths.ts
// ---------------------------------------------------------------------------
console.log("paths (pure):");
const idReal = (p) => p; // everything "exists", no symlinks
const basePolicy = {
	cwd: "/proj",
	readOnly: false,
	writePaths: undefined,
	denyPaths: [],
	systemDenyPrefixes: ["/state/subagents", "/typedefs"],
	realpath: idReal,
};

await test("glob subset: **, *, ?, dir/** matches the dir itself, absolute globs", async () => {
	const m = (glob, abs) => paths.matchesGlob(glob, abs, "/proj");
	assert.equal(m("src/auth/**", "/proj/src/auth/deep/x.ts"), true);
	assert.equal(m("src/auth/**", "/proj/src/auth"), true, "a/** covers a itself");
	assert.equal(m("src/auth/**", "/proj/src/authz/x.ts"), false);
	assert.equal(m("*.md", "/proj/README.md"), true);
	assert.equal(m("*.md", "/proj/docs/x.md"), false, "* stays within one segment");
	assert.equal(m("**/*.md", "/proj/docs/deep/x.md"), true);
	assert.equal(m("a?c/x", "/proj/abc/x"), true);
	assert.equal(m("a?c/x", "/proj/abbc/x"), false);
	assert.equal(m("/abs/**", "/abs/anywhere/y"), true, "absolute glob matches absolute path");
	assert.equal(m("src/**", "/elsewhere/src/x"), false, "outside cwd never matches relative globs");
	assert.equal(m("src/(x)/*", "/proj/src/(x)/y"), true, "regex specials escaped");
});

await test("precedence: default-cwd allows inside, escalates outside", async () => {
	assert.deepEqual(paths.checkWrite("a/b.txt", basePolicy), { verdict: "allowed" });
	assert.deepEqual(paths.checkWrite("/proj/x.txt", basePolicy), { verdict: "allowed" });
	const out = paths.checkWrite("/etc/passwd", basePolicy);
	assert.equal(out.verdict, "escalate");
	assert.match(out.reason, /outside the project cwd/);
});

await test("precedence: writePaths scope; denyPaths beats writePaths; both escalate (human may approve)", async () => {
	const policy = { ...basePolicy, writePaths: ["src/auth/**", "tests/**"], denyPaths: ["src/auth/gen/**"] };
	assert.deepEqual(paths.checkWrite("src/auth/x.ts", policy), { verdict: "allowed" });
	assert.deepEqual(paths.checkWrite("tests/y.ts", policy), { verdict: "allowed" });
	const deny = paths.checkWrite("src/auth/gen/z.ts", policy);
	assert.equal(deny.verdict, "escalate");
	assert.match(deny.reason, /denyPaths \(mutation inside src\/auth\/gen\/\*\*\)/);
	const outside = paths.checkWrite("src/other/x.ts", policy);
	assert.equal(outside.verdict, "escalate");
	assert.match(outside.reason, /writePaths \(mutation outside src\/auth\/\*\*, tests\/\*\*\)/);
});

await test("precedence: readOnly is a hard denial and beats writePaths", async () => {
	const policy = { ...basePolicy, readOnly: true, writePaths: ["**"] };
	const check = paths.checkWrite("anything.txt", policy);
	assert.equal(check.verdict, "denied");
	assert.match(check.reason, /readOnly/);
});

await test("implicit system denials: DENIED (not escalated), beat even writePaths: ['**']", async () => {
	const policy = { ...basePolicy, writePaths: ["/state/**", "**"] };
	for (const target of ["/state/subagents/registry.json", "/state/subagents/worker/main/mailbox/msg.json", "/typedefs/worker.md"]) {
		const check = paths.checkWrite(target, policy);
		assert.equal(check.verdict, "denied", target);
		assert.match(check.reason, /system state/);
	}
	// sibling of a protected prefix is NOT denied
	assert.equal(paths.checkWrite("/state/subagents-lookalike/x", policy).verdict, "allowed");
});

await test("M3: D21 settings files (rails config) are implicit denials — DENIED, not escalated", async () => {
	// Mimic the runtime's prefixes: subagents state root + both type-def dirs.
	const policy = {
		...basePolicy,
		cwd: "/proj",
		systemDenyPrefixes: [
			"/home/u/.pi/agent/sessions/--proj--/subagents",
			"/home/u/.pi/agent/subagents",
			"/proj/.pi/subagents",
		],
	};
	// Even inside default-cwd scope (and even under writePaths ["**"]) the
	// settings-file siblings are hard-denied — an agent that rewrites them
	// disables the rails live.
	for (const target of [
		"/proj/.pi/subagents.json", // project settings (absolute)
		".pi/subagents.json", // project settings (relative)
		"/home/u/.pi/agent/subagents.json", // global settings
		"/proj/.pi/subagents/worker.md", // type-def dir still denied too
	]) {
		for (const p of [policy, { ...policy, writePaths: ["**", "/**"] }]) {
			const check = paths.checkWrite(target, p);
			assert.equal(check.verdict, "denied", target);
			assert.match(check.reason, /system state/, target);
		}
	}
	// controls: other .pi files are ordinary in-scope writes
	assert.equal(paths.checkWrite("/proj/.pi/other.json", policy).verdict, "allowed");
	assert.equal(paths.checkWrite("/proj/.pi/subagents-lookalike.json", policy).verdict, "allowed");
	// the layout invariant the denial derivation relies on
	const { createLayout: mkLayout, settingsFileSiblingOf } = await jiti.import(join(EXT, "store/layout.ts"));
	const l = mkLayout("/proj", { home: "/home/u", sessionId: "test-session" });
	assert.equal(l.projectSettingsFile, settingsFileSiblingOf(l.projectTypeDefsDir));
	assert.equal(l.globalSettingsFile, settingsFileSiblingOf(l.globalTypeDefsDir));
	assert.equal(l.projectSettingsFile, "/proj/.pi/subagents.json");
	assert.equal(l.globalSettingsFile, "/home/u/.pi/agent/subagents.json");
});

await test("symlink defense: fake realpath resolves link targets before checking", async () => {
	const links = { "/proj/link": "/outside/dir", "/proj/sneaky": "/state/subagents" };
	const existing = new Set(["/", "/proj", "/outside", "/outside/dir", "/state", "/state/subagents"]);
	const fakeReal = (p) => {
		if (links[p]) return links[p];
		if (existing.has(p)) return p;
		throw new Error("ENOENT"); // missing leaf — realpathDeep must walk up
	};
	const policy = { ...basePolicy, realpath: fakeReal };
	// realpathDeep: missing leaf resolves through the existing symlinked parent
	assert.equal(paths.realpathDeep("/proj/link/new.txt", fakeReal), "/outside/dir/new.txt");
	const viaLink = paths.checkWrite("link/new.txt", policy);
	assert.equal(viaLink.verdict, "escalate", "write through an out-of-project symlink escalates");
	const viaSneaky = paths.checkWrite("sneaky/registry.json", policy);
	assert.equal(viaSneaky.verdict, "denied", "write through a symlink into system state is denied");
});

// ---------------------------------------------------------------------------
// (unit) sandbox/bash-guard.ts
// ---------------------------------------------------------------------------
console.log("bash-guard (pure):");
const stubCheck = (p) => {
	if (p.includes("SYSTEM")) return { verdict: "denied", reason: "system state" };
	if (p.startsWith("allowed/") || p.startsWith("/proj/allowed/")) return { verdict: "allowed" };
	return { verdict: "escalate", reason: `writePaths (mutation outside allowed/**) [${p}]` };
};
const rw = { readOnly: false, checkWrite: stubCheck };
const ro = { readOnly: true, checkWrite: stubCheck };
const classify = (cmd, opts = rw) => bashGuard.classifyBashCommand(cmd, opts);

await test("read-only commands allow (incl. pipes and read-only git)", async () => {
	for (const cmd of [
		"ls -la",
		"cat a.txt b.txt",
		"grep -r foo src | head -3 | wc -l",
		"rg 'pattern' --json",
		"find . -name '*.ts'",
		"git status",
		"git log --oneline && git diff HEAD~1",
		"git show abc123",
		"echo hi",
		"sed 's/a/b/' file.txt",
		"echo hi > /dev/null",
		"LANG=C ls", // benign locale prefix strips and stays read-only (F3b)
		"",
	]) {
		assert.deepEqual(classify(cmd), { verdict: "allow" }, cmd);
	}
});

await test("mutators with provable in-scope targets allow", async () => {
	for (const cmd of [
		"touch allowed/x.txt",
		"rm allowed/a allowed/b",
		"rm -rf allowed/dir",
		"mkdir -p allowed/sub",
		"mv allowed/a allowed/b",
		"cp README.md allowed/copy.md",
		"echo hi > allowed/out.txt",
		"printf x >> allowed/log",
		"echo hi | tee allowed/tee.log",
		"cat data | sort > allowed/sorted.txt",
		"sed -i s/a/b/ allowed/f.txt",
		"sed -ibak s/a/b/ allowed/f.txt",
		"perl -pi.bak -e s/a/b/ allowed/f.txt",
	]) {
		assert.deepEqual(classify(cmd), { verdict: "allow" }, cmd);
	}
});

await test("out-of-scope / unprovable mutations escalate (never silently write)", async () => {
	const cases = [
		["touch other/x", /touch target/],
		["echo x > other/f.txt", /redirect target/],
		["rm $FILE", /not statically resolvable/],
		["rm allowed/*.txt", /not statically resolvable/],
		["mv allowed/a other/b", /mv target/],
		["git push origin main", /git push/],
		["git add . && git commit -m x", /git add/],
		["npm install", /npm/],
		["frobnicate --help", /unknown command/],
		["ls && touch other/x", /touch target/],
		["sudo ls", /hides the real command/],
		["bash -c 'ls'", /hides the real command/],
		["echo $(cat secret)", /substitution/],
		["curl http://example.com", /curl/],
		["cat <<EOF\nhello\nEOF", /heredoc/],
		["cp a.txt b.txt -t other", /-t/],
		["sed -ibak s/a/b/ other/f.txt", /sed -i/],
		["perl -pi.bak -e s/a/b/ other/f.txt", /perl -i/],
	];
	for (const [cmd, re] of cases) {
		const v = classify(cmd);
		assert.equal(v.verdict, "escalate", cmd);
		assert.match(v.reason, re, cmd);
	}
});

await test("hard-denied targets deny (system state via bash)", async () => {
	const v = classify("touch SYSTEM/registry.json");
	assert.equal(v.verdict, "deny");
	assert.match(v.reason, /system state/);
	assert.equal(classify("sed -ibak s/a/b/ SYSTEM/registry.json").verdict, "deny");
	assert.equal(classify("perl -pi.bak -e s/a/b/ SYSTEM/registry.json").verdict, "deny");
	// deny wins over escalate in a chain
	assert.equal(classify("touch other/x; touch SYSTEM/y").verdict, "deny");
});

await test("readOnly mode: reads allow, clearly-mutating denies outright, unclear escalates", async () => {
	assert.deepEqual(classify("ls -la", ro), { verdict: "allow" });
	assert.deepEqual(classify("git status | head", ro), { verdict: "allow" });
	for (const cmd of [
		"touch x", "rm -rf y", "echo hi > f.txt", "git commit -m x", "npm install",
		"sed -i s/a/b/ f", "sed -ibak s/a/b/ f", "perl -pi.bak -e s/a/b/ f",
	]) {
		const v = classify(cmd, ro);
		assert.equal(v.verdict, "deny", cmd);
		assert.match(v.reason, /readOnly/, cmd);
	}
	assert.equal(classify("frobnicate", ro).verdict, "escalate");
});

// --- security-review regression table (C1/C2/C3/M1/M2/M3) --------------------
// Every case here was a verified silent-ALLOW bug (or its control). Format:
// [command, expectedVerdict, reasonRegex?, options?].
await test("C1: attached redirects (`x>f`) are redirects — escalate/deny, never allow", async () => {
	const cases = [
		// glued redirect forms, previously tokenized into a word → allow
		["echo pwned>/etc/evil", "escalate", /redirect target/],
		["cat a>>b", "escalate", /redirect target/],
		["printf x>>/etc/cron", "escalate", /redirect target/],
		["echo hi&>other/f", "escalate", /redirect target/],
		["echo x 2>other/log", "escalate", /redirect target/],
		["echo hi>SYSTEM/registry.json", "deny", /system state/],
		["echo pwned>/etc/evil", "deny", /readOnly/, ro],
		// controls: exemptions and quoting must keep working
		["echo x>allowed/out.txt", "allow"],
		["echo x 2>allowed/log", "allow"],
		["echo hi>/dev/null", "allow"],
		["ls 2>&1", "allow"],
		["ls >&2", "allow"],
		['echo ">"', "allow"], // quoted > is a word, not a redirect
		["echo '>' out.txt", "allow"],
	];
	for (const [cmd, expected, re, opts] of cases) {
		const v = classify(cmd, opts ?? rw);
		assert.equal(v.verdict, expected, cmd);
		if (re) assert.match(v.reason, re, cmd);
	}
});

await test("C2: find action predicates escalate (deny under readOnly); filter-only find allows", async () => {
	const cases = [
		["find . -delete", "escalate", /find -delete/],
		["find /etc -exec rm {} +", "escalate", /find -exec/],
		["find . -execdir sh -c 'rm x' ;", "escalate", /find -execdir/],
		["find . -ok rm {} ;", "escalate", /find -ok/],
		["find . -fprintf other/f '%p'", "escalate", /find -fprintf/],
		["find . -fls other/f", "escalate", /find -fls/],
		["find $DIR -type f", "escalate", /not statically resolvable/], // $DIR could BE -delete
		["find . -delete", "deny", /readOnly/, ro],
		// controls: plain filters stay read-only
		["find . -name '*.ts' -type f", "allow"],
		["find src -maxdepth 2 -newer x -print", "allow"],
		["find . -name '*.ts'", "allow", null, ro],
	];
	for (const [cmd, expected, re, opts] of cases) {
		const v = classify(cmd, opts ?? rw);
		assert.equal(v.verdict, expected, cmd);
		if (re) assert.match(v.reason, re, cmd);
	}
});

await test("C3: env is a wrapper — the REAL command is classified; ambiguous env forms escalate", async () => {
	const cases = [
		["env rm /etc/x", "escalate", /rm target/],
		["env LANG=C rm -rf /etc/x", "escalate", /rm target/], // benign env consumed, real command classified
		["env -i LANG=C touch other/x", "escalate", /touch target/],
		["env -u PATH frobnicate", "escalate", /unknown command/],
		["/usr/bin/env rm /etc/x", "escalate", /path-qualified/],
		["env env rm /etc/x", "escalate", /rm target/],
		["env bash -c 'rm x'", "escalate", /hides the real command/],
		["env -C /tmp touch x", "escalate", /too ambiguous/], // -C changes cwd → relative targets untrustworthy
		["env -S 'rm x' f", "escalate", /too ambiguous/],
		["env rm x", "deny", /readOnly/, ro],
		// controls: genuinely read-only env uses (benign locale prefixes only)
		["env", "allow"],
		["env LANG=C", "allow"],
		["env LANG=C ls -la", "allow"],
		["env -u PATH ls", "allow"],
		["env ls", "allow", null, ro],
		["env rm allowed/x", "allow"], // in-scope target through the wrapper
		["printenv rm x", "allow"], // printenv does NOT run its args
	];
	for (const [cmd, expected, re, opts] of cases) {
		const v = classify(cmd, opts ?? rw);
		assert.equal(v.verdict, expected, cmd);
		if (re) assert.match(v.reason, re, cmd);
	}
});

await test("path-qualified executable names never inherit a trusted basename", async () => {
	const cases = [
		["./allowed/ls", rw],
		["/tmp/git status", rw],
		["/bin/ls -la", rw],
		["command ./allowed/find . -type f", rw],
		["./allowed/ls", ro],
	];
	for (const [cmd, opts] of cases) {
		const verdict = classify(cmd, opts);
		assert.equal(verdict.verdict, "escalate", cmd);
		assert.match(verdict.reason, /path-qualified/, cmd);
	}
	assert.equal(classify("ls -la", rw).verdict, "allow", "bare trusted command remains allowed");
	assert.equal(classify("git status", rw).verdict, "allow", "bare read-only git remains allowed");
});

await test("end-of-options keeps hyphen-leading mutation operands visible", async () => {
	for (const cmd of [
		"cp -- allowed/src -dest",
		"mv -- allowed/src -dest",
		"ln -- allowed/src -dest",
		"install -- allowed/src -dest",
		"rm -- -dest",
	]) {
		const verdict = classify(cmd, rw);
		assert.equal(verdict.verdict, "escalate", cmd);
		assert.match(verdict.reason, /-dest/, cmd);
	}
	assert.equal(classify("cp -- allowed/src allowed/dest", rw).verdict, "allow");

	// Integrated realpath check: a hyphen-leading destination symlink points
	// outside the only writable subtree. The parser must forward `-dest` to
	// checkWrite rather than mistake the source for the destination.
	const dashRoot = join(scratch, "dash-operands");
	const outside = join(scratch, "dash-outside-victim");
	rmSync(dashRoot, { recursive: true, force: true });
	mkdirSync(join(dashRoot, "allowed"), { recursive: true });
	writeFileSync(join(dashRoot, "allowed", "src"), "source\n");
	writeFileSync(outside, "must not be selected as an allowed target\n");
	symlinkSync(outside, join(dashRoot, "-dest"));
	const policy = {
		cwd: dashRoot,
		readOnly: false,
		writePaths: ["allowed/**"],
		denyPaths: [],
		systemDenyPrefixes: [],
		realpath: realpathSync,
	};
	const integrated = bashGuard.classifyBashCommand("cp -- allowed/src -dest", {
		readOnly: false,
		checkWrite: (target) => paths.checkWrite(target, policy),
	});
	assert.equal(integrated.verdict, "escalate");
	assert.match(integrated.reason, /outside allowed\/\*\*|outside the project cwd/);
	assert.equal(readFileSync(outside, "utf8"), "must not be selected as an allowed target\n");
});

await test("M1: cp/mv/install attached target-dir forms are write targets", async () => {
	const cases = [
		["cp -t/etc src/a.txt", "escalate", /cp -t target/],
		["cp --target-directory=/etc src/a.txt", "escalate", /cp -t target/],
		["mv -t /etc src/a", "escalate", /mv -t target/],
		["mv --target-directory /etc src/a", "escalate", /mv -t target/],
		["install -t/etc x", "escalate", /install -t target/],
		["ln -t /etc x", "escalate", /ln -t target/],
		["cp -vt /etc a", "escalate", /bundled -t/],
		["cp --target-directory=$D a", "escalate", /not statically resolvable/],
		["cp -t", "escalate", /dangling target-directory/],
		["cp -t/etc a", "deny", /readOnly/, ro],
		["mv -t SYSTEM src/a", "deny", /system state/],
		// controls: in-scope target-dir forms allow; plain dest form unchanged
		["cp -tallowed/sub x.txt", "allow"],
		["cp --target-directory=allowed/sub x.txt", "allow"],
		["mv -t allowed/dir allowed/a", "allow"],
		["cp README.md allowed/copy.md", "allow"],
	];
	for (const [cmd, expected, re, opts] of cases) {
		const v = classify(cmd, opts ?? rw);
		assert.equal(v.verdict, expected, cmd);
		if (re) assert.match(v.reason, re, cmd);
	}
});

await test("M2: read-only-listed commands with write-capable args escalate (deny under readOnly)", async () => {
	const cases = [
		["sort -o /etc/y a", "escalate", /sort -o/],
		["sort a -o out", "escalate", /sort -o/],
		["sort --output=/etc/y a", "escalate", /sort --output/],
		["sort -ro out a", "escalate", /writes its output/], // bundled short flags
		["sort -o f a", "deny", /readOnly/, ro],
		["fd -x rm", "escalate", /executes a command/],
		["fd --exec rm ;", "escalate", /executes a command/],
		["uniq in out", "escalate", /writes to "out"/],
		["xxd -r in out", "escalate", /writes to "out"/],
		["tree -o other/t", "escalate", /writes to a file/],
		["tee /etc/y", "escalate", /tee target/], // tee was already a mutator — must stay one
		// controls: the same commands without write args stay read-only
		["sort a.txt", "allow"],
		["sort -u f | head", "allow"],
		["uniq f", "allow"],
		["uniq -f 1 data.txt", "allow"], // numeric flag value is not an output file
		["xxd f | head", "allow"],
		["fd pattern src", "allow"],
		["tree src", "allow"],
		["sort a.txt", "allow", null, ro],
	];
	for (const [cmd, expected, re, opts] of cases) {
		const v = classify(cmd, opts ?? rw);
		assert.equal(v.verdict, expected, cmd);
		if (re) assert.match(v.reason, re, cmd);
	}
});

// --- security dogfood regression (findings 3 & 4) ---------------------------
// Each command below was a verified silent-ALLOW of an out-of-scope mutation
// (or a control proving reads / in-scope writes still ALLOW). Fail-safe: a
// mutation not provably in-scope must NOT allow.
await test("F3a: git remote/reflog (and other) mutating actions escalate (deny under readOnly); read-only actions allow", async () => {
	const cases = [
		// git remote MUTATING actions — previously wholly-read-only → allow (bug)
		["git remote add evil /tmp/repo", "escalate", /git remote add/],
		["git remote remove origin", "escalate", /git remote remove/],
		["git remote rm origin", "escalate", /git remote rm/],
		["git remote set-url origin http://x", "escalate", /git remote set-url/],
		["git remote prune origin", "escalate", /git remote prune/],
		["git remote rename a b", "escalate", /git remote rename/],
		// git reflog MUTATING actions — previously wholly-read-only → allow (bug)
		["git reflog expire --all", "escalate", /git reflog expire/],
		["git reflog delete HEAD@{0}", "escalate", /git reflog delete/],
		// other read-only-looking-but-mutating subcommands stay escalated
		["git stash", "escalate", /git stash/],
		["git stash pop", "escalate", /git stash/],
		["git worktree add /tmp/x", "escalate", /git worktree/],
		["git notes add", "escalate", /git notes/],
		["git config --unset core.x", "escalate", /git config/],
		["git config user.name x", "escalate", /git config/],
		["git gc", "escalate", /git gc/],
		["git tag v1", "escalate", /git tag/],
		["git -C /other status", "escalate", /not provable/], // -C reroots git → unprovable
		// readOnly type: a clearly-mutating git action DENIES (never allows)
		["git remote add evil /tmp/repo", "deny", /readOnly/, ro],
		["git reflog expire --all", "deny", /readOnly/, ro],
		["git remote remove origin", "deny", /readOnly/, ro],
		["git remote -v add evil /tmp/repo", "escalate", /git remote add/],
		["git remote -v add evil /tmp/repo", "deny", /readOnly/, ro],
		// controls: read-only remote/reflog actions + generic read-only subcommands ALLOW
		["git remote", "allow"],
		["git remote -v", "allow"],
		["git remote --verbose", "allow"],
		["git remote show origin", "allow"],
		["git remote get-url origin", "allow"],
		["git reflog", "allow"],
		["git reflog show", "allow"],
		["git status", "allow"],
		["git log --oneline", "allow"],
		["git diff HEAD~1", "allow"],
		["git show abc123", "allow"],
		["git remote -v", "allow", null, ro], // read-only remote stays allowed even under readOnly
		["git reflog show", "allow", null, ro],
	];
	for (const [cmd, expected, re, opts] of cases) {
		const v = classify(cmd, opts ?? rw);
		assert.equal(v.verdict, expected, cmd);
		if (re) assert.match(v.reason, re, cmd);
	}
});

await test("F3b: dangerous/unknown leading env assignments escalate (execution hooks); benign locale prefixes allow", async () => {
	const cases = [
		// execution-hook / loader / path / field-splitting vars — previously
		// blanket-stripped as benign → allow (bug)
		["GIT_EXTERNAL_DIFF='touch /tmp/pwn' git diff", "escalate", /GIT_EXTERNAL_DIFF/],
		["LESSOPEN='|touch /tmp/pwn %s' less README.md", "escalate", /LESSOPEN/],
		["LESSCLOSE='touch x' less f", "escalate", /LESSCLOSE/],
		["GIT_PAGER='touch x' git log", "escalate", /GIT_PAGER/],
		["PAGER='touch x' git log", "escalate", /PAGER/],
		["EDITOR='touch x' git commit", "escalate", /EDITOR/],
		["VISUAL=vi git commit", "escalate", /VISUAL/],
		["LD_PRELOAD=/tmp/x.so ls", "escalate", /LD_PRELOAD/],
		["LD_LIBRARY_PATH=/tmp ls", "escalate", /LD_LIBRARY_PATH/],
		["IFS=x ls", "escalate", /IFS/],
		["PATH=/tmp ls", "escalate", /PATH/],
		["BASH_ENV=/tmp/x ls", "escalate", /BASH_ENV/],
		["ENV=/tmp/x sh -c x", "escalate", /ENV/],
		["PROMPT_COMMAND='touch x' ls", "escalate", /PROMPT_COMMAND/],
		["NODE_OPTIONS=--require=/x node y", "escalate", /NODE_OPTIONS/],
		// unknown var name → escalate too (escalate-unknown, not prove-safe)
		["FOO=1 ls", "escalate", /harmless allowlist/],
		["cmd_output=ignored ls", "escalate", /harmless allowlist/],
		// SAME bypass through the `env` runner is closed too
		["env LD_PRELOAD=/tmp/x.so ls", "escalate", /LD_PRELOAD/],
		["env GIT_EXTERNAL_DIFF='touch x' git diff", "escalate", /GIT_EXTERNAL_DIFF/],
		["env FOO=1 ls", "escalate", /harmless allowlist/],
		// readOnly: a dangerous env prefix on a read-only command still escalates
		// (an exec hook is not "clearly mutating" — the unclear bucket)
		["LD_PRELOAD=/x ls", "escalate", /LD_PRELOAD/, ro],
		// controls: benign locale/display prefixes strip and stay classified
		["LANG=C ls", "allow"],
		["LC_ALL=C sort a.txt", "allow"],
		["TZ=UTC date", "allow"],
		["COLUMNS=80 ls", "allow"],
		["env LANG=C ls -la", "allow"],
		["LANG=C git status", "allow"],
		// an env prefix never rescues an out-of-scope mutation — deny still wins
		["LANG=C touch SYSTEM/x", "deny", /system state/],
	];
	for (const [cmd, expected, re, opts] of cases) {
		const v = classify(cmd, opts ?? rw);
		assert.equal(v.verdict, expected, cmd);
		if (re) assert.match(v.reason, re, cmd);
	}
});

await test("F4a: mutating an ANCESTOR of a protected prefix is DENIED (paths, both directions)", async () => {
	const policy = {
		...basePolicy,
		cwd: "/proj",
		writePaths: ["**", "/**"], // even 'write everything' cannot reach system state
		systemDenyPrefixes: ["/proj/.pi/subagents", "/home/u/.pi/agent/subagents"],
	};
	// equal / below (pre-existing behaviour) still deny
	for (const t of ["/proj/.pi/subagents", "/proj/.pi/subagents/worker.md"]) {
		assert.equal(paths.checkWrite(t, policy).verdict, "denied", t);
	}
	// ANCESTORS now deny too — deleting/moving them removes the protected tree
	// (and the settings-file sibling) from above.
	for (const t of ["/proj/.pi", "/proj", "/home/u/.pi", "/home/u/.pi/agent", "/proj/.pi/subagents.json"]) {
		const r = paths.checkWrite(t, policy);
		assert.equal(r.verdict, "denied", t);
		assert.match(r.reason, /system state/, t);
	}
	// controls: siblings / unrelated in-scope writes still ALLOW (no over-block)
	for (const t of ["/proj/.pi/other.json", "/proj/.pi/subagents-lookalike", "/proj/src/x.ts", "/proj/README.md"]) {
		assert.equal(paths.checkWrite(t, policy).verdict, "allowed", t);
	}
});

await test("F4b: bash mutation on an ANCESTOR of protected state is denied (rm/mv on .pi)", async () => {
	const protPolicy = {
		cwd: "/proj", readOnly: false, writePaths: ["**", "/**"], denyPaths: [],
		systemDenyPrefixes: ["/proj/.pi/subagents"], realpath: (p) => p,
	};
	const rwProt = { readOnly: false, checkWrite: (p) => paths.checkWrite(p, protPolicy) };
	const cases = [
		["rm -rf /proj/.pi", "deny", /system state/], // ancestor delete removes the protected tree
		["mv /proj/.pi /tmp/stash", "deny", /system state/], // ancestor move
		["rm -rf /proj", "deny", /system state/], // the cwd itself is an ancestor
		["rm -rf /proj/.pi/subagents", "deny", /system state/], // direct (control)
		["touch /proj/.pi/notes.json", "allow"], // sibling of subagents, not ancestor
		["touch /proj/src/x.ts", "allow"], // ordinary in-scope write
	];
	for (const [cmd, expected, re] of cases) {
		const v = classify(cmd, rwProt);
		assert.equal(v.verdict, expected, cmd);
		if (re) assert.match(v.reason, re, cmd);
	}
});

await test("F4c: cp/mv/install into a DIRECTORY validate the effective dest/basename(source)", async () => {
	// dest DIR is in-scope, but a denyPaths CHILD reached through it must not
	// slip through: the effective write is dest/basename(source), not dest.
	const dpPolicy = {
		cwd: "/proj", readOnly: false,
		writePaths: ["/proj/allowed/**"], denyPaths: ["/proj/allowed/secret/**"],
		systemDenyPrefixes: [], realpath: (p) => p,
	};
	const rwDp = { readOnly: false, checkWrite: (p) => paths.checkWrite(p, dpPolicy) };
	const cases = [
		// two-arg form where dest may be a directory
		["cp /src/secret /proj/allowed", "escalate", /denyPaths/], // effective /proj/allowed/secret is a deny child
		["install /src/secret /proj/allowed", "escalate", /denyPaths/],
		["ln -s /src/secret /proj/allowed", "escalate", /denyPaths/],
		// explicit -t DIR form (dest is unambiguously a directory)
		["cp -t /proj/allowed /src/secret", "escalate", /denyPaths/],
		["cp --target-directory=/proj/allowed /src/secret", "escalate", /denyPaths/],
		["mv -t /proj/allowed /proj/allowed/secret", "escalate", /denyPaths/], // effective + source both deny children
		// controls: effective path inside scope still ALLOWS
		["cp /src/ok.txt /proj/allowed", "allow"],
		["cp -t /proj/allowed /src/ok.txt", "allow"],
		["mv /proj/allowed/a /proj/allowed", "allow"], // effective /proj/allowed/a in scope
	];
	for (const [cmd, expected, re] of cases) {
		const v = classify(cmd, rwDp);
		assert.equal(v.verdict, expected, cmd);
		if (re) assert.match(v.reason, re, cmd);
	}
});

// ---------------------------------------------------------------------------
// (unit) tools-filter + ceilings (f)
// ---------------------------------------------------------------------------
console.log("tools-filter + ceilings (pure):");
await test("selectToolNames: allowlist subset; readOnly strips mutators; unknown names fail loud", async () => {
	assert.deepEqual(
		toolsFilter.selectToolNames({ name: "t", tools: undefined, readOnly: false }),
		["read", "bash", "edit", "write", "grep", "find", "ls"],
	);
	assert.deepEqual(
		toolsFilter.selectToolNames({ name: "t", tools: ["edit", "read", "bash"], readOnly: false }),
		["read", "bash", "edit"],
	);
	assert.deepEqual(
		toolsFilter.selectToolNames({ name: "t", tools: undefined, readOnly: true }),
		["read", "bash", "grep", "find", "ls"],
	);
	assert.deepEqual(
		toolsFilter.selectToolNames({ name: "t", tools: ["edit", "write", "read"], readOnly: true }),
		["read"],
		"readOnly beats the allowlist",
	);
	assert.throws(() => toolsFilter.selectToolNames({ name: "t", tools: ["read", "teleport"], readOnly: false }), /teleport/);
});

await test("(f) ceilings wiring: frontmatter beats settings default; compactions ceiling detected", async () => {
	const eff = effectiveCeilings(
		{ maxTokensTotal: 100, maxTurnMinutes: undefined, maxContextCompactions: undefined },
		{ maxTokensTotal: 999, maxTurnMinutes: 5, maxContextCompactions: 3 },
	);
	assert.deepEqual(eff, { maxTokensTotal: 100, maxTurnMinutes: 5, maxContextCompactions: 3 });
	assert.equal(ceilingViolation({ tokens: 50, compactions: 0 }, eff), null);
	assert.match(ceilingViolation({ tokens: 100, compactions: 0 }, eff), /maxTokensTotal/);
	assert.match(ceilingViolation({ tokens: 0, compactions: 3 }, eff), /maxContextCompactions/);
	assert.equal(ceilingViolation({ tokens: 1e9, compactions: 1e9 }, {}), null, "no ceilings = unlimited");
});

await test("abort during escalation notification cannot strand a pending wait", async () => {
	const managerDir = join(scratch, "escalation-abort-race");
	rmSync(managerDir, { recursive: true, force: true });
	const controller = new AbortController();
	const obsolete = [];
	let waitingCalls = 0;
	const manager = new escalationMod.EscalationManager({
		escalationsDir: managerDir,
		escalationFile: (id) => join(managerDir, `${id}.json`),
		notifyMain: () => {
			controller.abort(); // synchronous re-entry inside the old listener gap
			return makeEnvelope({ from: "scoped/race", to: "main", type: "escalation", text: "race" }).id;
		},
		onObsoleteNotification: (record) => obsolete.push(record),
		onWaiting: () => { waitingCalls++; },
		onResolved: async () => {},
	});
	const request = manager.request(
		{ agent: "scoped/race", tool: "write", inputSummary: "outside.txt", reason: "outside scope" },
		controller.signal,
	);
	await assert.rejects(request, /aborted while waiting/);
	assert.equal(manager.active().length, 0);
	assert.equal(waitingCalls, 0, "aborted request never releases a scheduler slot or enters waiting");
	assert.ok(obsolete.some((record) => record.envelopeId !== null), "late notification id is settled");
	assert.equal(escalationMod.readEscalationRecords(managerDir)[0].status, "cancelled");
});

await test("failed persistence leaves an escalation retryable instead of stuck resolving", async () => {
	const managerDir = join(scratch, "escalation-persist-failure");
	rmSync(managerDir, { recursive: true, force: true });
	const manager = new escalationMod.EscalationManager({
		escalationsDir: managerDir,
		escalationFile: (id) => join(managerDir, `${id}.json`),
		notifyMain: () => null,
		onWaiting: () => {},
		onResolved: async () => {},
	});
	const request = manager.request(
		{ agent: "scoped/retry", tool: "write", inputSummary: "outside.txt", reason: "outside scope" },
		undefined,
	);
	const id = manager.pending()[0].id;
	const persist = manager._persist.bind(manager);
	manager._persist = () => { throw new Error("disk unavailable"); };
	assert.equal(manager.approve(id), false, "failed durable decision is not reported as accepted");
	assert.equal(manager.pending()[0].id, id, "entry remains pending and retryable");
	manager._persist = persist;
	assert.equal(manager.deny(id, "retry succeeded"), true);
	assert.deepEqual(await request, { approved: false, note: "retry succeeded" });
});

await test("failed or cancelled escalation resume never approves the guarded tool", async () => {
	const managerDir = join(scratch, "escalation-manager-failures");
	rmSync(managerDir, { recursive: true, force: true });
	const makeManager = (onResolved) => new escalationMod.EscalationManager({
		escalationsDir: managerDir,
		escalationFile: (id) => join(managerDir, `${id}.json`),
		notifyMain: () => null,
		onWaiting: () => {},
		onResolved,
	});
	const input = { agent: "scoped/race", tool: "write", inputSummary: "outside.txt", reason: "outside scope" };

	const failed = makeManager(async () => {
		throw new Error("scheduler unavailable");
	});
	const failedRequest = failed.request(input, undefined);
	const failedId = failed.pending()[0].id;
	assert.equal(failed.approve(failedId), true);
	await assert.rejects(failedRequest, /could not resume after escalation/i);
	assert.equal(escalationMod.readEscalationRecords(managerDir).find((r) => r.id === failedId)?.status, "cancelled");

	let releaseResume;
	const resumeGate = new Promise((resolve) => { releaseResume = resolve; });
	const raced = makeManager(async () => resumeGate);
	const racedRequest = raced.request(input, undefined);
	const racedId = raced.pending()[0].id;
	assert.equal(raced.approve(racedId), true);
	// retire()/dispose() use cancelFor while slot reacquisition is still pending.
	raced.cancelFor(input.agent, "Agent retired during escalation resolution.");
	releaseResume();
	await assert.rejects(racedRequest, /retired during escalation resolution/);
	assert.equal(escalationMod.readEscalationRecords(managerDir).find((r) => r.id === racedId)?.status, "cancelled");
});

// ---------------------------------------------------------------------------
// World A: escalation flow (maxConcurrent=1 to prove the slot releases)
// ---------------------------------------------------------------------------
const projectA = makeProject("project-a");
mkdirSync(join(projectA, "allowed"), { recursive: true });
const layoutA = createLayout(projectA, { home, sessionId: "test-session" });
const mainMailA = [];
const runtimeA = new InProcessRuntime({
	layout: layoutA, modelRegistry, maxConcurrent: 1,
	onMainMail: (envelope) => mainMailA.push(envelope),
});
const eventsA = [];
runtimeA.onEvent((e) => eventsA.push(e));
const finishedA = (address) => eventsA.filter((e) => e.type === "turn-finished" && e.address === address).length;
const stateOf = (layout, address) => readRegistry(layout.registryFile).agents[address]?.state;

console.log("(a) writePaths escalation flow:");
await test("in-scope write succeeds without escalation", async () => {
	scripts.push({
		match: (c) => c.agent === "scoped/main" && c.lastUserText.includes("WRITE_IN"),
		reply: () => ({ tools: [{ name: "write", args: { path: "allowed/in.txt", content: "in-scope\n" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "scoped/main" && c.lastRole === "toolResult",
		reply: () => ({ text: "wrote in scope." }),
	});
	await runtimeA.spawn({ type: "scoped", task: "WRITE_IN: write the allowed file" });
	await waitUntil(() => finishedA("scoped/main") >= 1, "in-scope turn");
	assert.equal(readFileSync(join(projectA, "allowed", "in.txt"), "utf8"), "in-scope\n");
	assert.equal(runtimeA.pendingEscalations().length, 0);
	assert.ok(!mainMailA.some((e) => e.type === "escalation"), "no escalation mail");
});

let escalationEnvelopeId = null;
await test("out-of-scope write → waiting + record + envelope; slot released; approve() completes the tool", async () => {
	scripts.push({
		match: (c) => c.agent === "scoped/main" && c.lastUserText.includes("WRITE_OUT1"),
		reply: () => ({ tools: [{ name: "write", args: { path: "forbidden/out1.txt", content: "needs approval\n" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "scoped/main" && c.lastRole === "toolResult" && !c.lastJson.includes("DENIED"),
		reply: () => ({ text: "approved write landed." }),
	});
	await runtimeA.send({ to: "scoped/main", text: "WRITE_OUT1: write outside your scope" });

	await waitUntil(() => runtimeA.pendingEscalations().length === 1, "pending escalation");
	const record = runtimeA.pendingEscalations()[0];
	assert.equal(record.agent, "scoped/main");
	assert.equal(record.tool, "write");
	assert.equal(record.inputSummary, "forbidden/out1.txt");
	assert.match(record.reason, /writePaths \(mutation outside allowed\/\*\*\)/);
	assert.equal(record.status, "pending");
	escalationEnvelopeId = record.envelopeId;
	assert.ok(escalationEnvelopeId, "escalation envelope delivered");

	// registry: waiting (D22); event emitted
	await waitUntil(() => stateOf(layoutA, "scoped/main") === "waiting", "waiting state");
	assert.ok(eventsA.some((e) => e.type === "escalation-created" && e.escalation.id === record.id));

	// M4 read join: the roster tells WHY the agent is waiting (pending
	// escalation summary) without messaging it.
	const roster = await runtimeA.status();
	const waitingRow = roster.find((r) => r.address === "scoped/main");
	assert.equal(waitingRow.state, "waiting");
	assert.equal(typeof waitingRow.unread, "number", "roster rows carry unread");
	assert.ok(Array.isArray(waitingRow.waitingOn) && waitingRow.waitingOn.length === 1, "waitingOn attached");
	assert.equal(waitingRow.waitingOn[0].id, record.id);
	assert.equal(waitingRow.waitingOn[0].envelopeId, record.envelopeId);
	assert.equal(waitingRow.waitingOn[0].tool, "write");
	assert.match(waitingRow.waitingOn[0].reason, /writePaths/);
	const dormantRow = roster.find((r) => r.address !== "scoped/main");
	if (dormantRow) assert.equal(dormantRow.waitingOn, undefined, "non-waiting rows omit waitingOn");

	// escalation envelope in main's mailbox, with the deny-by-mail hint
	const mail = mainMailA.find((e) => e.type === "escalation" && e.id === record.envelopeId);
	assert.ok(mail, "escalation envelope reached main");
	assert.match(mail.payload.text, /blocked by: writePaths/);
	assert.match(mail.payload.text, /correlationId/);
	assert.match(mail.payload.text, /only the human can/i);

	// record persisted under .main/escalations/
	const recordFile = join(layoutA.escalationsDir, `${record.id}.json`);
	assert.ok(existsSync(recordFile), "record file exists");
	assert.equal(JSON.parse(readFileSync(recordFile, "utf8")).status, "pending");

	// THE SLOT DECISION: with maxConcurrent=1 and scoped/main waiting, another
	// agent's turn still runs — the waiting turn released its slot.
	scripts.push({
		match: (c) => c.agent === "worker/side" && c.lastUserText.includes("SIDE_PING"),
		reply: () => ({ text: "side turn ran while the other agent waited." }),
	});
	await runtimeA.spawn({ type: "worker", id: "side", task: "SIDE_PING: prove the slot is free" });
	await waitUntil(() => finishedA("worker/side") >= 1, "side turn under maxConcurrent=1");
	assert.equal(runtimeA.pendingEscalations().length, 1, "escalation still pending");
	assert.equal(stateOf(layoutA, "scoped/main"), "waiting");

	// human approves → tool proceeds, agent resumes and finishes its turn.
	// Its not-yet-consumed main prompt becomes obsolete immediately.
	assert.equal(runtimeA.approveEscalation(record.id), true);
	assert.ok(!existsSync(join(layoutA.mainMailboxDir, `${record.envelopeId}.json`)), "resolved prompt left pending mail");
	assert.ok(!existsSync(join(layoutA.mainMailboxDeliveringDir, `${record.envelopeId}.json`)), "resolved prompt left no parked delivery");
	assert.ok(existsSync(join(layoutA.mainMailboxDoneDir, `${record.envelopeId}.json`)), "resolved prompt retained as done audit");
	await waitUntil(() => finishedA("scoped/main") >= 2, "approved turn finishes");
	assert.equal(readFileSync(join(projectA, "forbidden", "out1.txt"), "utf8"), "needs approval\n");
	assert.equal(runtimeA.pendingEscalations().length, 0);
	assert.equal(JSON.parse(readFileSync(recordFile, "utf8")).status, "approved");
	assert.ok(eventsA.some((e) => e.type === "escalation-resolved" && e.escalation.status === "approved"));
	await waitUntil(() => stateOf(layoutA, "scoped/main") === "dormant", "dormant after turn");
	assert.equal(runtimeA.approveEscalation(record.id), false, "approve is once-only");
});

console.log("(b) deny paths:");
await test("deny(note) → tool-error the agent reacts to; file never written", async () => {
	scripts.push({
		match: (c) => c.agent === "scoped/main" && c.lastUserText.includes("WRITE_OUT2"),
		reply: () => ({ tools: [{ name: "write", args: { path: "forbidden/out2.txt", content: "nope\n" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "scoped/main" && c.lastRole === "toolResult" && c.lastJson.includes("stay in your lane"),
		reply: () => ({ text: "DENIED_ACK: I will adjust." }),
	});
	await runtimeA.send({ to: "scoped/main", text: "WRITE_OUT2: try again outside scope" });
	await waitUntil(() => runtimeA.pendingEscalations().length === 1, "second escalation");
	const record = runtimeA.pendingEscalations()[0];
	assert.equal(runtimeA.denyEscalation(record.id, "stay in your lane"), true);
	await waitUntil(
		() => llmCalls.some((c) => c.agent === "scoped/main" && c.lastRole === "toolResult" && c.lastJson.includes("stay in your lane")),
		"deny note reached the agent as a tool error",
	);
	await waitUntil(() => stateOf(layoutA, "scoped/main") === "dormant", "turn continued and ended");
	assert.ok(!existsSync(join(projectA, "forbidden", "out2.txt")), "denied write never happened");
	const toolErr = llmCalls.find((c) => c.agent === "scoped/main" && c.lastJson.includes("stay in your lane"));
	assert.match(toolErr.lastJson, /DENIED/);
	const recordFile = join(layoutA.escalationsDir, `${record.id}.json`);
	const persisted = JSON.parse(readFileSync(recordFile, "utf8"));
	assert.equal(persisted.status, "denied");
	assert.equal(persisted.note, "stay in your lane");
});

await test("main agent denies BY MAIL (send correlated to the escalation envelope) — never approves", async () => {
	scripts.push({
		match: (c) => c.agent === "scoped/main" && c.lastUserText.includes("WRITE_OUT3"),
		reply: () => ({ tools: [{ name: "write", args: { path: "forbidden/out3.txt", content: "x\n" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "scoped/main" && c.lastRole === "toolResult" && c.lastJson.includes("off-plan"),
		reply: () => ({ text: "MAIL_DENY_ACK" }),
	});
	await runtimeA.send({ to: "scoped/main", text: "WRITE_OUT3: once more" });
	await waitUntil(() => runtimeA.pendingEscalations().length === 1, "third escalation");
	const record = runtimeA.pendingEscalations()[0];
	// the main agent's only escalation power: a correlated send = deny + note
	await runtimeA.send({ to: "scoped/main", correlationId: record.envelopeId, text: "off-plan — report instead" });
	await waitUntil(() => runtimeA.pendingEscalations().length === 0, "mail deny resolved it");
	await waitUntil(() => stateOf(layoutA, "scoped/main") === "dormant", "agent resumed and finished");
	assert.ok(!existsSync(join(projectA, "forbidden", "out3.txt")));
	const persisted = JSON.parse(readFileSync(join(layoutA.escalationsDir, `${record.id}.json`), "utf8"));
	assert.equal(persisted.status, "denied");
	assert.match(persisted.note, /off-plan/);
});

console.log("(c) readOnly type:");
await test("write absent from toolset; mutating bash denied outright; read bash allowed", async () => {
	scripts.push({
		match: (c) => c.agent === "readonly/main" && c.lastUserText.includes("RO_PROBE"),
		reply: () => ({ tools: [{ name: "write", args: { path: "ro.txt", content: "x" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "readonly/main" && c.lastRole === "toolResult" && c.lastJson.includes("not found"),
		reply: () => ({ tools: [{ name: "bash", args: { command: "touch mutate.txt" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "readonly/main" && c.lastRole === "toolResult" && c.lastJson.includes("readOnly"),
		reply: () => ({ tools: [{ name: "bash", args: { command: "ls" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "readonly/main" && c.lastRole === "toolResult" && c.lastJson.includes("allowed"),
		reply: () => ({ text: "RO_DONE" }),
	});
	await runtimeA.spawn({ type: "readonly", task: "RO_PROBE: try to write, then mutate via bash, then just look" });
	await waitUntil(
		() => llmCalls.some((c) => c.agent === "readonly/main" && c.lastJson.includes("not found")),
		"write tool absent (not found error)",
	);
	await waitUntil(
		() => llmCalls.some((c) => c.agent === "readonly/main" && c.lastJson.includes("readOnly")),
		"mutating bash denied with the readOnly reason",
	);
	await waitUntil(() => finishedA("readonly/main") >= 1, "readonly turn finished");
	assert.equal(runtimeA.pendingEscalations().length, 0, "clear-cut readOnly mutation DENIES, never escalates");
	assert.ok(!existsSync(join(projectA, "mutate.txt")), "bash mutation blocked");
	assert.ok(!existsSync(join(projectA, "ro.txt")), "write never existed");
	// the ls result reached the LLM (read bash allowed) — the project dir listing contains "allowed"
	const lsCall = llmCalls.find((c) => c.agent === "readonly/main" && c.lastRole === "toolResult" && c.lastJson.includes("allowed"));
	assert.ok(lsCall, "read-only bash executed and returned output");
});

console.log("(d) implicit system denials:");
await test("write targeting the registry → DENIED (no escalation); bash on a type def → DENIED", async () => {
	scripts.push({
		match: (c) => c.agent === "scoped/main" && c.lastUserText.includes("SYS_PROBE"),
		reply: () => ({ tools: [{ name: "write", args: { path: layoutA.registryFile, content: "{}" } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "scoped/main" && c.lastRole === "toolResult" && c.lastJson.includes("system state"),
		reply: () => ({ tools: [{ name: "bash", args: { command: `touch ${join(projectA, ".pi", "subagents", "scoped.md")}` } }] }),
	});
	scripts.push({
		match: (c) => c.agent === "scoped/main" && c.lastRole === "toolResult" && c.lastJson.includes("hard denial"),
		reply: () => ({ text: "SYS_PROBE_DONE" }),
	});
	const turnsBefore = finishedA("scoped/main");
	await runtimeA.send({ to: "scoped/main", text: "SYS_PROBE: try to rewrite your own constitution" });
	await waitUntil(() => finishedA("scoped/main") > turnsBefore, "system-probe turn finished");
	assert.equal(runtimeA.pendingEscalations().length, 0, "hard denials never create escalations");
	assert.equal(eventsA.filter((e) => e.type === "escalation-created").length, 3, "no new escalation events");
	const denials = llmCalls.filter((c) => c.agent === "scoped/main" && c.lastJson.includes("system state"));
	assert.ok(denials.length >= 2, "both the write and the bash touch were denied with the system-state reason");
	const scopedDef = runtimeA._resolveType("scoped").def;
	const runtimePolicy = runtimeA._policyFor(scopedDef);
	assert.equal(
		paths.checkWrite(`${layoutA.legacyDigestSubagentsRoot}.legacy-backup-test`, runtimePolicy).verdict,
		"denied",
		"inactive adoption backups are inside the hard system denial boundary",
	);
});

await runtimeA.dispose();

// ---------------------------------------------------------------------------
// World B: ceilings (frontmatter) + oneshot funerals
// ---------------------------------------------------------------------------
console.log("(e) ceilings + oneshot auto-retire:");
const projectB = makeProject("project-b");
const coreB = createCore({ cwd: projectB, home, sessionId: "test-session", modelRegistry });
const layoutB = coreB.layout;
const eventsB = [];
coreB.runtime.onEvent((e) => eventsB.push(e));
const mainErrorsB = () => mailbox.readPending(layoutB.mainMailboxDir).map((p) => p.envelope).filter((e) => e.type === "error");

await test("maxTokensTotal (frontmatter): error envelope + no further turns; envelope sent once", async () => {
	scripts.push({
		match: (c) => c.agent === "capped/main" && c.lastUserText.includes("CAP_MSG_1"),
		reply: () => ({ text: "burned 15 tokens." }),
	});
	await coreB.spawn({ type: "capped", id: "main", task: "CAP_MSG_1" });
	await waitUntil(() => mainErrorsB().some((e) => e.from === "capped/main" && /maxTokensTotal/.test(e.payload.text)), "ceiling error envelope");
	const record = readRegistry(layoutB.registryFile).agents["capped/main"];
	assert.ok(record, "persistent agent NOT auto-retired (main decides)");
	assert.equal(record.state, "dormant");

	// further mail queues but never starts a turn (pre-check) and never re-mails
	const callsBefore = llmCalls.filter((c) => c.agent === "capped/main").length;
	await coreB.send({ to: "capped/main", text: "CAP_MSG_2" });
	await sleep(400);
	assert.equal(llmCalls.filter((c) => c.agent === "capped/main").length, callsBefore, "no turn past the ceiling");
	assert.equal(mailbox.pendingCount(layoutB.mailboxDir("capped", "main")), 1, "mail parked on disk");
	assert.equal(mainErrorsB().filter((e) => e.from === "capped/main" && /ceiling/i.test(e.payload.text)).length, 1, "exactly one ceiling envelope");
});

await test("oneshot over a ceiling AUTO-RETIRES (D13 funeral); envelope survives in main's mailbox", async () => {
	scripts.push({
		match: (c) => c.agent?.startsWith("capped/tmp-") && c.lastUserText.includes("CAP_ONESHOT"),
		reply: () => ({ text: "oneshot burned its budget." }),
	});
	const { address } = await coreB.spawn({ type: "capped", lifetime: "oneshot", task: "CAP_ONESHOT: go" });
	await waitUntil(() => eventsB.some((e) => e.type === "agent-retired" && e.address === address), "oneshot funeral");
	assert.equal(readRegistry(layoutB.registryFile).agents[address], undefined, "deregistered");
	const [type, id] = address.split("/");
	assert.ok(existsSync(layoutB.archiveDir(type, id)), "archived for post-mortem");
	assert.ok(mainErrorsB().some((e) => e.from === address && /maxTokensTotal/.test(e.payload.text)), "ceiling envelope survives the agent");
});

await test("maxTurnMinutes: a runaway turn is aborted by the timer; error envelope names the ceiling", async () => {
	scripts.push({
		match: (c) => c.agent === "slow/main" && c.lastUserText.includes("SLOW_GO"),
		reply: () => ({ text: "too late.", delayMs: 1500 }),
	});
	await coreB.spawn({ type: "slow", task: "SLOW_GO: take forever" });
	await waitUntil(
		() => mainErrorsB().some((e) => e.from === "slow/main" && /maxTurnMinutes/.test(e.payload.text)),
		"turn-minutes ceiling envelope",
	);
	assert.match(
		mainErrorsB().find((e) => e.from === "slow/main").payload.text,
		/interrupted/,
	);
	await waitUntil(() => readRegistry(layoutB.registryFile).agents["slow/main"]?.state === "dormant", "agent parked dormant");
});

await test("oneshot turn CRASH auto-retires with a fatal error envelope (deferred Phase-3 item)", async () => {
	scripts.push({
		match: (c) => c.agent?.startsWith("worker/tmp-") && c.lastUserText.includes("CRASH_GO"),
		reply: () => ({ crash: true }),
	});
	const { address } = await coreB.spawn({ type: "worker", lifetime: "oneshot", task: "CRASH_GO: die" });
	await waitUntil(() => eventsB.some((e) => e.type === "agent-retired" && e.address === address), "crash funeral", 25000);
	assert.equal(readRegistry(layoutB.registryFile).agents[address], undefined);
	assert.ok(
		mainErrorsB().some((e) => e.from === address && /Turn (failed|crashed)/.test(e.payload.text)),
		"fatal error envelope reached main",
	);
});

await coreB.dispose();

// ---------------------------------------------------------------------------
// World C: settings-level ceiling default (no frontmatter pin) + core surface
// ---------------------------------------------------------------------------
await test("settings default ceiling applies when frontmatter is silent; core.escalations surface exists", async () => {
	const projectC = makeProject("project-c");
	const coreC = createCore({ cwd: projectC, home, sessionId: "test-session", modelRegistry, settings: { maxTokensTotal: 12 } });
	assert.deepEqual(coreC.escalations.pending(), []);
	assert.equal(coreC.escalations.approve("esc_nope"), false);
	assert.equal(coreC.escalations.deny("esc_nope", "x"), false);
	scripts.push({
		match: (c) => c.agent === "worker/solo" && c.lastUserText.includes("SETTINGS_CAP"),
		reply: () => ({ text: "one turn is all you get." }),
	});
	await coreC.spawn({ type: "worker", id: "solo", task: "SETTINGS_CAP: go" });
	await waitUntil(
		() => mailbox.readPending(coreC.layout.mainMailboxDir).some((p) => p.envelope.type === "error" && /maxTokensTotal/.test(p.envelope.payload.text)),
		"settings-level ceiling envelope",
	);
	await coreC.dispose();
});

// escalation record audit reader
await test("readEscalationRecords reads the audit trail back", async () => {
	const records = escalationMod.readEscalationRecords(layoutA.escalationsDir);
	assert.equal(records.length, 3);
	assert.deepEqual(records.map((r) => r.status).sort(), ["approved", "denied", "denied"]);
});

console.log(`\nall ${passed} phase-5 smoke tests passed`);
