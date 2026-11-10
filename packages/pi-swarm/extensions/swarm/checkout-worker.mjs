import { inspectCheckoutSync } from "./host-approval.mjs";
import { WorkspaceFiles } from "./workspace-files.mjs";
import { parentPort, workerData } from "node:worker_threads";

try {
	const result = workerData.submodulePath !== undefined
		? new WorkspaceFiles(workerData.workspace).submoduleRoot(workerData.submodulePath)
		: inspectCheckoutSync(workerData.workspace, workerData);
	parentPort.postMessage({ result });
} catch (error) {
	parentPort.postMessage({ error: { code: error.code, message: error.message } });
}
