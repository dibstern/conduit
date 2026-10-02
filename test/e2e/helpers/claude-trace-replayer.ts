// Claude SDK trace replayer (E2E Claude lane)
// Plays committed Claude Agent SDK traces (test/fixtures/claude-sdk-traces,
// real captured wire traffic — see docs/adr/0002) through the Claude runtime's
// injected queryFactory, one planned trace per sent turn. Failure modes are
// listed and pinned in test/unit/e2e/claude-trace-replayer.test.ts.
//
// Per replayed turn, envelope ids (uuid, assistant message.id, message_start
// message.id) are fresh so the translator's dedupe never swallows a repeated
// turn; session_id is one fresh id per replayer, stable like the SDK's.
// Content, including tool_use/task ids, is untouched — plan a trace that
// carries tools at most once per session.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { decodeClaudeSDKMessage } from "../../../src/lib/contracts/providers/claude-agent-sdk.js";
import type { SDKMessage } from "../../../src/lib/provider/claude/types.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";

export type ClaudeTraceName =
	| "background-shell-turn"
	| "pong-thinking-text-turn"
	| "subagent-task-turn";

export interface ClaudeReplayPlan {
	/** One committed trace per sent turn, in send order. */
	readonly turns: readonly ClaudeTraceName[];
	/** Pause before every replayed message (e.g. to keep a turn stoppable). */
	readonly delayMs?: number;
	/**
	 * Ask the runtime's canUseTool after this tool's tool_use, as the SDK does
	 * before running a tool, and hold the rest of the turn until it answers.
	 */
	readonly askPermissionFor?: string;
	/**
	 * Hold whatever a trace carries after a `result` (a background task ending
	 * after its turn) until release(). Live, real time passes there; replayed,
	 * the test decides when.
	 */
	readonly holdAfterResult?: boolean;
	/** Trace directory override (unit tests only). */
	readonly tracesDir?: string;
}

export interface ClaudeTraceReplayer {
	/** Pass as `claudeSdk` to createRelayStack. */
	readonly sdk: NonNullable<ProjectRelayConfig["claudeSdk"]>;
	/** Lets a holdAfterResult replay continue past its result. */
	release(): void;
	/** Throws unless exactly the planned turns were sent. */
	assertComplete(): void;
}

const TRACES_DIR = join(
	import.meta.dirname,
	"../../fixtures/claude-sdk-traces",
);

function envelopeIds(message: SDKMessage): string[] {
	const ids: string[] = message.uuid ? [message.uuid] : [];
	if (message.type === "assistant") ids.push(message.message.id);
	if (
		message.type === "stream_event" &&
		message.event.type === "message_start"
	) {
		ids.push(message.event.message.id);
	}
	return ids;
}

/** Decode every line up front so a drifted trace fails before any relay starts. */
function loadTrace(dir: string, name: ClaudeTraceName) {
	const file = join(dir, `${name}.jsonl`);
	const lines = readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "");
	const messages = lines.map((line, index) => {
		try {
			return decodeClaudeSDKMessage(JSON.parse(line));
		} catch (cause) {
			throw new Error(`${file}:${index + 1} is not a decodable SDK message`, {
				cause,
			});
		}
	});
	return {
		lines,
		ids: [...new Set(messages.flatMap(envelopeIds))],
		sessionIds: [
			...new Set(messages.flatMap((message) => message.session_id ?? [])),
		],
	};
}

type Trace = ReturnType<typeof loadTrace>;

function freshTurn(trace: Trace, sessionId: string): SDKMessage[] {
	const replacements = [
		...trace.ids.map(
			(id) =>
				[
					id,
					id.startsWith("msg_") ? `msg_${randomUUID()}` : randomUUID(),
				] as const,
		),
		...trace.sessionIds.map((id) => [id, sessionId] as const),
	];
	return trace.lines.map((line) =>
		decodeClaudeSDKMessage(
			JSON.parse(
				replacements.reduce(
					(text, [from, to]) => text.replaceAll(`"${from}"`, `"${to}"`),
					line,
				),
			),
		),
	);
}

const unsupported = (method: string) => (): Promise<never> =>
	Promise.reject(
		new Error(`Claude trace replay: Query.${method} is not replayed`),
	);

