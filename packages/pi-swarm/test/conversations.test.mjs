import test from "node:test";
import assert from "node:assert/strict";
import { machine } from "./helpers.mjs";
import { pendingMail } from "../extensions/swarm/session-state.mjs";
import { conversationText, topicsFor, messageText } from "../extensions/swarm/conversations.mjs";

test("message views retain conversation text and exclude coding tools, reasoning and context", () => {
	const text = conversationText([
		{ message: { role: "user", content: "INTERNAL_WAKE_CONTEXT" } },
		{ message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }, { type: "toolCall", name: "bash", arguments: { command: "PRIVATE_COMMAND" } }, { type: "text", text: "Here is my finding" }] } },
		{ message: { role: "toolResult", content: [{ type: "text", text: "PRIVATE_OUTPUT" }] } },
	]);
	assert.equal(text, "Here is my finding");
	const messages = [{ id: "a", from: "owner", to: "worker", text: "Please investigate", topic: "Auth" }, { id: "b", from: "worker", to: "board", text: "Finding", topic: "Auth" }];
	assert.match(messageText(messages), /Main agent → worker.*Auth/);
	assert.deepEqual(topicsFor({ messages }), [{ name: "Auth", messages: 2, participants: ["Main agent", "worker"] }]);
});

test("topic board messages replay alongside legacy mail and reach all peers except the sender", () => {
	const m = machine(); m.start(); m.worker("a"); m.worker("b");
	m.send("owner", "message.send", { to: "a", text: "Legacy message" });
	m.send("a", "message.send", { to: "board", text: "Shared finding", topic: " Auth " });
	assert.equal(m.state.messages.at(-1).topic, "Auth");
	const state = { ...m.state, sessions: { workers: [{ workerId: "a", delivered: [] }, { workerId: "b", delivered: [] }], turns: [] } };
	assert.ok(pendingMail(state, "b").some(message => message.text === "Shared finding"));
	assert.ok(!pendingMail(state, "a").some(message => message.text === "Shared finding"));
	assert.throws(() => m.send("a", "message.send", { to: "board", text: "Missing topic" }), { code: "INPUT" });
	assert.throws(() => m.send("a", "message.send", { to: "board", text: "Blank topic", topic: " " }), { code: "INPUT" });
});


test("named main and board workers remain peers while @ role recipients stay explicit", () => {
	const m = machine(); m.start(); m.worker("sender"); m.worker("main"); m.worker("board");
	m.send("sender", "message.send", { to: "board", text: "Only this peer", topic: "task" });
	m.send("sender", "message.send", { to: "main", text: "Named main peer" });
	m.send("sender", "message.send", { to: "@main", text: "Coordinator" });
	m.send("sender", "message.send", { to: "@board", text: "Whole team", topic: "task" });
	assert.deepEqual(m.state.messages.map(message => message.to), ["board", "main", "owner", "@board"]);
	const state = { ...m.state, sessions: { workers: [{ workerId: "main", delivered: [] }], turns: [] } };
	assert.deepEqual(pendingMail(state, "main").map(message => message.text), ["Named main peer", "Whole team"]);
});
