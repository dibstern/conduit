import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
	ResolvedSettings,
	ResolveSettingsOptions,
	SDKControlGetUsageResponse,
	SDKControlInitializeResponse,
	SessionMessage,
	Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Option, Schema } from "effect";
import { CategorySetSchema } from "../../src/lib/contracts/category-set.js";
import { CategoryTuningHunkSchema } from "../../src/lib/contracts/category-tuning.js";
import type { ClaudeOneShotQueryFactory } from "../../src/lib/provider/claude/claude-provider-runtime.js";
import type { ClaudeSubagentSdk } from "../../src/lib/provider/claude/claude-subagent-materializer.js";
import type {
	Options,
	Query,
	SDKMessage,
	SDKUserMessage,
} from "../../src/lib/provider/claude/types.js";
import type { ProjectRelayConfig } from "../../src/lib/types.js";
import {
	provisionalRejectedLimit,
	provisionalUsageLimitTurn,
} from "../fixtures/claude-sdk-traces/provisional-usage-limit-turn.js";
import {
	provisionalRejectedLimitWithoutReset,
	provisionalUsageLimitTurnWithoutReset,
} from "../fixtures/claude-sdk-traces/provisional-usage-limit-turn-no-reset.js";
import {
	LONG_COMMAND,
	LONG_QUESTION,
	LONG_RESULT,
} from "../fixtures/tool-previews.js";

type QuotaBehavior =
	| "available"
	| "limited"
	| "fail"
	| "hang"
	| "unavailable"
	| "plan-unavailable";

// Unix seconds supplied by the harness; the same marker drives intake and quota.
function injectedResetAt(configDir: string | undefined): number | undefined {
	if (!configDir) return;
	const marker = join(configDir, "conduit-test-resets-at");
	if (!existsSync(marker)) return;
	const value = Number(readFileSync(marker, "utf8").trim());
	return Number.isFinite(value) ? value : undefined;
}

export type ProcessMark =
	| {
			kind: "startup-phase";
			phase: "add-project-start" | "add-project-returned" | "ready-attempt";
			pid: number;
			at: number;
	  }
	| {
			kind: "startup-phase";
			phase: "persisted-project-check";
			pid: number;
			at: number;
			expectedFolder: string;
			folders: string[];
			matches: boolean;
	  }
	| {
			kind: "startup-phase";
			phase: "startup-timeout" | "ready-received" | "ready-after-finish";
			pid: number;
			at: number;
			elapsedMs: number;
	  }
	| {
			kind: "input-content";
			inputId: string | undefined;
			content: SDKUserMessage["message"]["content"];
	  }
	| { kind: "pre-warm-joined"; sessionId: string }
	| {
			kind: "native-fork";
			parentSessionId: string;
			sessionId: string;
			configDir: string | undefined;
			upToMessageId: string | undefined;
	  }
	| { kind: "stop-held"; queryId: string }
	| {
			kind: "task-stop";
			phase: "requested" | "confirmed" | "failed" | "already-finished";
			taskId: string;
			queryId: string;
			at: string;
	  }
	| {
			kind: "task-stop-turn";
			phase:
				| "streaming"
				| "result"
				| "after-result"
				| "interrupted-result"
				| "execution-error"
				| "late-tool";
			queryId: string;
			at: string;
			inputId?: string;
			request?: string;
	  }
	| {
			kind: "handoff-first-turn-died";
			prompt: string;
			queryId: string;
			sessionId: string;
	  }
	| {
			kind: "usage-probe";
			configDir: string | undefined;
			queryId: string;
			behavior: QuotaBehavior;
	  }
	| {
			kind: "mcp-tools";
			prompt: string;
			serverKey: string;
			serverName: string;
			toolNames: string[];
	  }
	| {
			kind: "mcp-tool-call";
			prompt: string;
			toolName: string;
			arguments: Record<string, unknown>;
			result: CallToolResult;
	  }
	| {
			kind: "usage-limit";
			phase: "limited" | "repeated";
			sessionId: string;
			prompt: string;
	  }
	| {
			kind:
				| "runner-hello-pending"
				| "runner-idle-exit-started"
				| "runner-spawned";
			pid: number;
	  }
	| { kind: "runner-end-selected"; sessionId: string }
	| { kind: "receipt"; prompt: string; at: string }
	| {
			kind: "enqueue";
			prompt: string;
			request: string;
			at: string;
			queryId: string;
			promptIndex: number;
			liveOptions: {
				model?: string;
				effort?: Options["effort"];
				permissionMode?: Options["permissionMode"];
			};
	  }
	| { kind: "emit"; prompt: string; text: string; at: string }
	| { kind: "approval"; prompt: string; behavior: "allow" | "deny" }
	| {
			kind: "prompt-answer";
			prompt: string;
			requestId: string;
			pid: number;
			response: unknown;
	  }
	| { kind: "pre-assistant-held"; prompt: string; queryId: string }
	| { kind: "assistant-held"; prompt: string; queryId: string }
	| { kind: "intake-held"; prompt: string; queryId: string; inputId: string }
	| {
			kind: "resume-rejected";
			prompt: string;
			queryId: string;
			sessionId: string;
	  }
	| {
			kind: "background-work";
			phase: "started" | "completed";
			queryId: string;
			pid: number;
			at: string;
	  }
	| {
			kind: "notification-turn";
			phase: "stream-held" | "snapshot" | "held" | "completed";
			queryId: string;
			pid: number;
			messageId: string;
			snapshotUuid?: string;
			at: string;
	  }
	| {
			kind:
				| "initialization-held"
				| "initialization-ready"
				| "initialization-failed"
				| "query-closed"
				| "query-interrupted"
				| "query-interrupt-rejected"
				| "system-init";
			queryId: string;
			at: string;
	  }
	| {
			kind: "query";
			queryId: string;
			runnerSessionId?: string;
			at: string;
			sessionId: string;
			pid: number;
			optionsJson: string;
			effectiveSettingsJson: string;
			options: {
				model?: string;
				effort?: Options["effort"];
				permissionMode?: Options["permissionMode"];
				settings?: { disableAllHooks?: boolean };
			};
			env: Readonly<Record<string, string | undefined>>;
	  }
	| {
			kind: "runner-started";
			pid: number;
			sessionId: string;
			socketPath: string;
			buildId: string;
			protocolVersion: number;
			settlesAnswers: boolean;
			declaresLogin: boolean;
			answerDialect: "legacy" | "runner";
	  }
	| {
			kind: "runner-admission";
			sessionId: string;
			command: "send-turn" | "pre-warm";
			decision: "Use" | "DeferRebind" | "Refuse" | "Retire" | "Wait" | "Skip";
	  }
	| { kind: "runner-command"; commandId: string; type: string }
	| {
			kind: "runner-upgrade";
			phase: "warming" | "cancelled" | "failed" | "switched";
			sessionId: string;
			oldPid: number;
			newPid?: number;
			at: string;
	  }
	| {
			kind: "runner-snapshot";
			pid: number;
			sessionId: string;
			snapshotJson: string;
	  }
	| { kind: "runner-snapshot-observed"; sessionId: string }
	| {
			kind: "runtime-sink";
			phase: "allocated" | "released";
			sinkId: string;
			sessionId: string;
			activeSinks: number;
	  }
	| {
			kind: "subagent-finalizer";
			phase: "started" | "completed";
			pid: number;
			parentClaudeSessionId: string;
			sdkSubagentId: string;
			at: string;
	  }
	| {
			kind: "settings-resolved";
			pid: number;
			effectiveSettingsJson: string;
	  }
	| {
			kind: "query-update";
			queryId: string;
			model?: string;
			effort?: Options["effort"];
			permissionMode?: Options["permissionMode"];
	  }
	| { kind: "runner-spawned"; pid: number; socketPath: string };

function currentRequest(prompt: string): string {
	if (prompt.startsWith("[Conduit still-open note]"))
		prompt = prompt.slice(prompt.indexOf("\n\n") + 2);
	const end = "[End conduit context handoff]\n\n";
	const boundary = prompt.indexOf(end);
	return prompt.startsWith("[Conduit context handoff]") && boundary >= 0
		? prompt.slice(boundary + end.length)
		: prompt;
}

export function responseChunks(prompt: string): string[] {
	const visiblePrompt = currentRequest(prompt);
	if (visiblePrompt === "streaming-cost")
		return Array.from({ length: 512 }, () => "0123456789abcdef01234567");
	if (visiblePrompt === "approval-account-switch-history")
		return ["OMIT-THIS-ASSISTANT-CONTEXT ".repeat(900), "\nHistory complete."];
	if (visiblePrompt.startsWith("approval-thread-read-history-"))
		return [`OMIT-${visiblePrompt} `.repeat(900), "\nHistory complete."];
	return [
		`Echo(${visiblePrompt}): `,
		`stream(${visiblePrompt}) `,
		`done(${visiblePrompt}).`,
	];
}

function mark(message: ProcessMark): void {
	const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
	if (proof) appendFileSync(proof, `${JSON.stringify(message)}\n`);
	const send = () => {
		// The runner can outlive its daemon; diagnostic IPC may close mid-send.
		if (process.connected)
			process.send?.({ channel: "conduit-process-test", ...message }, () => {});
	};
	const delay =
		message.kind === "enqueue"
			? Number(process.env["CONDUIT_TEST_ENQUEUE_MARK_DELAY_MS"] ?? 0)
			: 0;
	if (delay > 0) setTimeout(send, delay);
	else send();
}

function stream(
	sessionId: string,
	event: Record<string, unknown>,
	parentToolUseId: string | null = null,
): SDKMessage {
	return {
		type: "stream_event",
		session_id: sessionId,
		uuid: randomUUID(),
		parent_tool_use_id: parentToolUseId,
		event,
	} as unknown as SDKMessage;
}

export const taskStopFixture = [
	{
		task_id: "task-stop-shell",
		tool_use_id: "task-stop-shell-tool",
		task_type: "local_bash",
		description: "Watch the build output",
		parentToolUseId: null,
	},
	{
		task_id: "task-stop-agent",
		tool_use_id: "task-stop-agent-tool",
		task_type: "local_agent",
		description: "Review the background changes",
		parentToolUseId: null,
	},
	{
		task_id: "task-stop-nested",
		tool_use_id: "task-stop-nested-tool",
		task_type: "local_bash",
		description: "Watch the agent's test output",
		parentToolUseId: "task-stop-agent-tool",
	},
	{
		task_id: "task-stop-unrelated",
		tool_use_id: "task-stop-unrelated-tool",
		task_type: "local_bash",
		description: "Watch the unrelated deployment",
		parentToolUseId: null,
	},
] as const;

export const taskStopMonitorFixture = [
	{
		task_id: "task-stop-monitor",
		tool_use_id: "task-stop-monitor-tool",
		task_type: "monitor_mcp",
		description: "Monitor background events",
		parentToolUseId: null,
	},
] as const;

