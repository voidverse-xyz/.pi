export function defineTool(definition) {
	return definition;
}

export async function withFileMutationQueue(_path, operation) {
	return operation();
}
