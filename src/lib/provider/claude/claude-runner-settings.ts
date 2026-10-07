import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
	ResolvedSettings,
	resolveSettings,
	Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_DISPLAYABLE_SETTINGS_KEYS } from "../../contracts/claude-settings.js";
import { ClaudeRuntimeError } from "../event-sink-errors.js";
import { inheritedSettingsFingerprint } from "./claude-warmed-query.js";
import type { Options } from "./types.js";

/** Raw tiers and launch flags together retain the SDK's original merge inputs. */
export interface ClaudeRunnerFileSettings {
	readonly resolved: ResolvedSettings;
	readonly fingerprint?: string;
	readonly replayable: boolean;
}

const replayKeys = new Set<string>([
	...CLAUDE_DISPLAYABLE_SETTINGS_KEYS,
	"showThinkingSummaries",
	"hooks",
]);

function directories(options: Options): string[] {
	const result: string[] = [];
	for (
		let directory = resolve(options.cwd ?? process.cwd());
		;
		directory = dirname(directory)
	) {
		result.push(directory);
		if (directory === dirname(directory)) return result;
	}
}

function configDirectory(options: Options): string {
	return resolve(
		options.cwd ?? process.cwd(),
		options.env?.["CLAUDE_CONFIG_DIR"] ??
			join(options.env?.["HOME"] ?? homedir(), ".claude"),
	);
}

export function claudeRunnerFileSettingsFingerprint(
	options: Options,
): string | undefined {
	try {
		if (
			options.env?.["CLAUDE_CODE_USE_COWORK_PLUGINS"] ||
			process.env["CLAUDE_CODE_USE_COWORK_PLUGINS"]
		)
			return;
		const native = inheritedSettingsFingerprint(options);
		if (native === undefined) return;
		const files = [
			join(configDirectory(options), "settings.json"),
			...directories(options).flatMap((directory) => [
				join(directory, ".claude/settings.json"),
				join(directory, ".claude/settings.local.json"),
			]),
		];
		return `${native}\n${files
			.map((path) => {
				const metadata = statSync(path, { throwIfNoEntry: false });
				if (!metadata) return `${path}:missing`;
				if (!metadata.isFile() || metadata.size > 1_048_576)
					throw new ClaudeRuntimeError({
						message: "Unsupported Claude settings file",
					});
				const bytes = readFileSync(path);
				JSON.parse(bytes.toString("utf8"));
				return `${path}:${createHash("sha256").update(bytes).digest("hex")}`;
			})
			.join("\n")}`;
	} catch {
		return;
	}
}

function hasOnceHook(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(hasOnceHook);
	return Object.entries(value).some(
		([key, child]) => (key === "once" && child === true) || hasOnceHook(child),
	);
}

function replayable(resolved: ResolvedSettings, options: Options): boolean {
	if (
		resolved.sources.some(({ source }) => source === "managed") ||
		Object.keys(resolved.effective).some((key) => !replayKeys.has(key)) ||
		typeof options.settings === "string" ||
		Object.keys(options.settings ?? {}).some((key) => !replayKeys.has(key)) ||
		hasOnceHook(resolved.effective.hooks) ||
		hasOnceHook(
			typeof options.settings === "object" ? options.settings.hooks : undefined,
		) ||
		options.projectConfigRoot ||
		options.additionalDirectories?.length
	)
		return false;
	try {
		// [] also gates filesystem discovery. Never remove an existing asset,
		// or guess the canonical settings root of a repository/worktree.
		const roots = directories(options);
		const paths = roots.flatMap((directory) =>
			[
				".git",
				"CLAUDE.md",
				"CLAUDE.local.md",
				"AGENTS.md",
				".mcp.json",
				".claude/CLAUDE.md",
				".claude/rules",
				".claude/skills",
				".claude/commands",
				".claude/agents",
				".claude/plugins",
				".claude/output-styles",
				".claude/workflows",
				".claude/routines",
			].map((asset) => join(directory, asset)),
		);
		paths.push(
			join(configDirectory(options), ".config.json"),
			...[
				"CLAUDE.md",
				"rules",
				"skills",
				"commands",
				"agents",
				"plugins",
				"output-styles",
				"workflows",
				"routines",
				".claude.json",
				".mcp.json",
			].map((asset) => join(configDirectory(options), asset)),
		);
		// User/local MCP servers live in the global config, which [] also
		// disables. The default root and OAuth-suffixed files differ from
		// the explicit CLAUDE_CONFIG_DIR root used for ordinary settings.
		const globalRoot = resolve(
			options.cwd ?? process.cwd(),
			options.env?.["CLAUDE_CONFIG_DIR"] || options.env?.["HOME"] || homedir(),
		);
		if (
			statSync(globalRoot, { throwIfNoEntry: false }) &&
			readdirSync(globalRoot).some(
				(name) => name.startsWith(".claude") && name.endsWith(".json"),
			)
		)
			return false;
		const projects = join(configDirectory(options), "projects");
		if (statSync(projects, { throwIfNoEntry: false })) {
			const sessions = readdirSync(projects, { withFileTypes: true });
			if (
				sessions.length > 512 ||
				sessions.some(
					(entry) =>
						entry.isSymbolicLink() ||
						(entry.isDirectory() &&
							statSync(join(projects, entry.name, "memory"), {
								throwIfNoEntry: false,
							}) !== undefined),
				)
			)
				return false;
		}
		if (
			paths.some(
				(path) => statSync(path, { throwIfNoEntry: false }) !== undefined,
			)
		)
			return false;
		// Instructions can also be loaded lazily from descendant directories.
		// Bound the inspection; an unknown or symlinked tree cannot prove absence.
		const pending = [roots[0] ?? process.cwd()];
		let remaining = 512;
		while (pending.length) {
			const directory = pending.pop();
			if (!directory || lstatSync(directory).isSymbolicLink()) return false;
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (
					--remaining < 0 ||
					entry.isSymbolicLink() ||
					["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".mcp.json"].includes(
						entry.name,
					)
				)
					return false;
				if (
					directory.endsWith("/.claude") &&
					!["settings.json", "settings.local.json"].includes(entry.name)
				)
					return false;
				if (entry.isDirectory()) pending.push(join(directory, entry.name));
			}
		}
		return true;
	} catch {
		return false;
	}
}