const taskStopUsage: Extract<SDKMessage, { type: "result" }>["usage"] = {
	input_tokens: 1,
	output_tokens: 2,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
	cache_creation: {
		ephemeral_1h_input_tokens: 0,
		ephemeral_5m_input_tokens: 0,
	},
	fallback_credit: null,
	inference_geo: "not_available",
	iterations: [],
	output_tokens_details: { thinking_tokens: 0 },
	server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
	service_tier: "standard",
	speed: "standard",
};

function mergeSettings(
	base: Record<string, unknown>,
	settings: Record<string, unknown>,
): Record<string, unknown> {
	const merged = { ...base };
	for (const [key, value] of Object.entries(settings)) {
		const previous = merged[key];
		merged[key] =
			previous &&
			value &&
			typeof previous === "object" &&
			typeof value === "object" &&
			!Array.isArray(previous) &&
			!Array.isArray(value)
				? mergeSettings(
						previous as Record<string, unknown>,
						value as Record<string, unknown>,
					)
				: value;
	}
	return merged;
}

function fileSettings(
	options: ResolveSettingsOptions = {},
	configDir = process.env["CLAUDE_CONFIG_DIR"],
): ResolvedSettings {
	const cwd = options.cwd ?? process.cwd();
	const paths = {
		user: configDir ? join(configDir, "settings.json") : undefined,
		project: join(cwd, ".claude/settings.json"),
		local: join(cwd, ".claude/settings.local.json"),
	};
	let effective: Record<string, unknown> = {};
	const sources: ResolvedSettings["sources"] = [];
	const provenance: Record<string, { source: string; path: string }> = {};
	for (const source of options.settingSources ?? ["user", "project", "local"]) {
		const path = paths[source];
		if (!path || !existsSync(path)) continue;
		const settings = JSON.parse(readFileSync(path, "utf8")) as Settings;
		sources.push({ source, settings, path });
		effective = mergeSettings(effective, settings);
		for (const key of Object.keys(settings)) provenance[key] = { source, path };
	}
	return {
		effective: effective as Settings,
		sources,
		provenance: provenance as ResolvedSettings["provenance"],
	};
}

export const resolveSettings: typeof import("@anthropic-ai/claude-agent-sdk").resolveSettings =
	async (options) => {
		const resolved = fileSettings(options);
		mark({
			kind: "settings-resolved",
			pid: process.pid,
			effectiveSettingsJson: JSON.stringify(resolved.effective),
		});
		return resolved;
	};

export const claudeSubagentSdk: ClaudeSubagentSdk = {
	listSubagents: async () => [],
	getSubagentMessages: async (parentClaudeSessionId, sdkSubagentId) => {
		const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
		if (!proof || sdkSubagentId !== "review-finalizer-task") return [];
		mark({
			kind: "subagent-finalizer",
			phase: "started",
			pid: process.pid,
			parentClaudeSessionId,
			sdkSubagentId,
			at: process.hrtime.bigint().toString(),
		});
		while (!existsSync(join(dirname(proof), "release-subagent-finalizer")))
			await new Promise<void>((done) => setTimeout(done, 20));
		mark({
			kind: "subagent-finalizer",
			phase: "completed",
			pid: process.pid,
			parentClaudeSessionId,
			sdkSubagentId,
			at: process.hrtime.bigint().toString(),
		});
		return [
			{
				type: "assistant",
				uuid: "review-finalizer-message",
				session_id: sdkSubagentId,
				parent_tool_use_id: "review-finalizer-tool",
				parent_agent_id: null,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "late child finalizer result" }],
				},
			},
		];
	},
};

let initializationAttempts = 0;

type NativeMessage = SessionMessage & { parentUuid?: string | null };

function readNativeTranscript(
	sessionId: string,
	configDir: string | undefined,
	directory?: string,
): NativeMessage[] {
	if (!configDir)
		throw new Error("A native transcript requires an account config dir");
	const file = join(configDir, `conduit-test-transcript-${sessionId}.ndjson`);
	if (directory && existsSync(`${file}.directory`)) {
		const recorded = readFileSync(`${file}.directory`, "utf8");
		const common = gitCommonDirectory(recorded);
		if (
			recorded !== directory &&
			(!common || gitCommonDirectory(directory) !== common)
		)
			throw new Error(`Native session ${sessionId} not found in ${directory}`);
	}
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as NativeMessage);
}

function gitCommonDirectory(directory: string): string | undefined {
	const env = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_INDEX_FILE",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
	])
		delete env[key];
	try {
		return realpathSync(
			execFileSync(
				"git",
				[
					"-C",
					directory,
					"rev-parse",
					"--path-format=absolute",
					"--git-common-dir",
				],
				{ env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			).trim(),
		);
	} catch {
		return undefined;
	}
}

function recordNativeMessage(
	entry: NativeMessage,
	configDir: string | undefined,
	directory?: string,
): void {
	recordNativeEntry(entry, entry.session_id, configDir, directory);
}

function recordNativeEntry(
	entry: object,
	sessionId: string,
	configDir: string | undefined,
	directory?: string,
): void {
	if (configDir && existsSync(join(configDir, "conduit-test-record-forks"))) {
		const file = join(configDir, `conduit-test-transcript-${sessionId}.ndjson`);
		if (directory && !existsSync(`${file}.directory`))
			writeFileSync(`${file}.directory`, directory);
		appendFileSync(file, `${JSON.stringify(entry)}\n`);
		if (directory) {
			const projectDir = join(
				configDir,
				"projects",
				realpathSync(directory).replace(/[^a-zA-Z0-9]/g, "-"),
			);
			mkdirSync(projectDir, { recursive: true });
			appendFileSync(
				join(projectDir, `${sessionId}.jsonl`),
				`${JSON.stringify({ ...entry, sessionId })}\n`,
			);
		}
	}
}

