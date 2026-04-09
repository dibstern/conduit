// test/unit/provider/claude/claude-adapter-discover.test.ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../../../src/lib/provider/claude/claude-adapter.js";

describe("ClaudeAdapter.discover()", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = join(tmpdir(), `conduit-claude-test-${Date.now()}`);
		mkdirSync(join(workspace, ".claude", "commands"), { recursive: true });
		mkdirSync(join(workspace, ".claude", "skills", "my-skill"), {
			recursive: true,
		});
		writeFileSync(
			join(workspace, ".claude", "commands", "my-cmd.md"),
			"---\ndescription: A custom command\n---\nDo the thing.",
		);
		writeFileSync(
			join(workspace, ".claude", "skills", "my-skill", "SKILL.md"),
			"---\nname: my-skill\ndescription: A custom skill\n---\nUse when...",
		);
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it("returns providerId 'claude'", () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		expect(adapter.providerId).toBe("claude");
	});

	it("returns capabilities with models, tools, thinking, permissions, questions", async () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await adapter.discover();

		expect(caps.models.length).toBeGreaterThan(0);
		expect(caps.models.every((m) => m.providerId === "claude")).toBe(true);
		// Spot-check that at least one Sonnet variant is present.
		expect(caps.models.some((m) => m.id.toLowerCase().includes("sonnet"))).toBe(
			true,
		);

		expect(caps.supportsTools).toBe(true);
		expect(caps.supportsThinking).toBe(true);
		expect(caps.supportsPermissions).toBe(true);
		expect(caps.supportsQuestions).toBe(true);
		expect(caps.supportsAttachments).toBe(true);
		expect(caps.supportsFork).toBe(false);
		expect(caps.supportsRevert).toBe(false);
	});

	it("enumerates built-in commands", async () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await adapter.discover();
		const builtins = caps.commands.filter((c) => c.source === "builtin");
		expect(builtins.length).toBeGreaterThan(0);
		expect(builtins.some((c) => c.name === "init")).toBe(true);
		expect(builtins.some((c) => c.name === "compact")).toBe(true);
		expect(builtins.some((c) => c.name === "cost")).toBe(true);
	});

	it("enumerates project commands from .claude/commands", async () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await adapter.discover();
		const projectCmds = caps.commands.filter(
			(c) => c.source === "project-command",
		);
		expect(projectCmds).toHaveLength(1);
		expect(projectCmds[0]?.name).toBe("my-cmd");
		expect(projectCmds[0]?.description).toBe("A custom command");
	});

	it("enumerates project skills from .claude/skills", async () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await adapter.discover();
		const projectSkills = caps.commands.filter(
			(c) => c.source === "project-skill",
		);
		expect(projectSkills).toHaveLength(1);
		expect(projectSkills[0]?.name).toBe("my-skill");
		expect(projectSkills[0]?.description).toBe("A custom skill");
	});

	it("handles missing .claude directories gracefully", async () => {
		const emptyWorkspace = join(tmpdir(), `conduit-claude-empty-${Date.now()}`);
		mkdirSync(emptyWorkspace, { recursive: true });
		try {
			const adapter = new ClaudeAdapter({ workspaceRoot: emptyWorkspace });
			const caps = await adapter.discover();
			// Should still have builtins
			expect(caps.commands.some((c) => c.source === "builtin")).toBe(true);
			// No project commands or skills
			expect(
				caps.commands.filter((c) => c.source === "project-command"),
			).toHaveLength(0);
			expect(
				caps.commands.filter((c) => c.source === "project-skill"),
			).toHaveLength(0);
		} finally {
			rmSync(emptyWorkspace, { recursive: true, force: true });
		}
	});
});
