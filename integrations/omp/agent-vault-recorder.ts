// agent-vault-recorder: managed by agent-vault install. Do not edit in place; reinstall to update.
// Records each user instruction and each file-editing turn into the current worktree through the agent-vault store.
// Investigation records stay model-driven (worktree_record). Registration follows the OMP harness's configured join mode.
// A write that still fails (no resolved project, credential refused) is reported as a UI warning and skipped; nothing is guessed.
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { resolveVaultPath } from "../skills/agent-vault/lib/vault-core.mjs";
import { guardToolCall } from "../skills/agent-vault/lib/access-guard.mjs";

interface RecorderContext {
	cwd: string;
	ui?: { notify?: (message: string, level: string) => void };
}

interface BeforeAgentStartEvent {
	reason?: string;
	prompt?: string;
}

interface ToolCallEvent {
	toolName?: string;
	toolCallId?: string;
	input?: unknown;
}

interface ToolEndEvent {
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
}

interface AgentEndEvent {
	willContinue?: boolean;
	messages?: { role?: string; stopReason?: string }[];
}

interface ExtensionApi {
	on(event: "before_agent_start", handler: (event: BeforeAgentStartEvent, ctx: RecorderContext) => Promise<void>): void;
	on(event: "tool_call", handler: (event: ToolCallEvent, ctx: RecorderContext) => { block: boolean; reason: string } | void): void;
	on(event: "tool_execution_end", handler: (event: ToolEndEvent, ctx: RecorderContext) => void): void;
	on(event: "turn_end", handler: (event: unknown, ctx: RecorderContext) => Promise<void>): void;
	on(event: "agent_end", handler: (event: AgentEndEvent, ctx: RecorderContext) => Promise<void>): void;
}

const EDIT_TOOLS = new Set(["edit", "write", "ast_edit"]);
const MAX_CHARS = 4000;

const workerPath = fileURLToPath(new URL("../skills/agent-vault/bin/vault-recorder.mjs", import.meta.url));

async function runWorker(request: Record<string, unknown>): Promise<{ warnings: string[]; started?: boolean }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ warnings: string[]; started?: boolean }>();
	const child = execFile("node", [workerPath], { timeout: 60_000, maxBuffer: 64_000 }, (error, stdout) => {
		try {
			const result = JSON.parse(stdout);
			if (error || !result.ok) reject(new Error(result.message ?? "Agent Vault Node worker failed."));
			else resolve(result);
		} catch {
			reject(new Error(error?.message ?? "Agent Vault Node worker returned invalid JSON."));
		}
	});
	child.stdin?.on("error", reject);
	child.stdin?.end(JSON.stringify(request));
	return promise;
}

export default function agentVaultRecorder(pi: ExtensionApi): void {
	let lastPrompt = "";
	let pendingCalls = new Map<string, string>();
	let pendingFiles = new Set<string>();
	let activeTask: { taskId: string; vault: string; cwd: string } | undefined;

	const relative = (cwd: string, file: string): string => {
		const rel = path.relative(cwd, file);
		return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : path.basename(file);
	};

	const record = async (ctx: RecorderContext, entry: Record<string, unknown>): Promise<void> => {
		try {
			const vault = resolveVaultPath(undefined);
			const taskId = activeTask?.vault === vault && activeTask.cwd === ctx.cwd ? activeTask.taskId : undefined;
			const result = await runWorker({ operation: "record", vault, cwd: ctx.cwd, record: entry, taskId });
			for (const warning of result.warnings) ctx.ui?.notify?.(`agent-vault: ${warning}`, "warning");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui?.notify?.(`agent-vault record skipped: ${message}`, "warning");
		}
	};

	const endTask = async (ctx: RecorderContext, completed: boolean, task = activeTask): Promise<void> => {
		if (!task || activeTask !== task) return;
		try {
			const result = await runWorker({ operation: "task-end", ...task, completed });
			for (const warning of result.warnings) ctx.ui?.notify?.(`agent-vault: ${warning}`, "warning");
			if (activeTask === task) activeTask = undefined;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui?.notify?.(`agent-vault task completion skipped: ${message}`, "warning");
		}
	};

	// Ordinary user prompts only; "revive" starts of parked subagents are not user instructions.
	pi.on("before_agent_start", async (event, ctx) => {
		if (event.reason !== "prompt") return;
		if (activeTask && (activeTask.cwd !== ctx.cwd || activeTask.vault !== resolveVaultPath(undefined))) await endTask(ctx, false);
		if (!activeTask) {
			const task = { taskId: randomUUID(), vault: resolveVaultPath(undefined), cwd: ctx.cwd };
			try {
				const result = await runWorker({ operation: "task-start", ...task });
				if (result.started) activeTask = task;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui?.notify?.(`agent-vault task start skipped: ${message}`, "warning");
			}
		}
		const text = (event.prompt ?? "").trim();
		if (!text) return;
		lastPrompt = text;
		await record(ctx, {
			kind: "instruction",
			slug: `prompt-${Date.now().toString(36)}`,
			title: text.split("\n")[0].slice(0, 120),
			content: text.slice(0, MAX_CHARS),
		});
	});

	// tool_execution_end carries no arguments, so the edited path is captured here and resolved on success.
	pi.on("tool_call", (event, ctx) => {
		const blocked = guardToolCall(resolveVaultPath(undefined), event, { cwd: ctx.cwd });
		if (blocked) return blocked;
		if (!EDIT_TOOLS.has(event.toolName ?? "") || !event.toolCallId) return;
		const file = (event.input as { path?: string } | undefined)?.path;
		if (typeof file === "string") pendingCalls.set(event.toolCallId, path.resolve(ctx.cwd, file));
	});

	pi.on("tool_execution_end", (event) => {
		const file = event.toolCallId ? pendingCalls.get(event.toolCallId) : undefined;
		if (event.toolCallId) pendingCalls.delete(event.toolCallId);
		if (file && !event.isError) pendingFiles.add(file);
	});

	const flush = async (ctx: RecorderContext): Promise<void> => {
		if (pendingFiles.size === 0) return;
		const files = [...pendingFiles].map((file) => relative(ctx.cwd, file)).sort();
		pendingFiles = new Set();
		const triggered = lastPrompt.split("\n")[0].slice(0, 200) || "(no prompt recorded)";
		await record(ctx, {
			kind: "implementation",
			slug: `edit-${Date.now().toString(36)}`,
			title: `Edited ${files.length} file(s)`,
			content: `Triggered by: ${triggered}\n\nFiles:\n${files.map((f) => `- ${f}`).join("\n")}`.slice(0, MAX_CHARS),
		});
	};

	pi.on("turn_end", (_event, ctx) => flush(ctx));
	pi.on("agent_end", async (event, ctx) => {
		const task = activeTask;
		if (!task || event.willContinue) return;
		await flush(ctx);
		const messages = event.messages ?? [];
		const lastUser = messages.findLastIndex((message) => message.role === "user");
		const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
		const finalAssistant = lastAssistant > lastUser ? messages[lastAssistant] : undefined;
		await endTask(ctx, finalAssistant?.stopReason === "stop", task);
	});
}