function query(params: {
	prompt: AsyncIterable<SDKUserMessage>;
	options?: Options;
}): Query {
	const zeroTurn = params.options?.maxTurns === 0;
	const sessionId = params.options?.forkSession
		? (params.options.sessionId ?? randomUUID())
		: (params.options?.resume ?? params.options?.sessionId ?? randomUUID());
	const accountConfigDir =
		params.options?.env?.["CLAUDE_CONFIG_DIR"] ??
		process.env["CLAUDE_CONFIG_DIR"];
	let nativeParentUuid: string | null = params.options?.resumeSessionAt ?? null;
	if (
		params.options?.forkSession &&
		accountConfigDir &&
		existsSync(
			join(accountConfigDir, `conduit-test-transcript-${sessionId}.ndjson`),
		)
	)
		throw new Error(`Session ID ${sessionId} is already in use`);
	if (params.options?.resumeSessionAt) {
		const transcript = readNativeTranscript(
			params.options.resume ?? sessionId,
			accountConfigDir,
		);
		if (
			!transcript.some(
				(entry) => entry.uuid === params.options?.resumeSessionAt,
			)
		)
			throw new Error("Native resume boundary was not found");
	} else if (
		params.options?.resume &&
		accountConfigDir &&
		existsSync(
			join(accountConfigDir, `conduit-test-transcript-${sessionId}.ndjson`),
		)
	) {
		nativeParentUuid =
			readNativeTranscript(sessionId, accountConfigDir).at(-1)?.uuid ?? null;
	}
	const queryId = randomUUID();
	let liveModel = params.options?.model;
	let liveEffort = params.options?.effort;
	let livePermissionMode = params.options?.permissionMode;
	// Messages the real SDK interleaves into a running turn, such as the bare
	// status it reports on a permission-mode change. Only a held turn polls,
	// so they are collected only while one is held.
	const outOfBand: SDKMessage[] = [];
	let taskStopLive: (
		| (typeof taskStopFixture)[number]
		| (typeof taskStopMonitorFixture)[number]
	)[] = [];
	const pendingTaskStops = new Set<string>();
	let turnHeld = false;
	let taskStopHolding = false;
	let taskStopHeldRequest: string | undefined;
	let taskTurnInterrupted = false;
	let interruptibleTurn = false;
	let interruptAwaitingDecision = false;
	let closed = false;
	let promptIndex = 0;
	let initializationFinished = false;
	let rejectInitialization: (error: Error) => void = () => {};
	const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
	// A successful control reply does not remove a task. The SDK confirms it
	// later, independently of the active turn, when the browser test releases it.
	const releaseTaskStops = () => {
		if (!proof) return;
		for (const taskId of pendingTaskStops) {
			if (
				!existsSync(join(dirname(proof), "task-stop-confirm-all")) &&
				!existsSync(join(dirname(proof), `task-stop-confirm-${taskId}`))
			)
				continue;
			pendingTaskStops.delete(taskId);
			const task = taskStopLive.find((entry) => entry.task_id === taskId);
			if (!task) continue;
			taskStopLive = taskStopLive.filter((entry) => entry !== task);
			outOfBand.push(
				{
					type: "system",
					subtype: "background_tasks_changed",
					session_id: sessionId,
					uuid: randomUUID(),
					tasks: taskStopLive,
				},
				{
					type: "system",
					subtype: "task_notification",
					session_id: sessionId,
					uuid: randomUUID(),
					task_id: taskId,
					tool_use_id: task.tool_use_id,
					status: "stopped",
					output_file: join(dirname(proof), `${taskId}.output`),
					summary: `${task.description} stopped`,
				},
			);
			mark({
				kind: "task-stop",
				phase: "confirmed",
				taskId,
				queryId,
				at: process.hrtime.bigint().toString(),
			});
		}
	};
	const consumeMarker = (name: string): boolean => {
		if (!proof) return false;
		try {
			unlinkSync(join(dirname(proof), name));
			return true;
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "ENOENT"
			)
				throw error;
			return false;
		}
	};
	const consumeAccountMarker = (name: string): boolean => {
		if (!accountConfigDir) return false;
		const file = join(accountConfigDir, `conduit-test-${name}`);
		if (!existsSync(file)) return false;
		unlinkSync(file);
		return true;
	};
	// Capability and quota probes must leave the next session's fixture gates alone.
	const failNext = !zeroTurn && consumeMarker("fail-next-initialization");
	const holdNext = !zeroTurn && consumeMarker("hold-next-initialization");
	const fails =
		!zeroTurn &&
		(++initializationAttempts <=
			Number(process.env["CONDUIT_TEST_QUERY_INITIALIZATION_FAILURES"] ?? 0) ||
			failNext);
	const delayMs = zeroTurn
		? 0
		: Number(process.env["CONDUIT_TEST_QUERY_INITIALIZATION_DELAY_MS"] ?? 0);
	let initializationTimer: ReturnType<typeof setTimeout> | undefined;
	const settings = params.options?.settings;
	const flagSettings =
		typeof settings === "string"
			? (JSON.parse(readFileSync(settings, "utf8")) as Settings)
			: (settings ?? {});
	const effectiveSettings = mergeSettings(
		fileSettings(
			{
				...(params.options?.cwd === undefined
					? {}
					: { cwd: params.options.cwd }),
				...(params.options?.settingSources === undefined
					? {}
					: { settingSources: params.options.settingSources }),
			},
			params.options?.env?.["CLAUDE_CONFIG_DIR"],
		).effective,
		flagSettings,
	);
	if (!zeroTurn)
		mark({
			kind: "query",
			queryId,
			...(params.options?.env?.["CONDUIT_SESSION_ID"]
				? { runnerSessionId: params.options.env["CONDUIT_SESSION_ID"] }
				: {}),
			at: process.hrtime.bigint().toString(),
			sessionId,
			pid: process.pid,
			effectiveSettingsJson: JSON.stringify(effectiveSettings),
			optionsJson: JSON.stringify(
				Object.fromEntries(
					Object.entries(params.options ?? {}).filter(
						([key]) =>
							!["abortController", "canUseTool", "resume"].includes(key),
					),
				),
				(key, value: unknown) => (key === "instance" ? undefined : value),
			),
			options: {
				...(params.options?.model ? { model: params.options.model } : {}),
				...(params.options?.effort ? { effort: params.options.effort } : {}),
				...(params.options?.permissionMode
					? { permissionMode: params.options.permissionMode }
					: {}),
				...(settings &&
				typeof settings === "object" &&
				typeof settings.disableAllHooks === "boolean"
					? { settings: { disableAllHooks: settings.disableAllHooks } }
					: {}),
			},
			env: Object.fromEntries(
				[
					"CONDUIT_ENV_PROOF",
					"PATH",
					"CLAUDE_CONFIG_DIR",
					"ANTHROPIC_API_KEY",
					"ANTHROPIC_MODEL",
					"CLAUDE_AGENT_SDK_CLIENT_APP",
					"ENABLE_CLAUDEAI_MCP_SERVERS",
				].map((key) => [key, params.options?.env?.[key]]),
			),
		});
	// Initialization starts without input. Session queries emit system/init with
	// their first prompt; zero-turn capability queries emit it without a turn.
	const initialization = new Promise<SDKControlInitializeResponse>(
		(done, fail) => {
			rejectInitialization = fail;
			if (holdNext)
				mark({
					kind: "initialization-held",
					queryId,
					at: process.hrtime.bigint().toString(),
				});
			const finish = () => {
				if (initializationFinished) return;
				if (
					holdNext &&
					proof &&
					!existsSync(join(dirname(proof), "release-held-initialization"))
				) {
					initializationTimer = setTimeout(finish, 20);
					return;
				}
				initializationFinished = true;
				if (!zeroTurn)
					mark({
						kind: fails ? "initialization-failed" : "initialization-ready",
						queryId,
						at: process.hrtime.bigint().toString(),
					});
				if (fails) fail(new Error("Synthetic Claude initialization failure"));
				else {
					// The real CLI creates the caller-chosen fork during initialize,
					// before the first prompt and the public system/init stream record.
					if (params.options?.forkSession && params.options.resume) {
						try {
							const source = readNativeTranscript(
								params.options.resume,
								accountConfigDir,
							);
							const end = params.options.resumeSessionAt
								? source.findIndex(
										(entry) => entry.uuid === params.options?.resumeSessionAt,
									)
								: source.length - 1;
							if (end < 0)
								throw new Error("Native fork boundary was not found");
							for (const entry of source.slice(0, end + 1))
								recordNativeEntry(
									{ ...entry, session_id: sessionId },
									sessionId,
									accountConfigDir,
									params.options.cwd,
								);
						} catch (error) {
							fail(error);
							return;
						}
					}
					done({
						commands: [],
						agents: [],
						models: [],
						output_style: "default",
						available_output_styles: ["default"],
						account: {
							email: "process-test@example.test",
							subscriptionType: "max",
							tokenSource: "oauth",
							apiProvider: "firstParty",
						},
					});
				}
			};
			if (delayMs > 0) initializationTimer = setTimeout(finish, delayMs);
			else finish();
		},
	);
	// A caller may attach the readiness barrier on the next tick.
	void initialization.catch(() => {});
	function* correctionForegroundTool(id: string): Generator<SDKMessage> {
		const messageId = randomUUID();
		const input = { command: `echo ${id}` };
		yield stream(sessionId, {
			type: "message_start",
			message: { id: messageId, role: "assistant", content: [] },
		});
		yield stream(sessionId, {
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id, name: "Bash", input: {} },
		});
		yield stream(sessionId, {
			type: "content_block_delta",
			index: 0,
			delta: {
				type: "input_json_delta",
				partial_json: JSON.stringify(input),
			},
		});
		yield stream(sessionId, { type: "content_block_stop", index: 0 });
		yield stream(sessionId, { type: "message_stop" });
		yield {
			type: "assistant",
			uuid: randomUUID(),
			session_id: sessionId,
			parent_tool_use_id: null,
			message: {
				id: messageId,
				type: "message",
				role: "assistant",
				model: liveModel ?? "claude-sonnet-4",
				content: [{ type: "tool_use", id, name: "Bash", input }],
				stop_reason: "tool_use",
				stop_sequence: null,
				container: null,
				context_management: null,
				diagnostics: null,
				stop_details: null,
				usage: taskStopUsage,
			},
		};
	}
	const systemInit = (): SDKMessage => {
		if (!zeroTurn)
			mark({
				kind: "system-init",
				queryId,
				at: process.hrtime.bigint().toString(),
			});
		return {
			type: "system",
			subtype: "init",
			session_id: sessionId,
			uuid: randomUUID(),
			cwd: params.options?.cwd ?? "",
			apiKeySource: "none",
			claude_code_version: "process-test",
			tools: ["Bash"],
			mcp_servers: [],
			model: params.options?.model ?? "claude-sonnet-4",
			permissionMode: params.options?.permissionMode ?? "default",
			slash_commands: [],
			output_style: "default",
			skills: [],
			plugins: [],
		} as unknown as SDKMessage;
	};
	const messages = (async function* (): AsyncGenerator<SDKMessage> {
		await initialization;
		if (zeroTurn) {
			yield systemInit();
			return;
		}
		const inputs = params.prompt[Symbol.asyncIterator]();
		while (!closed) {
			const nextInput = inputs.next();
			if (taskStopLive.length > 0) {
				let ready = false;
				void nextInput.then(
					() => {
						ready = true;
					},
					() => {
						ready = true;
					},
				);
				while (!ready && !closed) {
					releaseTaskStops();
					yield* outOfBand.splice(0);
					await new Promise<void>((done) => setTimeout(done, 20));
				}
			}
			if (closed) return;
			const next = await nextInput;
			if (next.done) return;
			const input = next.value;
			const at = process.hrtime.bigint().toString();
			if (closed) return;
			const content = input.message.content;
			if (
				Array.isArray(content) &&
				content.some((block) => block.type === "image")
			)
				mark({ kind: "input-content", inputId: input.uuid, content });
			const prompt =
				typeof content === "string"
					? content
					: content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("");
			const request = currentRequest(prompt);
			interruptibleTurn =
				request.startsWith("stall-") || request === "terminal-replay-interrupt";
			const userUuid = input.uuid ?? randomUUID();
			if (request === "fail-before-intake")
				throw new Error("Harness SDK iterator failed before intake");
			if (prompt === "/goal clear") {
				for (const hookName of ["SessionStart", "UserPromptSubmit"])
					yield {
						type: "system",
						subtype: "hook_started",
						hook_id: randomUUID(),
						hook_name: hookName,
						hook_event: hookName,
						uuid: randomUUID(),
						session_id: sessionId,
					};
				yield {
					type: "system",
					subtype: "hook_response",
					hook_id: randomUUID(),
					hook_name: "UserPromptSubmit",
					hook_event: "UserPromptSubmit",
					output: "",
					stdout: "",
					stderr: "",
					exit_code: 0,
					outcome: "success",
					uuid: randomUUID(),
					session_id: sessionId,
				};
				yield {
					type: "command_lifecycle",
					state: "queued",
					command_uuid: userUuid,
					uuid: randomUUID(),
					session_id: sessionId,
				};
			}
			const optionsFile = process.env["CONDUIT_TEST_CLAUDE_OPTIONS_FILE"];
			if (optionsFile) {
				const seen = new WeakSet<object>();
				const record = JSON.stringify(
					{
						pid: process.pid,
						prompt,
						configDir:
							params.options?.env?.["CLAUDE_CONFIG_DIR"] ??
							process.env["CLAUDE_CONFIG_DIR"] ??
							null,
						resumeId: params.options?.resume ?? null,
						options: params.options ?? {},
					},
					(key, value: unknown) => {
						if (key === "instance") return undefined;
						if (typeof value === "bigint") return value.toString();
						if (typeof value === "object" && value !== null) {
							if (seen.has(value)) return undefined;
							seen.add(value);
						}
						return value;
					},
				);
				appendFileSync(optionsFile, `${record}\n`);
			}
			mark({
				kind: "enqueue",
				prompt,
				request,
				at,
				queryId,
				promptIndex: ++promptIndex,
				liveOptions: {
					...(liveModel === undefined ? {} : { model: liveModel }),
					...(liveEffort === undefined ? {} : { effort: liveEffort }),
					...(livePermissionMode === undefined
						? {}
						: { permissionMode: livePermissionMode }),
				},
			});
			const rejectedResume = proof
				? join(dirname(proof), "rejected-resume-session-id")
				: undefined;
			if (
				params.options?.resume &&
				rejectedResume &&
				existsSync(rejectedResume) &&
				readFileSync(rejectedResume, "utf8") === params.options.resume
			) {
				mark({ kind: "resume-rejected", prompt, queryId, sessionId });
				if (
					proof &&
					existsSync(join(dirname(proof), "rejected-resume-as-result"))
				) {
					yield {
						type: "result",
						subtype: "error_during_execution",
						uuid: randomUUID(),
						session_id: sessionId,
						is_error: true,
						errors: [`No conversation found with session ID: ${sessionId}`],
						duration_ms: 0,
						duration_api_ms: 0,
						num_turns: 0,
						stop_reason: null,
						total_cost_usd: 0,
						usage: taskStopUsage,
						modelUsage: {},
						permission_denials: [],
					};
					return;
				}
				throw new Error(`No conversation found with session ID: ${sessionId}`);
			}
			if (request === "fail-before-assistant-restart") {
				const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
				if (!proof) throw new Error("Missing pre-assistant failure gate");
				mark({ kind: "pre-assistant-held", prompt, queryId });
				const release = join(dirname(proof), "release-before-assistant");
				while (!existsSync(release))
					await new Promise<void>((done) => setTimeout(done, 20));
				throw new Error("Harness failure before assistant message");
			}
			if (promptIndex === 1) {
				yield systemInit();
			}
			if (params.options?.resume && consumeAccountMarker("resume-drops-turn")) {
				yield {
					type: "result",
					subtype: "error_during_execution",
					uuid: randomUUID(),
					session_id: sessionId,
					is_error: true,
					errors: [
						"Resume rejected by --resume-drops-turn: discarded range contains an unseen notification",
					],
					duration_ms: 0,
					duration_api_ms: 0,
					num_turns: 0,
					stop_reason: null,
					total_cost_usd: 0,
					usage: taskStopUsage,
					modelUsage: {},
					permission_denials: [],
				};
				continue;
			}
			if (request === "approval-rebind-1" && proof) {
				const messageId = readFileSync(
					join(
						dirname(proof),
						`rebind-first-${params.options?.env?.["CONDUIT_SESSION_ID"]}`,
					),
					"utf8",
				);
				// An old message can be replayed by a newly opened account query.
				// Its ownership still belongs to the run that created that message.
				yield stream(sessionId, {
					type: "message_start",
					message: { id: messageId, role: "assistant", content: [] },
				});
				yield stream(sessionId, {
					type: "content_block_start",
					index: 9,
					content_block: { type: "text", text: "late-from-account-A" },
				});
				yield stream(sessionId, { type: "content_block_stop", index: 9 });
			}
			// Native resume validation precedes intake, as it does in the CLI.
			if (
				(request === "load-stream-stop-before-intake" ||
					request === "relay-replacement-before-intake") &&
				proof
			) {
				mark({ kind: "intake-held", prompt, queryId, inputId: userUuid });
				while (
					!existsSync(join(dirname(proof), "release-stop-intake")) &&
					!closed
				)
					await new Promise<void>((done) => setTimeout(done, 20));
				if (closed) return;
			}
			yield {
				type: "command_lifecycle",
				state: "started",
				command_uuid: userUuid,
				uuid: randomUUID(),
				session_id: sessionId,
			};
			if (prompt !== "/goal clear") {
				recordNativeMessage(
					{
						type: "user",
						uuid: userUuid,
						parentUuid: nativeParentUuid,
						session_id: sessionId,
						message: { ...input.message, id: userUuid },
						parent_tool_use_id: null,
						parent_agent_id: null,
					},
					accountConfigDir,
					params.options?.cwd,
				);
				nativeParentUuid = userUuid;
			}
			if (
				params.options?.forkSession &&
				consumeAccountMarker("crash-after-init")
			)
				throw new Error("Synthetic crash immediately after system/init");
			if (prompt === "/goal clear") {
				const unknown = consumeAccountMarker("unknown-goal");
				const modelReply = consumeAccountMarker("model-goal-reply");
				const text = unknown
					? "Unknown command: goal"
					: modelReply
						? "I cleared your goal."
						: "Goal cleared: Finish the Source task";
				const uuid = randomUUID();
				if (!unknown && !modelReply) {
					recordNativeEntry(
						{
							type: "attachment",
							uuid: randomUUID(),
							parentUuid: nativeParentUuid,
							attachment: {
								type: "goal_status",
								met: true,
								sentinel: true,
								condition: "Finish the Source task",
							},
						},
						sessionId,
						accountConfigDir,
						params.options?.cwd,
					);
				}
				// The spike records the completed goal status before the command
				// user/local-command pair. A crash at init must leave no clear fact.
				recordNativeMessage(
					{
						type: "user",
						uuid: userUuid,
						parentUuid: nativeParentUuid,
						session_id: sessionId,
						isSidechain: false,
						message: {
							role: "user",
							content:
								"<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>clear</command-args>",
						},
						parent_tool_use_id: null,
						parent_agent_id: null,
					} as NativeMessage,
					accountConfigDir,
					params.options?.cwd,
				);
				nativeParentUuid = userUuid;
				if (!unknown && !modelReply) {
					recordNativeEntry(
						{
							type: "system",
							subtype: "local_command",
							uuid,
							parentUuid: nativeParentUuid,
							isSidechain: false,
							isMeta: false,
							content: `<local-command-stdout>${text}</local-command-stdout>`,
							commandRun: { command: "goal", args: "clear" },
						},
						sessionId,
						accountConfigDir,
						params.options?.cwd,
					);
					nativeParentUuid = uuid;
				}
				yield {
					type: "assistant",
					uuid,
					session_id: sessionId,
					parent_tool_use_id: null,
					message: {
						id: randomUUID(),
						role: "assistant",
						model: modelReply ? "claude-sonnet-4" : "<synthetic>",
						content: [{ type: "text", text }],
					},
					...(!unknown && !modelReply
						? {
								local_command_run: { command: "goal", args: "clear" },
								local_command_source: `<local-command-stdout>${text}</local-command-stdout>`,
							}
						: {}),
				} as unknown as SDKMessage;
				yield {
					type: "result",
					subtype: "success",
					uuid: randomUUID(),
					session_id: sessionId,
					is_error: false,
					duration_ms: 0,
					duration_api_ms: 0,
					num_turns: modelReply ? 1 : 0,
					result: text,
					stop_reason: "end_turn",
					total_cost_usd: 0,
					usage: taskStopUsage,
					modelUsage: {},
					permission_denials: [],
					...(!unknown && !modelReply ? { local_command: "goal" } : {}),
				} as unknown as SDKMessage;
				continue;
			}
			if (request === "fork-source-active-goal") {
				recordNativeEntry(
					{
						type: "attachment",
						uuid: randomUUID(),
						parentUuid: nativeParentUuid,
						attachment: {
							type: "goal_status",
							met: false,
							sentinel: true,
							condition: "Finish the Source task",
						},
					},
					sessionId,
					accountConfigDir,
					params.options?.cwd,
				);
				yield {
					type: "active_goal",
					uuid: randomUUID(),
					session_id: sessionId,
					value: {
						condition: "Finish the Source task",
						iterations: 0,
						set_at: Date.now(),
						tokens_at_start: 0,
					},
				};
			}
			if (request === "thread-read-omitted-history") {
				const [{ Client }, { InMemoryTransport }, { CallToolResultSchema }] =
					await Promise.all([
						import("@modelcontextprotocol/sdk/client/index.js"),
						import("@modelcontextprotocol/sdk/inMemory.js"),
						import("@modelcontextprotocol/sdk/types.js"),
					]);
				const serverKey = "conduit";
				const server = params.options?.mcpServers?.[serverKey];
				if (server?.type !== "sdk")
					throw new Error("The thread reader MCP server was not registered");
				const client = new Client({
					name: "fake-claude-sdk",
					version: "1.0.0",
				});
				const [clientTransport, serverTransport] =
					InMemoryTransport.createLinkedPair();
				await server.instance.connect(serverTransport);
				try {
					await client.connect(clientTransport);
					const { tools } = await client.listTools();
					mark({
						kind: "mcp-tools",
						prompt,
						serverKey,
						serverName: server.name,
						toolNames: tools.map(({ name }) => `mcp__${serverKey}__${name}`),
					});
					const tool = tools.find(({ name }) => name === "conduit_thread_read");
					if (!tool)
						throw new Error("The thread reader MCP tool was not listed");
					let args: { cursor?: string; textOffset?: number; limit: number } = {
						limit: 1,
					};
					let reachedEnd = false;
					for (let index = 0; index < 32; index++) {
						const result = CallToolResultSchema.parse(
							await client.callTool({ name: tool.name, arguments: args }),
						);
						mark({
							kind: "mcp-tool-call",
							prompt,
							toolName: `mcp__${serverKey}__${tool.name}`,
							arguments: args,
							result,
						});
						const page: unknown = JSON.parse(
							result.content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join(""),
						);
						if (
							!page ||
							typeof page !== "object" ||
							!("items" in page) ||
							!Array.isArray(page.items)
						)
							throw new Error(
								"The thread reader returned an invalid history page",
							);
						if (
							!("nextCursor" in page) ||
							typeof page.nextCursor !== "string"
						) {
							reachedEnd = true;
							break;
						}
						args = {
							cursor: page.nextCursor,
							...("nextTextOffset" in page &&
							typeof page.nextTextOffset === "number"
								? { textOffset: page.nextTextOffset }
								: {}),
							limit: 1,
						};
					}
					if (!reachedEnd)
						throw new Error("The thread reader did not finish paging");
					const invalid = { cursor: "invalid-thread-cursor", limit: 1 };
					const result = CallToolResultSchema.parse(
						await client.callTool({ name: tool.name, arguments: invalid }),
					);
					mark({
						kind: "mcp-tool-call",
						prompt,
						toolName: `mcp__${serverKey}__${tool.name}`,
						arguments: invalid,
						result,
					});
				} finally {
					await client.close();
				}
			}
			const switchMarker = accountConfigDir
				? join(accountConfigDir, "conduit-test-switch-turn")
				: undefined;
			const switchTurn =
				prompt.includes("[Conduit context handoff]") &&
				switchMarker &&
				existsSync(switchMarker)
					? readFileSync(switchMarker, "utf8").trim()
					: undefined;
			if (switchTurn === "die-once" && switchMarker) {
				writeFileSync(switchMarker, "hold");
				mark({ kind: "handoff-first-turn-died", prompt, queryId, sessionId });
				process.exit(86);
			}
			if (switchTurn === "hold" && proof) {
				mark({ kind: "pre-assistant-held", prompt, queryId });
				while (
					!existsSync(join(dirname(proof), "release-switch-turn")) &&
					!closed
				)
					await new Promise<void>((done) => setTimeout(done, 20));
				if (closed) return;
			}
			if (switchTurn === "limited") {
				yield provisionalRejectedLimitWithoutReset(sessionId);
				yield* provisionalUsageLimitTurnWithoutReset(
					sessionId,
					input,
				).events.filter((event) => event.type === "result");
				mark({ kind: "usage-limit", phase: "limited", sessionId, prompt });
				continue;
			}
			if (request === "usage-limit-before-first-receipt") {
				yield provisionalRejectedLimitWithoutReset(sessionId);
				mark({ kind: "usage-limit", phase: "limited", sessionId, prompt });
				throw new Error(
					"Synthetic SDK exit after the limit before its receipt",
				);
			}
			if (!switchTurn && request.startsWith("usage-limit-account-1")) {
				const noReset = request.startsWith("usage-limit-account-1-no-reset");
				const resetsAt = noReset
					? undefined
					: injectedResetAt(
							params.options?.env?.["CLAUDE_CONFIG_DIR"] ??
								process.env["CLAUDE_CONFIG_DIR"],
						);
				const withReset = (event: SDKMessage): SDKMessage =>
					event.type === "rate_limit_event" && resetsAt !== undefined
						? {
								...event,
								rate_limit_info: { ...event.rate_limit_info, resetsAt },
							}
						: event;
				const fixture = noReset
					? provisionalUsageLimitTurnWithoutReset(sessionId, input)
					: provisionalUsageLimitTurn(sessionId, input);
				if (proof)
					writeFileSync(
						join(dirname(proof), `provisional-limit-native-${sessionId}.json`),
						JSON.stringify(fixture.nativeTranscript, null, 2),
					);
				for (const event of fixture.events) yield withReset(event);
				mark({ kind: "usage-limit", phase: "limited", sessionId, prompt });
				if (proof) {
					const release = join(dirname(proof), "release-limit-repeats");
					while (!existsSync(release) && !closed)
						await new Promise<void>((done) => setTimeout(done, 20));
					if (closed) return;
				}
				for (let repeat = 0; repeat < 4; repeat++)
					yield withReset(
						noReset
							? provisionalRejectedLimitWithoutReset(sessionId)
							: provisionalRejectedLimit(sessionId),
					);
				mark({ kind: "usage-limit", phase: "repeated", sessionId, prompt });
				continue;
			}
			if (
				request === "Continue where you left off." &&
				proof &&
				existsSync(join(dirname(proof), "hold-continuation"))
			) {
				mark({ kind: "pre-assistant-held", prompt, queryId });
				while (
					!existsSync(join(dirname(proof), "release-continuation")) &&
					!closed
				)
					await new Promise<void>((done) => setTimeout(done, 20));
				if (closed) return;
			}
			if (
				request === "Continue where you left off." &&
				proof &&
				existsSync(join(dirname(proof), "limit-continuation"))
			) {
				yield provisionalRejectedLimitWithoutReset(sessionId);
				const fixture = provisionalUsageLimitTurnWithoutReset(sessionId, input);
				yield* fixture.events.filter((event) => event.type === "result");
				mark({ kind: "usage-limit", phase: "limited", sessionId, prompt });
				continue;
			}
			// SDK-local work, like a manual /compact: no stream and no assistant
			// message, only a result once the work ends.
			if (request === "local-work-turn" && proof) {
				mark({ kind: "pre-assistant-held", prompt, queryId });
				while (
					!existsSync(join(dirname(proof), "release-local-work")) &&
					!closed
				)
					await new Promise<void>((done) => setTimeout(done, 20));
				if (closed) return;
				yield {
					type: "result",
					subtype: "success",
					uuid: randomUUID(),
					session_id: sessionId,
					is_error: false,
					duration_ms: 0,
					duration_api_ms: 0,
					num_turns: 1,
					result: "",
					stop_reason: null,
					total_cost_usd: 0,
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
					modelUsage: {},
					permission_denials: [],
				} as unknown as SDKMessage;
				continue;
			}
			if (request.startsWith("task-stop-foreground")) {
				if (!proof) throw new Error("Missing task-stop proof gates");
				taskStopLive = request.endsWith("no-tasks")
					? []
					: request.includes("correction")
						? [...taskStopMonitorFixture]
						: request.endsWith("monitor")
							? [...taskStopMonitorFixture]
							: [...taskStopFixture];
				for (const task of taskStopLive) {
					const toolMessageId = randomUUID();
					yield stream(
						sessionId,
						{
							type: "message_start",
							message: { id: toolMessageId, role: "assistant", content: [] },
						},
						task.parentToolUseId,
					);
					yield stream(
						sessionId,
						{
							type: "content_block_start",
							index: 0,
							content_block: {
								type: "tool_use",
								id: task.tool_use_id,
								name: task.task_type === "local_agent" ? "Agent" : "Bash",
								input: {},
							},
						},
						task.parentToolUseId,
					);
					yield stream(
						sessionId,
						{
							type: "content_block_delta",
							index: 0,
							delta: {
								type: "input_json_delta",
								partial_json: JSON.stringify({
									description: task.description,
									...(task.task_type === "local_agent"
										? {
												prompt: "Review the changes",
												subagent_type: "general-purpose",
											}
										: { command: "sleep 600", run_in_background: true }),
								}),
							},
						},
						task.parentToolUseId,
					);
					yield stream(
						sessionId,
						{ type: "content_block_stop", index: 0 },
						task.parentToolUseId,
					);
					yield stream(
						sessionId,
						{ type: "message_stop" },
						task.parentToolUseId,
					);
					// Child stream blocks are transient; the SDK's completed block
					// snapshot registers the child tool's issuer before task_started.
					if (task.parentToolUseId)
						yield {
							type: "assistant",
							uuid: randomUUID(),
							session_id: sessionId,
							parent_tool_use_id: task.parentToolUseId,
							message: {
								id: toolMessageId,
								type: "message",
								role: "assistant",
								model: liveModel ?? "claude-sonnet-4",
								content: [
									{
										type: "tool_use",
										id: task.tool_use_id,
										name: "Bash",
										input: {
											command: "sleep 600",
											description: task.description,
											run_in_background: true,
										},
									},
								],
								stop_reason: null,
								stop_sequence: null,
								stop_details: null,
								container: null,
								context_management: null,
								diagnostics: null,
								usage: {
									input_tokens: 1,
									output_tokens: 1,
									cache_creation: null,
									cache_creation_input_tokens: null,
									cache_read_input_tokens: null,
									fallback_credit: null,
									inference_geo: null,
									iterations: null,
									output_tokens_details: null,
									server_tool_use: null,
									service_tier: null,
									speed: null,
								},
							},
						};
					yield {
						type: "system",
						subtype: "task_started",
						session_id: sessionId,
						uuid: randomUUID(),
						task_id: task.task_id,
						tool_use_id: task.tool_use_id,
						task_type: task.task_type,
						description: task.description,
						is_backgrounded: true,
						...(task.task_type === "local_agent"
							? { subagent_type: "general-purpose", spawn_depth: 1 }
							: {}),
					};
				}
				yield {
					type: "system",
					subtype: "background_tasks_changed",
					session_id: sessionId,
					uuid: randomUUID(),
					tasks: taskStopLive,
				};
			}
			const workspaceFile = join(
				params.options?.cwd ?? process.cwd(),
				"session-only.txt",
			);
			if (prompt.includes("workspace-isolation-write"))
				writeFileSync(
					workspaceFile,
					prompt.slice(prompt.indexOf("workspace-isolation-write")),
				);
			if (request.startsWith("workspace-multi-folder-write")) {
				for (const directory of [
					params.options?.cwd ?? process.cwd(),
					...(params.options?.additionalDirectories ?? []),
				]) {
					const trackedFile = join(directory, "tracked.txt");
					if (existsSync(trackedFile))
						writeFileSync(trackedFile, `${request}\n`);
				}
			}
			const setupMarker = join(
				params.options?.cwd ?? process.cwd(),
				"setup-marker.txt",
			);
			const chunks =
				request === "project-setup-read"
					? [
							existsSync(setupMarker)
								? readFileSync(setupMarker, "utf8")
								: "absent",
						]
					: prompt.includes("workspace-isolation-read")
						? [existsSync(workspaceFile) ? "present" : "absent"]
						: responseChunks(prompt);
			const messageId = randomUUID();
			if (request === "approval-rebind-0" && proof)
				writeFileSync(
					join(
						dirname(proof),
						`rebind-first-${params.options?.env?.["CONDUIT_SESSION_ID"]}`,
					),
					messageId,
				);
			const assistantUuid = request.startsWith("rewind-")
				? randomUUID()
				: messageId;
			yield stream(sessionId, {
				type: "message_start",
				message: { id: messageId, role: "assistant", content: [] },
			});
			yield stream(sessionId, {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			});
			for (const [index, text] of chunks.entries()) {
				if (request === "upgrade-long-turn" && index === 1 && proof) {
					const release = join(dirname(proof), "release-upgrade-turn");
					turnHeld = true;
					mark({ kind: "assistant-held", prompt, queryId });
					while (!existsSync(release) && !closed) {
						yield* outOfBand.splice(0);
						await new Promise<void>((done) => setTimeout(done, 20));
					}
					turnHeld = false;
					if (closed) return;
				}
				if (request.startsWith("restart-"))
					await new Promise<void>((done) => setTimeout(done, 120));
				const event = stream(sessionId, {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text },
				});
				mark({
					kind: "emit",
					prompt,
					text,
					at: process.hrtime.bigint().toString(),
				});
				yield event;
				if (
					request.startsWith("task-stop-foreground") &&
					index === 1 &&
					proof
				) {
					turnHeld = true;
					taskStopHolding = true;
					taskStopHeldRequest = request;
					if (request.includes("correction-reject"))
						yield* correctionForegroundTool("correction-foreground");
					mark({
						kind: "task-stop-turn",
						phase: "streaming",
						queryId,
						at: process.hrtime.bigint().toString(),
						inputId: userUuid,
						request,
					});
					while (
						!existsSync(join(dirname(proof), "task-stop-release-result")) &&
						!closed &&
						!taskTurnInterrupted
					) {
						releaseTaskStops();
						yield* outOfBand.splice(0);
						await new Promise<void>((done) => setTimeout(done, 20));
					}
					turnHeld = false;
					taskStopHolding = false;
					taskStopHeldRequest = undefined;
					if (closed) return;
					if (taskTurnInterrupted) break;
					if (request.includes("correction-reject"))
						yield {
							type: "user",
							uuid: randomUUID(),
							session_id: sessionId,
							parent_tool_use_id: null,
							message: {
								role: "user",
								content: [
									{
										type: "tool_result",
										tool_use_id: "correction-foreground",
										content: "Fixture tool completed",
										is_error: false,
									},
								],
							},
						} satisfies SDKUserMessage;
				}
			}
			// A turn that keeps streaming until it is stopped, for load tests.
			if (request.startsWith("load-stream-"))
				for (
					let tick = 0;
					!closed && !params.options?.abortController?.signal.aborted;
					tick++
				) {
					await new Promise<void>((done) => setTimeout(done, 100));
					yield stream(sessionId, {
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: `tick(${tick}) ` },
					});
				}
			yield stream(sessionId, { type: "content_block_stop", index: 0 });
			if (interruptibleTurn) {
				if (request === "terminal-replay-interrupt")
					mark({ kind: "assistant-held", prompt, queryId });
				// A control receipt is separate from the native result that ends
				// these interrupted turns.
				while (!taskTurnInterrupted && !closed)
					await new Promise<void>((done) => setTimeout(done, 20));
				if (closed) return;
			}
			const correctionError = request === "task-stop-correction-error";
			if (taskTurnInterrupted || correctionError) {
				taskTurnInterrupted = false;
				interruptibleTurn = false;
				if (request.includes("correction-duplicate") && proof)
					while (
						!existsSync(
							join(
								dirname(proof),
								"task-stop-correction-release-interrupted-result",
							),
						) &&
						!closed
					)
						await new Promise<void>((done) => setTimeout(done, 20));
				if (closed) return;
				if (request.includes("correction-late-tool")) {
					yield* correctionForegroundTool("correction-late-foreground");
					mark({
						kind: "task-stop-turn",
						phase: "late-tool",
						queryId,
						at: process.hrtime.bigint().toString(),
						inputId: userUuid,
					});
				}
				mark({
					kind: "task-stop-turn",
					phase: correctionError ? "execution-error" : "interrupted-result",
					queryId,
					at: process.hrtime.bigint().toString(),
					inputId: userUuid,
				});
				yield {
					type: "result",
					subtype: "error_during_execution",
					uuid: randomUUID(),
					session_id: sessionId,
					is_error: true,
					errors: [
						correctionError
							? "Fixture genuine execution failure"
							: "Execution ended",
					],
					duration_ms: 0,
					duration_api_ms: 0,
					num_turns: 1,
					stop_reason: null,
					total_cost_usd: 0,
					usage: taskStopUsage,
					modelUsage: {},
					permission_denials: [],
					user_message_uuid: userUuid,
				};
				// Exercise recreation after a native terminal and stream end, rather
				// than depending on Stop to dispose a still-running query.
				if (request.startsWith("stall-")) return;
				if (request.includes("correction-steer-boundary") && proof) {
					mark({
						kind: "task-stop-turn",
						phase: "after-result",
						queryId,
						at: process.hrtime.bigint().toString(),
						inputId: userUuid,
					});
					while (
						!existsSync(
							join(dirname(proof), "task-stop-correction-release-steer"),
						) &&
						!closed
					)
						await new Promise<void>((done) => setTimeout(done, 20));
				}
				continue;
			}
			const workspaceHintPrefix = "workspace-hint-tools ";
			const workspaceHintRequest = request
				.split("\n")
				.find((line) => line.startsWith(workspaceHintPrefix));
			if (workspaceHintRequest) {
				const turn = JSON.parse(
					workspaceHintRequest.slice(workspaceHintPrefix.length),
				) as {
					writes: readonly string[];
					reads?: readonly string[];
					declareWorkspace?: string;
					holdBeforeResult?: boolean;
					failAfterTools?: boolean;
				};
				interruptibleTurn = turn.holdBeforeResult === true;
				const tools: readonly {
					name: string;
					input: Record<string, unknown>;
					workspacePath?: string;
				}[] = [
					...(turn.declareWorkspace
						? [
								{
									name: "EnterWorktree",
									input: { path: turn.declareWorkspace },
									workspacePath: turn.declareWorkspace,
								},
							]
						: []),
					...turn.writes.map((path) => ({
						name: "Write",
						input: { file_path: path, content: "workspace hint fixture\n" },
					})),
					...(turn.reads ?? []).map((path) => ({
						name: "Read",
						input: { file_path: path },
					})),
				];
				for (const [offset, tool] of tools.entries()) {
					const toolUseID = randomUUID();
					const index = offset + 1;
					yield stream(sessionId, {
						type: "content_block_start",
						index,
						content_block: {
							type: "tool_use",
							id: toolUseID,
							name: tool.name,
							input: {},
						},
					});
					yield stream(sessionId, {
						type: "content_block_delta",
						index,
						delta: {
							type: "input_json_delta",
							partial_json: JSON.stringify(tool.input),
						},
					});
					yield stream(sessionId, { type: "content_block_stop", index });
					yield {
						type: "user",
						uuid: randomUUID(),
						session_id: sessionId,
						parent_tool_use_id: null,
						...(tool.workspacePath === undefined
							? {}
							: { tool_use_result: { worktreePath: tool.workspacePath } }),
						message: {
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: toolUseID,
									content: "workspace hint fixture complete",
								},
							],
						},
					} as unknown as SDKMessage;
				}
				if (turn.holdBeforeResult) {
					if (!optionsFile)
						throw new Error("Missing workspace hint fixture gate");
					const release = join(dirname(optionsFile), "workspace-hint-release");
					while (!existsSync(release) && !closed && !taskTurnInterrupted)
						await new Promise<void>((done) => setTimeout(done, 20));
					if (closed) return;
				}
				if (turn.failAfterTools)
					throw new Error("Harness failure after workspace writes");
			}
			// Blocks after the opening text: "tool", "thinking" or text to stream.
			const foldPrefix = "jev-fold-script ";
			const foldScript = request
				.split("\n")
				.find((line) => line.startsWith(foldPrefix));
			if (foldScript) {
				const blocks = JSON.parse(
					foldScript.slice(foldPrefix.length),
				) as readonly string[];
				for (const [offset, block] of blocks.entries()) {
					const index = offset + 1;
					const toolUseID = randomUUID();
					yield stream(sessionId, {
						type: "content_block_start",
						index,
						content_block:
							block === "tool"
								? { type: "tool_use", id: toolUseID, name: "Read", input: {} }
								: block === "thinking"
									? { type: "thinking", thinking: "", signature: "" }
									: { type: "text", text: "" },
					});
					yield stream(sessionId, {
						type: "content_block_delta",
						index,
						delta:
							block === "tool"
								? {
										type: "input_json_delta",
										partial_json: JSON.stringify({ file_path: "a.txt" }),
									}
								: block === "thinking"
									? { type: "thinking_delta", thinking: "Considering." }
									: { type: "text_delta", text: block },
					});
					yield stream(sessionId, { type: "content_block_stop", index });
					if (block === "tool")
						yield {
							type: "user",
							uuid: randomUUID(),
							session_id: sessionId,
							parent_tool_use_id: null,
							message: {
								role: "user",
								content: [
									{
										type: "tool_result",
										tool_use_id: toolUseID,
										content: "read",
									},
								],
							},
						} as unknown as SDKMessage;
				}
			}
			if (request === "goal-rebind") {
				yield {
					type: "assistant",
					uuid: randomUUID(),
					session_id: sessionId,
					parent_tool_use_id: null,
					message: {
						id: randomUUID(),
						role: "assistant",
						model: "<synthetic>",
						content: [{ type: "text", text: "Goal set: After rebinding" }],
					},
				} as SDKMessage;
			}
			if (request.startsWith("approval-rebind-")) {
				// A resumed SDK query replays identical native facts. The controller
				// must retain fact deduplication across account-bound queries.
				yield {
					type: "active_goal",
					uuid: "00000000-0000-4000-8000-000000000001",
					session_id: sessionId,
					value: {
						condition: "Finish the rebind",
						iterations: 0,
						set_at: 1234,
						tokens_at_start: 0,
					},
				};
				yield {
					type: "user",
					uuid: "00000000-0000-4000-8000-000000000002",
					session_id: sessionId,
					isSynthetic: true,
					parent_tool_use_id: null,
					message: {
						role: "user",
						content: "Stop hook feedback:\n[Finish the rebind]: Keep going",
					},
				};
			}
			if (
				request === "background-question" ||
				request === "background-permission"
			) {
				if (!params.options?.canUseTool)
					throw new Error("Missing background interaction bridge");
				void params.options
					.canUseTool(
						request === "background-question" ? "AskUserQuestion" : "Bash",
						request === "background-question"
							? {
									questions: [
										{
											question: "Continue background work?",
											header: "Background",
											options: [],
										},
									],
								}
							: { command: "echo background" },
						{
							signal:
								params.options.abortController?.signal ??
								new AbortController().signal,
							toolUseID: randomUUID(),
							requestId: request,
							agentID: "background-task",
						},
					)
					.then((response) =>
						mark({
							kind: "prompt-answer",
							prompt: request,
							requestId: request,
							pid: process.pid,
							response,
						}),
					);
				if (proof) {
					const release = join(dirname(proof), "release-background-foreground");
					while (!existsSync(release) && !closed)
						await new Promise<void>((done) => setTimeout(done, 20));
					if (closed) return;
				}
			}
			if (request.startsWith("question-")) {
				if (!params.options?.canUseTool)
					throw new Error("Missing question bridge");
				const fixedId = request.startsWith("question-fixed-");
				const toolUseID = randomUUID();
				const requestId = fixedId ? "0" : randomUUID();
				const longQuestion = request.startsWith("question-long-");
				const questionInput = longQuestion
					? LONG_QUESTION
					: {
							questions: [
								{
									question: "Continue?",
									header: "Runner",
									options: [
										{ label: "Continue", description: "Continue the turn" },
									],
								},
							],
						};
				// The long question also reaches the transcript as its tool call.
				if (longQuestion || fixedId) {
					yield stream(sessionId, {
						type: "content_block_start",
						index: 1,
						content_block: {
							type: "tool_use",
							id: toolUseID,
							name: "AskUserQuestion",
							input: questionInput,
						},
					});
					yield stream(sessionId, { type: "content_block_stop", index: 1 });
				}
				interruptAwaitingDecision = request.endsWith("-after-decision");
				const response = await params.options.canUseTool(
					"AskUserQuestion",
					questionInput,
					{
						signal:
							params.options.abortController?.signal ??
							new AbortController().signal,
						toolUseID,
						requestId,
					},
				);
				interruptAwaitingDecision = false;
				if (fixedId)
					mark({
						kind: "prompt-answer",
						prompt: request,
						requestId,
						pid: process.pid,
						response,
					});
			}
			// A long Bash call. With a proof directory it stays running until the
			// spec releases its result; without one it completes straight away.
			if (request.startsWith("tool-long-")) {
				interruptibleTurn = true;
				const toolUseID = randomUUID();
				yield stream(sessionId, {
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "tool_use",
						id: toolUseID,
						name: "Bash",
						input: { command: LONG_COMMAND },
					},
				});
				yield stream(sessionId, { type: "content_block_stop", index: 1 });
				const release = proof && join(dirname(proof), "release-tool-long");
				while (
					release &&
					!existsSync(release) &&
					!closed &&
					!taskTurnInterrupted
				)
					await new Promise<void>((done) => setTimeout(done, 20));
				if (closed) return;
				yield {
					type: "user",
					uuid: randomUUID(),
					session_id: sessionId,
					parent_tool_use_id: null,
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: toolUseID,
								content: taskTurnInterrupted ? "Tool interrupted" : LONG_RESULT,
								is_error: taskTurnInterrupted,
							},
						],
					},
				} as unknown as SDKMessage;
			}
			// A long turn of `load-tools-<n>` Bash calls in one message, each call
			// and each result its own live change.
			if (request.startsWith("load-tools-")) {
				const count = Number(request.slice("load-tools-".length));
				for (let call = 1; call <= count && !closed; call++) {
					const toolUseID = randomUUID();
					const marker = `load-tool-${count}-${call}`;
					yield stream(sessionId, {
						type: "content_block_start",
						index: call,
						content_block: {
							type: "tool_use",
							id: toolUseID,
							name: "Bash",
							input: { command: `printf ${marker} ${"x".repeat(400)}` },
						},
					});
					yield stream(sessionId, { type: "content_block_stop", index: call });
					await new Promise<void>((done) => setTimeout(done, 50));
					yield {
						type: "user",
						uuid: randomUUID(),
						session_id: sessionId,
						parent_tool_use_id: null,
						message: {
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: toolUseID,
									content: `${marker}-result ${"y".repeat(800)}`,
									is_error: false,
								},
							],
						},
					} as unknown as SDKMessage;
				}
			}
			if (request.startsWith("approval-")) {
				const fixedId = request.startsWith("approval-fixed-");
				const toolUseID = randomUUID();
				const requestId = fixedId ? "0" : randomUUID();
				const handoffHistory =
					request === "approval-account-switch-history" ||
					request.startsWith("approval-thread-read-history-");
				const toolName = handoffHistory ? "Read" : "Bash";
				const toolInput = handoffHistory
					? { file_path: "/account-switch-general-result.txt" }
					: { command: "printf harness-approved" };
				yield stream(sessionId, {
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "tool_use",
						id: toolUseID,
						name: toolName,
						input: toolInput,
					},
				});
				yield stream(sessionId, { type: "content_block_stop", index: 1 });
				if (!params.options?.canUseTool)
					throw new Error("Missing canUseTool bridge");
				// Pending approval is native work, so interrupt must produce its terminal result.
				interruptibleTurn = true;
				interruptAwaitingDecision = request.endsWith("-after-decision");
				const approval = await params.options.canUseTool(toolName, toolInput, {
					signal:
						params.options.abortController?.signal ??
						new AbortController().signal,
					toolUseID,
					requestId,
					...(request === "approval-restart"
						? {
								suggestions: [
									{
										type: "addRules" as const,
										rules: [
											{
												toolName: "Bash",
												ruleContent: "printf harness-approved",
											},
										],
										behavior: "allow" as const,
										destination: "session" as const,
									},
								],
							}
						: {}),
				});
				interruptAwaitingDecision = false;
				if (!approval) throw new Error("Approval bridge returned no decision");
				if (fixedId)
					mark({
						kind: "prompt-answer",
						prompt: request,
						requestId,
						pid: process.pid,
						response: approval,
					});
				mark({
					kind: "approval",
					prompt,
					behavior: approval.behavior,
					...(approval.behavior === "allow" && approval.updatedPermissions
						? { updatedPermissions: approval.updatedPermissions }
						: {}),
				});
				yield {
					type: "user",
					uuid: randomUUID(),
					session_id: sessionId,
					parent_tool_use_id: null,
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: toolUseID,
								content:
									approval.behavior === "allow"
										? handoffHistory
											? "ACCOUNT-SWITCH-GENERAL-TOOL-RESULT"
											: "harness-approved"
										: "harness-denied",
								is_error: approval.behavior !== "allow",
							},
						],
					},
				} as unknown as SDKMessage;
			}
			if (
				request.startsWith("failure-") ||
				request.startsWith("approval-failure-")
			)
				throw new Error("Harness adapter failure");
			if (
				request === "upgrade-background-work" ||
				request === "login-background-work" ||
				request.startsWith("notification-parent-turn")
			) {
				mark({
					kind: "background-work",
					phase: "started",
					queryId,
					pid: process.pid,
					at: process.hrtime.bigint().toString(),
				});
				yield {
					type: "system",
					subtype: "background_tasks_changed",
					session_id: sessionId,
					uuid: randomUUID(),
					tasks: [
						{
							task_id: "upgrade-background-task",
							task_type: "local_bash",
							description: "Live background task",
							ambient: request === "notification-parent-turn-during-warm",
						},
					],
				} as unknown as SDKMessage;
			}
			if (request === "review-subagent-finalizer") {
				// The SDK emits the Agent tool call before its task lifecycle messages.
				yield stream(sessionId, {
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "tool_use",
						id: "review-finalizer-tool",
						name: "Agent",
						input: {
							description: "Finalizer child",
							prompt: "Review the changes",
							subagent_type: "general-purpose",
						},
					},
				});
				yield stream(sessionId, { type: "content_block_stop", index: 1 });
				yield {
					type: "system",
					subtype: "task_started",
					uuid: randomUUID(),
					session_id: sessionId,
					task_id: "review-finalizer-task",
					tool_use_id: "review-finalizer-tool",
					description: "Finalizer child",
					task_type: "local_agent",
				} as unknown as SDKMessage;
				yield {
					type: "system",
					subtype: "task_notification",
					uuid: randomUUID(),
					session_id: sessionId,
					task_id: "review-finalizer-task",
					tool_use_id: "review-finalizer-tool",
					status: "completed",
					output_file: proof
						? join(dirname(proof), "review-finalizer-task.output")
						: "review-finalizer-task.output",
					summary: "Task complete; transcript catch-up pending",
				} as unknown as SDKMessage;
			}
			recordNativeMessage(
				{
					type: "assistant",
					uuid: assistantUuid,
					parentUuid: nativeParentUuid,
					session_id: sessionId,
					message: {
						id: messageId,
						role: "assistant",
						content: [{ type: "text", text: chunks.join("") }],
					},
					parent_tool_use_id: null,
					parent_agent_id: null,
				},
				accountConfigDir,
				params.options?.cwd,
			);
			nativeParentUuid = assistantUuid;
			yield {
				type: "assistant",
				uuid: assistantUuid,
				session_id: sessionId,
				parent_tool_use_id: null,
				message: {
					id: messageId,
					role: "assistant",
					content: [{ type: "text", text: chunks.join("") }],
				},
			} as unknown as SDKMessage;
			if (request.startsWith("task-stop-foreground"))
				mark({
					kind: "task-stop-turn",
					phase: "result",
					queryId,
					at: process.hrtime.bigint().toString(),
				});
			// Interrupting a held tool ends through a native result, independently
			// of the interrupt acknowledgement, just like the earlier held turns.
			const interrupted = taskTurnInterrupted;
			taskTurnInterrupted = false;
			interruptibleTurn = false;
			yield {
				type: "result",
				subtype: interrupted ? "error_during_execution" : "success",
				uuid: randomUUID(),
				session_id: sessionId,
				is_error: interrupted,
				duration_ms: 0,
				duration_api_ms: 0,
				num_turns: 1,
				...(interrupted
					? { errors: ["Execution ended"], user_message_uuid: userUuid }
					: { result: chunks.join("") }),
				stop_reason: interrupted ? null : "end_turn",
				total_cost_usd: 0,
				usage: {
					input_tokens: 1,
					output_tokens: 3,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
				modelUsage: {},
				permission_denials: [],
			} as unknown as SDKMessage;
			if (request === "task-stop-foreground-idle" && proof) {
				mark({
					kind: "task-stop-turn",
					phase: "after-result",
					queryId,
					at: process.hrtime.bigint().toString(),
				});
				while (
					!existsSync(join(dirname(proof), "task-stop-release-input")) &&
					!closed
				) {
					releaseTaskStops();
					yield* outOfBand.splice(0);
					await new Promise<void>((done) => setTimeout(done, 20));
				}
				if (closed) return;
			}
			if (request === "restart-background-work") {
				yield {
					type: "system",
					subtype: "background_tasks_changed",
					session_id: sessionId,
					uuid: randomUUID(),
					tasks: [
						{
							task_id: "restart-background-task",
							task_type: "local_bash",
							description: "Background restart proof",
							ambient: false,
						},
					],
				} as unknown as SDKMessage;
				mark({
					kind: "background-work",
					phase: "started",
					queryId,
					pid: process.pid,
					at: process.hrtime.bigint().toString(),
				});
				if (proof) {
					const change = join(dirname(proof), "restart-background-change");
					while (!existsSync(change) && !closed)
						await new Promise<void>((done) => setTimeout(done, 20));
					if (closed || readFileSync(change, "utf8") === "end") return;
					yield {
						type: "system",
						subtype: "background_tasks_changed",
						session_id: sessionId,
						uuid: randomUUID(),
						tasks:
							readFileSync(change, "utf8") === "replace"
								? [
										{
											task_id: "replacement-background-task",
											task_type: "local_agent",
											description: "Latest background snapshot",
											ambient: false,
										},
									]
								: [],
					} as unknown as SDKMessage;
				}
			}
			if (request === "upgrade-background-work" && proof) {
				const release = join(dirname(proof), "release-upgrade-background");
				while (!existsSync(release) && !closed)
					await new Promise<void>((done) => setTimeout(done, 20));
				if (closed) return;
				yield {
					type: "system",
					subtype: "background_tasks_changed",
					session_id: sessionId,
					uuid: randomUUID(),
					tasks: [],
				} as unknown as SDKMessage;
				mark({
					kind: "background-work",
					phase: "completed",
					queryId,
					pid: process.pid,
					at: process.hrtime.bigint().toString(),
				});
			}
			if (request.startsWith("notification-parent-turn") && proof) {
				const release = join(dirname(proof), "release-notification-parent");
				while (!existsSync(release) && !closed)
					await new Promise<void>((done) => setTimeout(done, 20));
				if (closed) return;
				yield {
					type: "system",
					subtype: "background_tasks_changed",
					session_id: sessionId,
					uuid: randomUUID(),
					tasks: [],
				} as unknown as SDKMessage;
				yield {
					type: "system",
					subtype: "task_notification",
					session_id: sessionId,
					uuid: randomUUID(),
					task_id: "upgrade-background-task",
					status: "completed",
					output_file: join(dirname(proof), "notification-parent.output"),
					summary: "Background task complete; parent is continuing",
				} as unknown as SDKMessage;
				mark({
					kind: "background-work",
					phase: "completed",
					queryId,
					pid: process.pid,
					at: process.hrtime.bigint().toString(),
				});
				const resultRelease = join(
					dirname(proof),
					"release-notification-result",
				);
				let parentMessageId = "";
				for (const text of [
					"Notification parent message.",
					"Notification parent finished.",
				]) {
					const beforeSnapshot =
						request === "notification-parent-turn-before-snapshot";
					parentMessageId = beforeSnapshot
						? `msg_${randomUUID()}`
						: randomUUID();
					const snapshotUuid = beforeSnapshot ? randomUUID() : parentMessageId;
					yield stream(sessionId, {
						type: "message_start",
						message: { id: parentMessageId, role: "assistant", content: [] },
					});
					yield stream(sessionId, {
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					});
					yield stream(sessionId, {
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text },
					});
					yield stream(sessionId, { type: "content_block_stop", index: 0 });
					yield stream(sessionId, { type: "message_stop" });
					if (beforeSnapshot && text === "Notification parent message.") {
						mark({
							kind: "notification-turn",
							phase: "stream-held",
							queryId,
							pid: process.pid,
							messageId: parentMessageId,
							snapshotUuid,
							at: process.hrtime.bigint().toString(),
						});
						const snapshotRelease = join(
							dirname(proof),
							"release-notification-snapshot",
						);
						while (!existsSync(snapshotRelease) && !closed)
							await new Promise<void>((done) => setTimeout(done, 20));
						if (closed) return;
					}
					yield {
						type: "assistant",
						uuid: snapshotUuid,
						session_id: sessionId,
						parent_tool_use_id: null,
						message: {
							id: parentMessageId,
							role: "assistant",
							content: [{ type: "text", text }],
						},
					} as unknown as SDKMessage;
					if (beforeSnapshot)
						mark({
							kind: "notification-turn",
							phase: "snapshot",
							queryId,
							pid: process.pid,
							messageId: parentMessageId,
							snapshotUuid,
							at: process.hrtime.bigint().toString(),
						});
					if (text === "Notification parent message.") {
						mark({
							kind: "notification-turn",
							phase: "held",
							queryId,
							pid: process.pid,
							messageId: parentMessageId,
							at: process.hrtime.bigint().toString(),
						});
						while (!existsSync(resultRelease) && !closed)
							await new Promise<void>((done) => setTimeout(done, 20));
						if (closed) return;
					}
				}
				yield {
					type: "result",
					subtype: "success",
					uuid: randomUUID(),
					session_id: sessionId,
					is_error: false,
					duration_ms: 0,
					duration_api_ms: 0,
					num_turns: 1,
					result: "Notification parent finished.",
					stop_reason: "end_turn",
					total_cost_usd: 0,
					usage: {
						input_tokens: 1,
						output_tokens: 3,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
					modelUsage: {},
					permission_denials: [],
				} as unknown as SDKMessage;
				mark({
					kind: "notification-turn",
					phase: "completed",
					queryId,
					pid: process.pid,
					messageId: parentMessageId,
					at: process.hrtime.bigint().toString(),
				});
			}
			if (request === "ambient-idle") {
				while (!closed) {
					await new Promise<void>((done) => setTimeout(done, 50));
					yield {
						type: "system",
						subtype: "background_tasks_changed",
						session_id: sessionId,
						uuid: randomUUID(),
						tasks: [
							{
								task_id: "watcher",
								task_type: "local_bash",
								description: "watch",
								ambient: true,
							},
						],
					} as unknown as SDKMessage;
				}
			}
		}
	})();
	// The adapter consumes the iterable and these control methods; the full SDK
	// interface also contains unrelated account/MCP methods that this fake never uses.
	return Object.assign(messages, {
		[Symbol.asyncIterator]: () => ({
			next: () => messages.next(),
			return: () => messages.return(undefined),
		}),
		initializationResult: () => initialization,
		usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:
			async (): Promise<SDKControlGetUsageResponse> => {
				const configDir =
					params.options?.env?.["CLAUDE_CONFIG_DIR"] ??
					process.env["CLAUDE_CONFIG_DIR"];
				const resetsAt = injectedResetAt(configDir);
				const marker = configDir
					? join(configDir, "conduit-test-quota")
					: undefined;
				const selected =
					marker && existsSync(marker)
						? readFileSync(marker, "utf8").trim()
						: "available";
				const behavior: QuotaBehavior =
					selected === "limited" ||
					selected === "fail" ||
					selected === "hang" ||
					selected === "unavailable" ||
					selected === "plan-unavailable"
						? selected
						: "available";
				mark({ kind: "usage-probe", configDir, queryId, behavior });
				if (behavior === "unavailable")
					throw new Error("Not logged in. Please run /login");
				if (behavior === "fail")
					throw new Error("Synthetic usage control failure");
				if (behavior === "hang") {
					while (!closed && !params.options?.abortController?.signal.aborted)
						await new Promise<void>((done) => setTimeout(done, 20));
					throw new Error("Usage control query closed");
				}
				const responseFile = configDir
					? join(configDir, "conduit-test-usage-response.json")
					: undefined;
				const configured =
					responseFile && existsSync(responseFile)
						? (JSON.parse(
								readFileSync(responseFile, "utf8"),
							) as Partial<SDKControlGetUsageResponse>)
						: {};
				return {
					session: {
						total_cost_usd: 0,
						total_api_duration_ms: 0,
						total_duration_ms: 0,
						total_lines_added: 0,
						total_lines_removed: 0,
						model_usage: {},
					},
					subscription_type: "max",
					rate_limits_available: behavior !== "plan-unavailable",
					rate_limits:
						behavior === "plan-unavailable"
							? null
							: {
									five_hour: { utilization: 12, resets_at: null },
									seven_day: {
										utilization: behavior === "limited" ? 100 : 37,
										resets_at:
											resetsAt === undefined
												? null
												: new Date(resetsAt * 1000).toISOString(),
									},
								},
					behaviors: null,
					...configured,
				};
			},
		close: () => {
			if (closed) return;
			closed = true;
			clearTimeout(initializationTimer);
			if (!initializationFinished) {
				initializationFinished = true;
				rejectInitialization(
					new Error("Claude query closed before initialization"),
				);
			}
			if (!zeroTurn)
				mark({
					kind: "query-closed",
					queryId,
					at: process.hrtime.bigint().toString(),
				});
		},
		interrupt: async () => {
			if (
				taskStopHeldRequest?.includes("correction-reject") &&
				proof &&
				!existsSync(
					join(dirname(proof), "task-stop-correction-allow-interrupt"),
				)
			) {
				mark({
					kind: "query-interrupt-rejected",
					queryId,
					at: process.hrtime.bigint().toString(),
				});
				throw new Error("Fixture interrupt rejected");
			}
			if (taskStopHolding || interruptibleTurn) taskTurnInterrupted = true;
			mark({
				kind: "query-interrupted",
				queryId,
				at: process.hrtime.bigint().toString(),
			});
			// Some SDK interrupts cannot acknowledge until canUseTool returns.
			while (interruptAwaitingDecision && !closed)
				await new Promise<void>((done) => setTimeout(done, 20));
			const configDir =
				params.options?.env?.["CLAUDE_CONFIG_DIR"] ??
				process.env["CLAUDE_CONFIG_DIR"];
			if (
				proof &&
				configDir &&
				existsSync(join(configDir, "conduit-test-hold-stop"))
			) {
				mark({ kind: "stop-held", queryId });
				while (
					!existsSync(join(dirname(proof), "release-switch-stop")) &&
					!closed
				)
					await new Promise<void>((done) => setTimeout(done, 20));
			}
		},
		stopTask: async (taskId: string) => {
			mark({
				kind: "task-stop",
				phase: "requested",
				taskId,
				queryId,
				at: process.hrtime.bigint().toString(),
			});
			if (!taskStopLive.some((task) => task.task_id === taskId)) {
				mark({
					kind: "task-stop",
					phase: "already-finished",
					taskId,
					queryId,
					at: process.hrtime.bigint().toString(),
				});
				return;
			}
			if (
				proof &&
				existsSync(join(dirname(proof), `task-stop-fail-${taskId}`))
			) {
				mark({
					kind: "task-stop",
					phase: "failed",
					taskId,
					queryId,
					at: process.hrtime.bigint().toString(),
				});
				throw new Error("Synthetic task stop failure");
			}
			pendingTaskStops.add(taskId);
		},
		setModel: async (model?: string) => {
			liveModel = model;
			mark({
				kind: "query-update",
				queryId,
				...(model === undefined ? {} : { model }),
			});
		},
		setPermissionMode: async (permissionMode: Options["permissionMode"]) => {
			livePermissionMode = permissionMode;
			if (turnHeld)
				outOfBand.push({
					type: "system",
					subtype: "status",
					status: null,
					permissionMode,
					uuid: randomUUID(),
					session_id: sessionId,
				} as unknown as SDKMessage);
			mark({
				kind: "query-update",
				queryId,
				...(permissionMode === undefined ? {} : { permissionMode }),
			});
		},
		applyFlagSettings: async (settings: {
			effortLevel?: Options["effort"];
		}) => {
			liveEffort = settings.effortLevel;
			mark({
				kind: "query-update",
				queryId,
				...(liveEffort === undefined ? {} : { effort: liveEffort }),
			});
		},
	}) as unknown as Query;
}

