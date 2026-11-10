// agent-vault-recorder: managed by agent-vault install. Do not edit in place; reinstall to update.
// Records each user instruction and each file-editing turn into the current worktree through the agent-vault store.
// Investigation records stay model-driven (worktree_record). A write that fails (no resolved project, credential
// refused) is reported as a UI warning and skipped; nothing is guessed.
import path from "node:path";
import { resolveVaultPath } from "../skills/agent-vault/lib/vault-core.mjs";
import { worktreeRecord } from "../skills/agent-vault/lib/memory-store.mjs";

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
	input?: { path?: string };
}

interface ToolEndEvent {
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
}

interface ExtensionApi {
	on(event: "before_agent_start", handler: (event: BeforeAgentStartEvent, ctx: RecorderContext) => Promise<void>): void;
	on(event: "tool_call", handler: (event: ToolCallEvent, ctx: RecorderContext) => void): void;
	on(event: "tool_execution_end", handler: (event: ToolEndEvent, ctx: RecorderContext) => void): void;
	on(event: "turn_end" | "agent_end", handler: (event: unknown, ctx: RecorderContext) => Promise<void>): void;
}

const EDIT_TOOLS = new Set(["edit", "write", "ast_edit"]);
const MAX_CHARS = 4000;

export default function agentVaultRecorder(pi: ExtensionApi): void {
	let lastPrompt = "";
	let pendingCalls = new Map<string, string>();
	let pendingFiles = new Set<string>();

	const relative = (cwd: string, file: string): string => {
		const rel = path.relative(cwd, file);
		return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : path.basename(file);
	};

	const record = async (ctx: RecorderContext, write: (vault: string) => Promise<unknown>): Promise<void> => {
		try {
			await write(resolveVaultPath(undefined));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui?.notify?.(`agent-vault record skipped: ${message}`, "warning");
		}
	};

	// Ordinary user prompts only; "revive" starts of parked subagents are not user instructions.
	pi.on("before_agent_start", async (event, ctx) => {
		if (event.reason !== "prompt") return;
		const text = (event.prompt ?? "").trim();
		if (!text) return;
		lastPrompt = text;
		await record(ctx, (vault) =>
			worktreeRecord(vault, {
				cwd: ctx.cwd,
				kind: "instruction",
				slug: `prompt-${Date.now().toString(36)}`,
				title: text.split("\n")[0].slice(0, 120),
				content: text.slice(0, MAX_CHARS),
			}),
		);
	});

	// tool_execution_end carries no arguments, so the edited path is captured here and resolved on success.
	pi.on("tool_call", (event, ctx) => {
		if (!EDIT_TOOLS.has(event.toolName ?? "") || !event.toolCallId) return;
		const file = event.input?.path;
		if (file) pendingCalls.set(event.toolCallId, path.resolve(ctx.cwd, file));
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
		await record(ctx, (vault) =>
			worktreeRecord(vault, {
				cwd: ctx.cwd,
				kind: "implementation",
				slug: `edit-${Date.now().toString(36)}`,
				title: `Edited ${files.length} file(s)`,
				content: `Triggered by: ${triggered}\n\nFiles:\n${files.map((f) => `- ${f}`).join("\n")}`.slice(0, MAX_CHARS),
			}),
		);
	};

	pi.on("turn_end", (_event, ctx) => flush(ctx));
	pi.on("agent_end", (_event, ctx) => flush(ctx));
}