export async function captureClaudeRunnerFileSettings(
	options: Options,
	resolver: typeof resolveSettings,
): Promise<ClaudeRunnerFileSettings> {
	const before = claudeRunnerFileSettingsFingerprint(options);
	const resolved = await resolver({
		cwd: options.cwd ?? process.cwd(),
		settingSources: options.settingSources ?? ["user", "project", "local"],
	});
	const after = claudeRunnerFileSettingsFingerprint(options);
	return {
		resolved,
		...(before !== undefined && before === after ? { fingerprint: after } : {}),
		replayable:
			before !== undefined && before === after && replayable(resolved, options),
	};
}

/** SDK merge rules for the allowlisted ordinary fields: objects merge, arrays
 * union with duplicate entries removed. Special/trust-sensitive keys never enter. */
function mergeReplaySettings(base: Settings, flags: Settings): Settings {
	const result: Settings = { ...base };
	for (const [key, value] of Object.entries(flags)) {
		const previous = result[key];
		if (Array.isArray(previous) && Array.isArray(value)) {
			result[key] = Array.from(new Set([...previous, ...value]));
		} else if (
			previous &&
			value &&
			typeof previous === "object" &&
			typeof value === "object" &&
			!Array.isArray(previous) &&
			!Array.isArray(value)
		) {
			result[key] = mergeReplaySettings(
				previous as Settings,
				value as Settings,
			);
		} else result[key] = value;
	}
	return result;
}

export async function replayClaudeRunnerFileSettings(
	fileSettings: ClaudeRunnerFileSettings | undefined,
	options: Options,
	resolver: typeof resolveSettings,
	candidate: boolean,
): Promise<Pick<Options, "settings" | "settingSources">> {
	if (!fileSettings?.fingerprint)
		throw new ClaudeRuntimeError({
			message:
				"Original Claude file settings could not be captured; retaining the old runner",
		});
	// A later query generation can already carry the complete replay in its
	// flag settings. Re-merging inherited hook arrays would duplicate them.
	if (options.settingSources?.length === 0)
		return {
			...(options.settings !== undefined ? { settings: options.settings } : {}),
			settingSources: [],
		};
	const current = await captureClaudeRunnerFileSettings(options, resolver);
	const unchanged =
		current.fingerprint === fileSettings.fingerprint &&
		isDeepStrictEqual(current.resolved, fileSettings.resolved);
	const canReplay = fileSettings.replayable && current.replayable;
	// Once switched there is no old runner to retain, so read changed files
	// natively, like a runner that was never upgraded.
	if (unchanged || (!canReplay && !candidate))
		return {
			...(options.settings !== undefined ? { settings: options.settings } : {}),
			...(options.settingSources
				? { settingSources: options.settingSources }
				: {}),
		};
	if (!canReplay)
		throw new ClaudeRuntimeError({
			message:
				"Changed Claude settings cannot be replayed without changing trust tiers or filesystem discovery; retaining the old runner",
		});
	return {
		settingSources: [],
		settings: mergeReplaySettings(
			fileSettings.resolved.effective,
			typeof options.settings === "object" ? options.settings : {},
		),
	};
}
