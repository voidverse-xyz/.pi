import type { AgentSession, ReadonlySessionManager, SessionManager } from "@earendil-works/pi-coding-agent";

export type ContextMode = "auto" | "focus" | "fork";
export interface WorkerContext {
	version: number;
	requested: ContextMode;
	mode: "focus" | "fork";
	percent: number | null;
	parentSessionId: string | null;
	parentLeafId: string | null;
	messages: ReturnType<ReadonlySessionManager["buildSessionProjection"]>["messages"];
	digest: string;
}
export function captureWorkerContext(ctx: { sessionManager?: ReadonlySessionManager; getContextUsage?: () => { percent: number | null } | undefined }, requested?: ContextMode, retainHistory?: boolean): WorkerContext;
export function contextSummary(seed?: WorkerContext): Partial<Omit<WorkerContext, "messages">> & { mode: "focus" | "fork"; requested: ContextMode; messageCount: number };
export function validateWorkerContext(seed: WorkerContext): WorkerContext;
export function selectWorkerContext(seed: WorkerContext, mode?: "focus" | "fork"): WorkerContext;
export function seedWorkerSession(manager: SessionManager, seed?: WorkerContext): void;
export function assertWorkerContextReady(manager: SessionManager): void;

export function workerSessionStats(session: AgentSession): ReturnType<AgentSession["getSessionStats"]>;

export function workerContextInstructions(manager: SessionManager): string[];
