// test/unit/provider/claude/claude-adapter-discover.test.ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../../../../src/lib/provider/claude/claude-adapter.js";
import {
	__setProbeOverrideForTesting,
	resetCapabilityCacheForTesting,
} from "../../../../src/lib/provider/claude/claude-capabilities-probe.js";

describe("ClaudeAdapter.discoverEffect()", () => {
	let workspace: string;

	beforeEach(() => {
		resetCapabilityCacheForTesting();
		__setProbeOverrideForTesting(async () => ({
			models: [
				{
					id: "claude-sonnet-4-7",
					name: "Claude Sonnet 4.7",
					providerId: "claude",
					limit: { context: 200_000, output: 64_000 },
				},
			],
			commands: [],
			agents: [],
		}));
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
		__setProbeOverrideForTesting(undefined);
		resetCapabilityCacheForTesting();
		rmSync(workspace, { recursive: true, force: true });
	});

	it("returns providerId 'claude'", () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		expect(adapter.providerId).toBe("claude");
	});

	it("returns capabilities with models, tools, thinking, permissions, questions", async () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await Effect.runPromise(adapter.discoverEffect());

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
		const caps = await Effect.runPromise(adapter.discoverEffect());
		const builtins = caps.commands.filter((c) => c.source === "builtin");
		expect(builtins.length).toBeGreaterThan(0);
		expect(builtins.some((c) => c.name === "init")).toBe(true);
		expect(builtins.some((c) => c.name === "compact")).toBe(true);
		expect(builtins.some((c) => c.name === "cost")).toBe(true);
	});

	it("enumerates project commands from .claude/commands", async () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await Effect.runPromise(adapter.discoverEffect());
		const projectCmds = caps.commands.filter(
			(c) => c.source === "project-command",
		);
		expect(projectCmds).toHaveLength(1);
		expect(projectCmds[0]?.name).toBe("my-cmd");
		expect(projectCmds[0]?.description).toBe("A custom command");
	});

	it("enumerates project skills from .claude/skills", async () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await Effect.runPromise(adapter.discoverEffect());
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
			const caps = await Effect.runPromise(adapter.discoverEffect());
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

	describe("with capability probe", () => {
		it("returns models from the probe when available", async () => {
			__setProbeOverrideForTesting(async () => ({
				models: [
					{
						id: "claude-opus-4-7",
						name: "Claude Opus 4.7",
						providerId: "claude",
						limit: { context: 200_000, output: 32_000 },
					},
				],
				commands: [],
				agents: [],
			}));

			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const caps = await Effect.runPromise(adapter.discoverEffect());
			expect(caps.models).toHaveLength(1);
			expect(caps.models[0]?.id).toBe("claude-opus-4-7");
		});

		it("falls back to a minimal model list when the probe fails", async () => {
			__setProbeOverrideForTesting(async () => {
				throw new Error("claude binary not found");
			});

			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const caps = await Effect.runPromise(adapter.discoverEffect());
			expect(caps.models.length).toBeGreaterThan(0);
			expect(caps.models.every((m) => m.providerId === "claude")).toBe(true);
		});

		it("returns the same probe result across two adapter instances", async () => {
			const probe = vi.fn().mockResolvedValue({
				models: [
					{
						id: "claude-sonnet-4-7",
						name: "Sonnet 4.7",
						providerId: "claude" as const,
					},
				],
				commands: [],
				agents: [],
			});
			__setProbeOverrideForTesting(probe);

			const a1 = new ClaudeAdapter({ workspaceRoot: workspace });
			const a2 = new ClaudeAdapter({ workspaceRoot: workspace });
			await Effect.runPromise(a1.discoverEffect());
			await Effect.runPromise(a2.discoverEffect());
			expect(probe).toHaveBeenCalledTimes(1);
		});

		it("returns SDK agents from Claude discover", async () => {
			__setProbeOverrideForTesting(async () => ({
				models: [],
				commands: [],
				agents: [
					{ id: "Explore", name: "Explore", description: "Codebase explorer" },
				],
			}));

			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const caps = await Effect.runPromise(adapter.discoverEffect());
			expect(caps.agents).toEqual([
				{ id: "Explore", name: "Explore", description: "Codebase explorer" },
			]);
		});

		it("unions SDK-sourced commands with filesystem commands, deduping by name", async () => {
			__setProbeOverrideForTesting(async () => ({
				models: [],
				agents: [],
				commands: [
					{ name: "init", description: "SDK init", source: "claude-sdk" },
					{
						name: "new-command",
						description: "from SDK",
						source: "claude-sdk",
					},
				],
			}));

			const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
			const caps = await Effect.runPromise(adapter.discoverEffect());
			const names = caps.commands.map((c) => c.name);
			expect(names).toContain("new-command");
			expect(names.filter((name) => name === "init")).toHaveLength(1);
			expect(caps.commands.find((c) => c.name === "init")?.source).toBe(
				"builtin",
			);
		});
	});
});
