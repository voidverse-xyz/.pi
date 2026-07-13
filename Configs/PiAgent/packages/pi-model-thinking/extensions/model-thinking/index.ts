import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "model-thinking";

function publishStatus(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const model = ctx.model?.id ?? "no-model";
	ctx.ui.setStatus(STATUS_KEY, `${model} · ${pi.getThinkingLevel()}`);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") publishStatus(pi, ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (ctx.mode === "tui") publishStatus(pi, ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		if (ctx.mode === "tui") publishStatus(pi, ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
