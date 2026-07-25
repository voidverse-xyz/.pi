import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

export default function introspectMcpTools(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const path = process.env.PI_MCP_INTROSPECT_FILE;
		if (!path) return;
		writeFileSync(path, JSON.stringify({
			all: pi.getAllTools().map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
			active: pi.getActiveTools(),
			commands: pi.getCommands().map((command) => command.name),
		}, null, 2));
	});
}