export const claudeSdk: NonNullable<ProjectRelayConfig["claudeSdk"]> = {
	query,
	fork: {
		transcriptExists: async (sessionId, options) =>
			existsSync(
				join(
					options.configDir.path,
					`conduit-test-transcript-${sessionId}.ndjson`,
				),
			),
		readTranscript: async (sessionId, options) => {
			return readNativeTranscript(
				sessionId,
				options.configDir.path,
				options.dir,
			);
		},
		forkSession: async (parentSessionId, options) => {
			const transcript = readNativeTranscript(
				parentSessionId,
				options.configDir.path,
				options.dir,
			);
			const directoryFile = join(
				options.configDir.path,
				`conduit-test-transcript-${parentSessionId}.ndjson.directory`,
			);
			const directory = existsSync(directoryFile)
				? readFileSync(directoryFile, "utf8")
				: undefined;
			const end =
				options.upToMessageId === undefined
					? transcript.length - 1
					: transcript.findIndex(
							(entry) => entry.uuid === options.upToMessageId,
						);
			if (end < 0) throw new Error("Native fork boundary was not found");
			const sessionId = randomUUID();
			for (const entry of transcript.slice(0, end + 1)) {
				recordNativeMessage(
					{ ...entry, session_id: sessionId },
					options.configDir.path,
					directory,
				);
			}
			mark({
				kind: "native-fork",
				parentSessionId,
				sessionId,
				configDir: options.configDir.path,
				upToMessageId: options.upToMessageId,
			});
			return { sessionId };
		},
	},
	titleQuery: async function* (
		params: Parameters<ClaudeOneShotQueryFactory>[0],
	) {
		const file = process.env["CONDUIT_TEST_CLAUDE_TITLES_FILE"];
		if (file)
			appendFileSync(
				file,
				`${JSON.stringify({ prompt: params.prompt, cwd: params.options?.cwd, configDir: params.options?.env?.["CLAUDE_CONFIG_DIR"] })}\n`,
			);
		const tuning = Schema.decodeUnknownOption(
			Schema.fromJsonString(
				Schema.Struct({
					currentSet: CategorySetSchema,
					avoid: Schema.Array(CategoryTuningHunkSchema),
				}),
			),
		)(params.prompt);
		if (Option.isSome(tuning)) {
			const before = tuning.value.currentSet.categories.find(
				({ id }) => id === "finding",
			);
			if (!before) throw new Error("Tuning fixture requires Finding");
			const weight = tuning.value.avoid.length === 0 ? 80 : 90;
			yield {
				type: "result",
				subtype: "success",
				result: JSON.stringify({
					hunks: [
						{
							id: `finding-weight-${weight}`,
							categoryId: "finding",
							before,
							after: { ...before, weight },
							rationale: "Your five corrections raise findings.",
						},
					],
					rationale: "A higher Finding weight agrees with the corrections.",
				}),
			};
			return;
		}
		yield {
			type: "result",
			subtype: "success",
			result: params.prompt.startsWith("Summarize this coding-assistant turn")
				? "The first finding changed the plan [#1]. The last finding confirms the fix [#4]. An invalid citation is removed [#999]."
				: "Process harness session",
		};
	},
};
