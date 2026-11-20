// agent-vault-update: managed by agent-vault install. Do not edit in place; reinstall to update.
// Adds /agent-vault-update to the OMP prompt: check, confirm, then run the installed `vault-cli update` for exactly the plan that was shown.
// It changes nothing without your confirmation, never edits your instruction files, and downloads only what `vault-cli update` itself downloads.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

interface CommandContext {
	hasUI?: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		confirm(title: string, message: string): Promise<boolean>;
	};
}

interface ExtensionApi {
	registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: CommandContext) => Promise<void> }): void;
}

interface UpdatePlan {
	id: string;
	current: boolean;
	source: { version: string; origin?: string };
	targets: { id: string; action: string; version?: string | null; changed?: number; added?: number }[];
	instructions: { path: string; count: number }[];
}

interface UpdateResult {
	plan: UpdatePlan;
	applied: { id: string | null; verified?: { version: string; tools: number } | null } | null;
	notes: string[];
}

// The bundle OMP launches, next to the extensions folder: the same layout the recorder relies on.
const cli = fileURLToPath(new URL("../skills/agent-vault/bin/vault-cli.mjs", import.meta.url));

function runUpdate(args: string[]): Promise<{ ok: boolean; result?: UpdateResult; message: string }> {
	const { promise, resolve } = Promise.withResolvers<{ ok: boolean; result?: UpdateResult; message: string }>();
	execFile("node", [cli, "update", ...args, "--json"], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
		if (!error) {
			try {
				resolve({ ok: true, result: JSON.parse(stdout) as UpdateResult, message: "" });
				return;
			} catch {
				resolve({ ok: false, message: "vault-cli update returned output that is not JSON." });
				return;
			}
		}
		const text = `${stderr}`.trim() || `${stdout}`.trim() || error.message;
		resolve({ ok: false, message: text.replace(/^\[FAIL\]\s*/, "").slice(0, 1500) });
	});
	return promise;
}

const describe = (plan: UpdatePlan): string => {
	const lines = [`Version ${plan.targets.find((target) => target.action === "update")?.version ?? "?"} -> ${plan.source.version}${plan.source.origin ? ` (${plan.source.origin})` : ""}`];
	for (const target of plan.targets.filter((entry) => entry.action === "update")) lines.push(`  ${target.id}: ${target.changed ?? 0} changed, ${target.added ?? 0} new files`);
	return lines.join("\n");
};

export default function agentVaultUpdate(pi: ExtensionApi): void {
	pi.registerCommand("agent-vault-update", {
		description: "Check for a newer Agent Vault, show what would change, and install it after you confirm (/agent-vault-update check only previews)",
		handler: async (args, ctx) => {
			const mode = args.trim();
			if (mode !== "" && mode !== "check") {
				ctx.ui.notify("Usage: /agent-vault-update [check]", "warning");
				return;
			}
			ctx.ui.notify("Agent Vault: checking for an update…", "info");
			const preview = await runUpdate(["--dry-run"]);
			if (!preview.ok || !preview.result) {
				ctx.ui.notify(`Agent Vault update check failed: ${preview.message}`, "error");
				return;
			}
			const plan = preview.result.plan;
			if (plan.current) {
				ctx.ui.notify(`Agent Vault is up to date (version ${plan.source.version}).`, "info");
				return;
			}
			const stale = plan.instructions.length
				? `These files still name tools the new build removed and are not edited by the update: ${plan.instructions.map((file) => `${file.path} (${file.count})`).join(", ")}. Fix them before you restart OMP.`
				: undefined;
			if (mode === "check") {
				ctx.ui.notify(`${describe(plan)}\nRun /agent-vault-update to install it.${stale ? `\n${stale}` : ""}`, stale ? "warning" : "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`${describe(plan)}\nNo interactive UI to confirm with, so nothing was installed. Run 'agent-vault update' in a terminal.`, "warning");
				return;
			}
			const accepted = await ctx.ui.confirm("Update Agent Vault?", `${describe(plan)}${stale ? `\n\n${stale}` : ""}\n\nA backup is made first and the old build is restored if the new server does not start.`);
			if (!accepted) {
				ctx.ui.notify("Agent Vault update cancelled. Nothing was changed.", "info");
				return;
			}
			const applied = await runUpdate(["--expect", plan.id]);
			if (!applied.ok || !applied.result?.applied?.id) {
				ctx.ui.notify(`Agent Vault update failed: ${applied.ok ? "nothing was installed" : applied.message}`, "error");
				return;
			}
			const done = applied.result.applied;
			ctx.ui.notify(`Agent Vault updated to ${plan.source.version}${done.verified ? ` (new server answered with ${done.verified.tools} tools)` : ""}. Backup ${done.id}; undo with 'agent-vault update --rollback ${done.id}'. Restart OMP to load the new server.`, "info");
			if (stale) ctx.ui.notify(stale, "warning");
		},
	});
}
