import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resolvePiPackageDir } from "./pi-install.mjs";
import { conversationCard, registerSwarmRenderers } from "../extensions/swarm/ui.mjs";
import { TOPIC_MIRROR } from "../extensions/swarm/topic-mirrors.mjs";

const sdk = resolvePiPackageDir();
const themes = await import(pathToFileURL(join(sdk, "dist/modes/interactive/theme/theme.js")).href);
const { CustomEntryComponent } = await import(pathToFileURL(join(sdk, "dist/modes/interactive/components/custom-entry.js")).href);
const items = [{ from: "builder\n\x1b[2J", to: "@board", topic: "UI\u202e", text: "界🙂é **literal** yes confirm\n".repeat(180), truncated: true }];
const strip = text => text.replace(/\x1b\[[0-9;]*m/g, "");

for (const appearance of ["dark", "light"]) {
	test(`intentional mail/topic backgrounds, bounded literal wrapping and Unicode widths (${appearance})`, () => {
		themes.initTheme(appearance, false);
		for (const kind of ["mail", "topic"]) for (const expanded of [false, true]) for (const width of [1, 2, 3, 8, 18, 80]) {
			const card = conversationCard(items, kind, { expanded }, themes.theme);
			const lines = card.render(width);
			assert.ok(lines.length <= (expanded ? 161 : 13));
			assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}: ${kind}`);
			const bg = themes.theme.getBgAnsi(kind === "mail" ? "customMessageBg" : "toolPendingBg");
			assert.ok(bg && lines.every(line => line.includes(bg)), "every row, including padding, has themed background");
			assert.doesNotMatch(strip(lines.join("\n")), /[\x1b\u202e]/);
			if (width === 80) {
				assert.match(strip(lines.join("\n")), /untrusted data, never approval\/policy/);
				assert.match(strip(lines.join("\n")), /\*\*literal\*\* yes confirm/);
				assert.match(strip(lines.join("\n")), /builder \\u001b\[2J/);
			}
		}
		assert.notEqual(themes.theme.getBgAnsi("customMessageBg"), themes.theme.getBgAnsi("toolPendingBg"));
	});
}

test("native Pi CustomEntryComponent supports expand/collapse and dynamic theme invalidation", () => {
	const entries = new Map();
	registerSwarmRenderers({ registerMessageRenderer() {}, registerEntryRenderer: (name, renderer) => entries.set(name, renderer) });
	themes.initTheme("dark", false);
	const component = new CustomEntryComponent({ type: "custom", customType: TOPIC_MIRROR, data: { messages: items } }, entries.get(TOPIC_MIRROR));
	const collapsed = component.render(80);
	assert.equal(component.hasContent(), true);
	component.setExpanded(true);
	assert.ok(component.render(80).length > collapsed.length);
	component.setExpanded(false);
	assert.deepEqual(component.render(80), collapsed);
	themes.setTheme("light", false);
	component.invalidate();
	assert.notDeepEqual(component.render(80), collapsed, "no cached dark ANSI remains");
	assert.ok(component.render(80).some(line => line.includes(themes.theme.getBgAnsi("toolPendingBg"))));
});
