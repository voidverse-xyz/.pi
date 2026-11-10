/** Protocol roles cannot collide with worker IDs. Friendly aliases preserve existing peers. */
export function recipientId(to, workers = []) {
	if (to === "@main") return "owner";
	if (to === "@board") return "@board";
	if (!workers.some(worker => worker.id === to)) {
		if (to === "main") return "owner";
		if (to === "board") return "@board";
	}
	return to;
}

export function isBoardMessage(message, workers = []) {
	return message.to === "@board" || message.to === "board" && message.topic !== undefined && !workers.some(worker => worker.id === "board");
}
