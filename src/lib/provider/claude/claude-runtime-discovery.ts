import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createLogger } from "../../logger.js";
import {
	type ClaudeAdapterError,
	ClaudeRuntimeError,
} from "../event-sink-errors.js";
import type { CommandInfo, ModelInfo, ProviderCapabilities } from "../types.js";
import { expectedClaudeReportedModelId } from "./claude-api-model-id.js";
import type { ProbeResult } from "./claude-capabilities-probe.js";
import type { ClaudeCapabilitiesService } from "./claude-capabilities-service.js";
import type { ClaudeSessionContext } from "./types.js";

const log = createLogger("claude-provider-runtime");
const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
	{ name: "init", description: "Initialize Claude in the current workspace" },
	{ name: "memory", description: "Manage Claude's memory / CLAUDE.md" },
	{ name: "compact", description: "Compact the conversation to free context" },
	{ name: "cost", description: "Show token usage and cost for the session" },
	{ name: "model", description: "Switch the active model" },
	{ name: "clear", description: "Clear the conversation" },
	{ name: "help", description: "Show help" },
];

// Used only when the SDK capability probe fails or returns no models.
const FALLBACK_MODELS: ReadonlyArray<ModelInfo> = [
	{
		id: "opus",
		name: "Claude Opus (latest)",
		providerId: "claude",
		limit: { context: 200_000, output: 32_000 },
	},
	{
		id: "sonnet",
		name: "Claude Sonnet (latest)",
		providerId: "claude",
		limit: { context: 200_000, output: 64_000 },
	},
	{
		id: "haiku",
		name: "Claude Haiku (latest)",
		providerId: "claude",
		limit: { context: 200_000, output: 8_192 },
	},
];

// Frontmatter parser (minimal)

function parseFrontmatter(contents: string): Record<string, string> {
	if (!contents.startsWith("---\n")) return {};
	const end = contents.indexOf("\n---", 4);
	if (end === -1) return {};
	const block = contents.slice(4, end);
	const out: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (key) out[key] = value;
	}
	return out;
}

function safeReaddir(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

function enumerateCommands(
	baseDir: string,
	source: "user-command" | "project-command",
): CommandInfo[] {
	const dir = join(baseDir, "commands");
	const out: CommandInfo[] = [];
	for (const entry of safeReaddir(dir)) {
		if (!entry.endsWith(".md")) continue;
		const name = entry.slice(0, -3);
		try {
			const contents = readFileSync(join(dir, entry), "utf8");
			const fm = parseFrontmatter(contents);
			const desc = fm["description"];
			out.push({
				name,
				source,
				...(desc ? { description: desc } : {}),
			});
		} catch {
			out.push({ name, source });
		}
	}
	return out;
}

function enumerateSkills(
	baseDir: string,
	source: "user-skill" | "project-skill",
): CommandInfo[] {
	const dir = join(baseDir, "skills");
	const out: CommandInfo[] = [];
	for (const entry of safeReaddir(dir)) {
		const skillPath = join(dir, entry);
		try {
			if (!statSync(skillPath).isDirectory()) continue;
		} catch {
			continue;
		}
		const skillFile = join(skillPath, "SKILL.md");
		try {
			const contents = readFileSync(skillFile, "utf8");
			const fm = parseFrontmatter(contents);
			const skillName = fm["name"] ?? entry;
			const skillDesc = fm["description"];
			out.push({
				name: skillName,
				source,
				...(skillDesc ? { description: skillDesc } : {}),
			});
		} catch {
			// Skip skills without a SKILL.md.
		}
	}
	return out;
}

export function discoverCapabilitiesEffect(
	workspaceRoot: string,
	capabilitiesService: ClaudeCapabilitiesService | undefined,
): Effect.Effect<ProviderCapabilities> {
	return Effect.gen(function* () {
		const userBase = join(homedir(), ".claude");
		const projectBase = join(workspaceRoot, ".claude");

		const fsCommands: CommandInfo[] = [
			...BUILTIN_COMMANDS.map((c) => ({
				name: c.name,
				description: c.description,
				source: "builtin" as const,
			})),
			...enumerateCommands(userBase, "user-command"),
			...enumerateCommands(projectBase, "project-command"),
			...enumerateSkills(userBase, "user-skill"),
			...enumerateSkills(projectBase, "project-skill"),
		];

		const probe = yield* getCapabilitiesProbeEffect(
			capabilitiesService,
			workspaceRoot,
		).pipe(
			Effect.catchAll((err) =>
				Effect.sync(() => {
					log.warn(
						`Capability probe failed; using fallback model list: ${err instanceof Error ? err.message : err}`,
					);
					return {
						models: FALLBACK_MODELS,
						commands: [],
						agents: [],
					} satisfies ProbeResult;
				}),
			),
		);
		const seen = new Set(fsCommands.map((command) => command.name));
		const commands = [
			...fsCommands,
			...probe.commands.filter((command) => !seen.has(command.name)),
		];

		return {
			models: probe.models.length > 0 ? probe.models : FALLBACK_MODELS,
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: true,
			supportsQuestions: true,
			supportsAttachments: true,
			supportsFork: true,
			supportsRevert: false,
			commands,
			agents: probe.agents,
		};
	});
}

function getCapabilitiesProbeEffect(
	service: ClaudeCapabilitiesService | undefined,
	workspaceRoot: string,
): Effect.Effect<ProbeResult, ClaudeAdapterError> {
	return service
		? service.get(workspaceRoot)
		: Effect.fail(
				new ClaudeRuntimeError({
					message: "Claude capabilities service unavailable",
				}),
			);
}

export function setExpectedApiModelId(
	ctx: ClaudeSessionContext,
	expected: string | undefined,
): void {
	if (expected === undefined) {
		delete ctx.expectedApiModelId;
	} else {
		ctx.expectedApiModelId = expected;
	}
}

export function expectedApiModelIdEffect(
	capabilitiesService: ClaudeCapabilitiesService | undefined,
	requestedModelId: string | undefined,
	contextWindow: string | undefined,
	workspaceRoot: string,
	agent: string | undefined,
): Effect.Effect<string | undefined> {
	if (agent !== undefined) return Effect.succeed(undefined);
	if (!capabilitiesService) return Effect.succeed(undefined);
	return capabilitiesService.get(workspaceRoot).pipe(
		Effect.map((probe) =>
			expectedClaudeReportedModelId(
				requestedModelId,
				contextWindow,
				probe.models,
			),
		),
		Effect.catchAll(() => Effect.succeed(undefined)),
	);
}
