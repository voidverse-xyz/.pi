/** Offline test driver, never a production slash alias or consent bypass.
 * Fixtures may supply a callback that emits a genuine registered owner input event;
 * without it, proposals remain pending exactly as they do in production. */
export async function mainAgentAction(tools, ctx, text, update = () => {}, ownerInput) {
	const [action = "view", ...parts] = text.trim().split(/\s+/);
	const rest = text.trimStart().replace(/^\S+\s*/, "");
	let name = "swarm_control"; let args = { action };
	if (action === "start") { name = "swarm_start"; args = { objective: rest }; }
	else if (action === "status") { name = "swarm_status"; args = {}; }
	else if (!action || action === "dashboard") args = { action: "view" };
	else if (action === "restore" || action === "reconcile") args = { action, ...(parts[0] ? { runId: parts[0] } : {}) };
	const invoke = async arguments_ => {
		const result = await tools.get(name).execute("main-agent-fixture", arguments_, undefined, update, ctx);
		if (result.isError) throw new Error(result.details.error);
		return result.details;
	};
	const proposed = await invoke(args);
	if (!proposed.awaitingConfirmation || !ownerInput) return proposed;
	await ownerInput(proposed);
	return invoke({ ...(name === "swarm_control" ? { action } : {}), proposalId: proposed.proposalId });
}