export function createClaudeTraceReplayer(
	plan: ClaudeReplayPlan,
): ClaudeTraceReplayer {
	const traces = plan.turns.map((name) =>
		loadTrace(plan.tracesDir ?? TRACES_DIR, name),
	);
	const sessionId = randomUUID();
	let sent = 0;
	let unplannedTurn: Error | undefined;
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});

	const query: ClaudeTraceReplayer["sdk"]["query"] = ({ prompt, options }) => {
		let interrupted = false;
		let aborted = new AbortController();

		async function* replay(): AsyncGenerator<SDKMessage, void> {
			for await (const _prompt of prompt) {
				sent += 1;
				const trace = traces[sent - 1];
				if (!trace) {
					unplannedTurn ??= new Error(
						`Claude trace replay: turn ${sent} was sent, but only ${traces.length} planned`,
					);
					throw unplannedTurn;
				}
				interrupted = false;
				aborted = new AbortController();
				const messages = freshTurn(trace, sessionId);
				for (const [index, message] of messages.entries()) {
					if (plan.delayMs) await sleep(plan.delayMs);
					if (interrupted) break;
					yield message;
					if (
						plan.holdAfterResult &&
						message.type === "result" &&
						index < messages.length - 1
					) {
						await held;
						if (interrupted) break;
					}
					const tool =
						message.type === "assistant"
							? message.message.content.find(
									(block) =>
										block.type === "tool_use" &&
										block.name === plan.askPermissionFor,
								)
							: undefined;
					if (tool?.type === "tool_use" && options?.canUseTool)
						await options.canUseTool(
							tool.name,
							typeof tool.input === "object" && tool.input !== null
								? { ...tool.input }
								: {},
							{
								signal: aborted.signal,
								toolUseID: tool.id,
								requestId: `req_${tool.id}`,
							},
						);
				}
			}
		}

		return Object.assign(replay(), {
			// Stop mid-turn: drop the rest of the current trace. The runtime
			// persists turn.interrupted itself and ignores any post-interrupt
			// result, so no SDK error result is synthesized here.
			interrupt: async () => {
				interrupted = true;
				aborted.abort();
				release();
				return undefined;
			},
			close: () => {
				interrupted = true;
				aborted.abort();
				release();
			},
			// Settings the runtime syncs before each turn; traces are fixed.
			setModel: async () => {},
			setPermissionMode: async () => {},
			applyFlagSettings: async () => {},
			setMcpPermissionModeOverride: unsupported("setMcpPermissionModeOverride"),
			setMaxThinkingTokens: unsupported("setMaxThinkingTokens"),
			updateSettings: unsupported("updateSettings"),
			initializationResult: unsupported("initializationResult"),
			reinitialize: unsupported("reinitialize"),
			supportedCommands: unsupported("supportedCommands"),
			supportedModels: unsupported("supportedModels"),
			supportedAgents: unsupported("supportedAgents"),
			mcpServerStatus: unsupported("mcpServerStatus"),
			getContextUsage: unsupported("getContextUsage"),
			usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: unsupported(
				"usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET",
			),
			readFile: unsupported("readFile"),
			reloadPlugins: unsupported("reloadPlugins"),
			reloadSkills: unsupported("reloadSkills"),
			reloadOutputStyles: unsupported("reloadOutputStyles"),
			accountInfo: unsupported("accountInfo"),
			rewindFiles: unsupported("rewindFiles"),
			seedReadState: unsupported("seedReadState"),
			reconnectMcpServer: unsupported("reconnectMcpServer"),
			toggleMcpServer: unsupported("toggleMcpServer"),
			readMcpResource: unsupported("readMcpResource"),
			setMcpServers: unsupported("setMcpServers"),
			streamInput: unsupported("streamInput"),
			stopTask: unsupported("stopTask"),
			backgroundTasks: unsupported("backgroundTasks"),
		});
	};

	return {
		sdk: {
			query,
			// Session-title generation: a fixed title, never a model call.
			titleQuery: async function* () {
				yield { type: "result", result: "Claude trace replay" };
			},
		},
		release,
		assertComplete() {
			if (unplannedTurn) throw unplannedTurn;
			if (sent < traces.length) {
				throw new Error(
					`Claude trace replay played ${sent} of ${traces.length} planned turns`,
				);
			}
		},
	};
}
