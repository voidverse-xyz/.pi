import assert from "node:assert/strict";
import test from "node:test";
import {
	activateChoiceRow,
	createInputState,
	somethingElseRow,
} from "./input-state.ts";
import type { Input } from "./schema.ts";

function choiceInput(type: "radio" | "multi"): Input {
	return {
		type,
		title: "Choose",
		options: [{ title: "First" }, { title: "Second" }],
		fileKind: "any",
	};
}

test("Something else always opens the custom editor and preserves prior text", () => {
	const input = choiceInput("radio");
	const state = createInputState(input);
	state.customValue = "previous custom answer";
	state.customSelected = true;

	state.cursor = 0;
	assert.equal(activateChoiceRow(input, state), "selection-changed");
	assert.deepEqual([...state.selected], [0]);
	assert.equal(state.customSelected, false);
	assert.equal(state.customValue, "previous custom answer");

	state.cursor = somethingElseRow(input);
	assert.equal(activateChoiceRow(input, state), "edit-custom");
	assert.equal(state.customSelected, true);
	assert.deepEqual([...state.selected], []);
	assert.equal(state.customValue, "previous custom answer");

	assert.equal(activateChoiceRow(input, state), "edit-custom");
	assert.equal(state.customSelected, true);
	assert.equal(state.customValue, "previous custom answer");
});

test("Something else opens the custom editor before any text exists", () => {
	const input = choiceInput("multi");
	const state = createInputState(input);
	state.cursor = somethingElseRow(input);

	assert.equal(activateChoiceRow(input, state), "edit-custom");
	assert.equal(state.customSelected, true);
	assert.equal(state.customValue, "");
});

test("ordinary multi-choice rows keep their toggle behavior", () => {
	const input = choiceInput("multi");
	const state = createInputState(input);
	state.cursor = 1;

	assert.equal(activateChoiceRow(input, state), "selection-changed");
	assert.deepEqual([...state.selected], [1]);
	assert.equal(activateChoiceRow(input, state), "selection-changed");
	assert.deepEqual([...state.selected], []);
});
