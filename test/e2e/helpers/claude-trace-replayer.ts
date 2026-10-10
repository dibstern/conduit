// Claude SDK trace replayer (E2E Claude lane)
// Plays committed Claude Agent SDK traces (test/fixtures/claude-sdk-traces,
// real captured wire traffic — see docs/adr/0002) through the Claude runtime's
// injected queryFactory, one planned trace per sent turn. Failure modes are
// listed and pinned in test/unit/e2e/claude-trace-replayer.test.ts.
//
// Per replayed turn, envelope ids (uuid, assistant message.id, message_start
// message.id) are fresh so the translator's dedupe never swallows a repeated
// turn; session_id stays stable within each session, including resumed forks.
// Content, including tool_use/task ids, is untouched — plan a trace that
// carries tools at most once per session.
//
// A trace's agent transcript reads (<name>.subagent-reads.json, captured
// alongside it) are served by subagentSdk as they were read at that point of
// the trace, with the same fresh ids as the replayed stream.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { decodeClaudeSDKMessage } from "../../../src/lib/contracts/providers/claude-agent-sdk.js";
import type { ClaudeSessionForkSdk } from "../../../src/lib/provider/claude/claude-session-fork.js";
import type { ClaudeSubagentSdk } from "../../../src/lib/provider/claude/claude-subagent-materializer.js";
import type {
	PermissionMode,
	SDKMessage,
} from "../../../src/lib/provider/claude/types.js";
import type { ModelInfo } from "../../../src/lib/provider/types.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";

export type ClaudeTraceName =
	| "api-retry-pong-turn"
	| "background-shell-turn"
	| "concurrent-background-work-after-restart-turn"
	| "concurrent-background-work-turn"
	| "extra-folder-read-turn"
	| "foreground-agent-backgrounded-turn"
	| "pong-thinking-text-turn"
	| "side-thread-plan-turn"
	| "skill-loads-turn"
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
	 * Hold whatever a trace carries after its first `result` (a background
	 * task ending after its turn) until release(). Live, real time passes
	 * there; replayed, the test decides when.
	 */
	readonly holdAfterResult?: boolean;
	/** Deliver agent steps only through captured transcript reads, exercising feeds. */
	readonly transcriptOnlySubagents?: boolean;
	/**
	 * Hold this sent turn (1-based) before its trace's message-th line
	 * (1-based) until release(), e.g. mid-way through background work.
	 */
	readonly holdBefore?: { readonly turn: number; readonly message: number };
	/**
	 * Hold this sent turn (1-based, counted across sessions) before its first
	 * tool_result until release(), leaving the tool call running.
	 */
	readonly holdTurnBeforeToolResult?: number;
	/**
	 * A prompt sent mid-turn joins the open SDK turn, as the real SDK does:
	 * the next model round answers it, with no result in between. Without
	 * this, prompts play strictly one after another.
	 */
	readonly joinOpenTurn?: boolean;
	/** Trace directory override (unit tests only). */
	readonly tracesDir?: string;
	/** Claude model catalog to advertise instead of the bare trace model. */
	readonly models?: readonly ModelInfo[];
}

export interface ClaudeTraceReplayer {
	/** Pass as `claudeSdk` to createRelayStack. */
	readonly sdk: NonNullable<ProjectRelayConfig["claudeSdk"]> & {
		readonly subagentSdk: ClaudeSubagentSdk;
	};
	/** The permission mode the runtime requested for each sent turn, in order. */
	readonly sentPermissionModes: readonly (PermissionMode | undefined)[];
	/** Every fork, in call order; upToMessageId is the inclusive cut uuid. */
	readonly forks: readonly {
		readonly parentSessionId: string;
		readonly sessionId: string;
		readonly upToMessageId?: string;
	}[];
	/** The session's transcript as replayed: prompts and main-chain messages. */
	transcript(sessionId: string): readonly SessionMessage[];
	/** Opens the next hold the replay reaches (or has reached): one per hold. */
	release(): void;
	/** Resolves once the replay waits at a hold not yet released. */
	held(): Promise<void>;
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

/** An agent's transcript as the capture read it, after `afterMessage` trace lines. */
interface TranscriptRead {
	readonly afterMessage: number;
	readonly agentId: string;
	readonly messages: readonly SessionMessage[];
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
	const readsFile = join(dir, `${name}.subagent-reads.json`);
	const reads: readonly TranscriptRead[] = existsSync(readsFile)
		? JSON.parse(readFileSync(readsFile, "utf8"))
		: [];
	return {
		lines,
		reads,
		ids: [
			...new Set([
				...messages.flatMap(envelopeIds),
				...reads.flatMap((read) => read.messages.map((entry) => entry.uuid)),
			]),
		],
		sessionIds: [
			...new Set(messages.flatMap((message) => message.session_id ?? [])),
		],
	};
}

type Trace = ReturnType<typeof loadTrace>;

function freshTurn(trace: Trace, sessionId: string) {
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
	const fresh = (json: string) =>
		replacements.reduce(
			(text, [from, to]) => text.replaceAll(`"${from}"`, `"${to}"`),
			json,
		);
	return {
		messages: trace.lines.map((line) =>
			decodeClaudeSDKMessage(JSON.parse(fresh(line))),
		),
		reads: JSON.parse(fresh(JSON.stringify(trace.reads))) as TranscriptRead[],
	};
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
	const sessionIds = new Set<string>([sessionId]);
	const forkTrace = JSON.parse(
		readFileSync(
			join(plan.tracesDir ?? TRACES_DIR, "fork-session.json"),
			"utf8",
		),
	) as {
		forkSession: Awaited<ReturnType<ClaudeSessionForkSdk["forkSession"]>>;
	};
	const transcripts = new Map<string, SessionMessage[]>();
	/** Each session's played turns: their reads, and how far each has played. */
	const playedTurns = new Map<
		string,
		{ readonly reads: readonly TranscriptRead[]; played: number }[]
	>();
	const forks: ClaudeTraceReplayer["forks"][number][] = [];
	const knownSession = (sessionId: string) => {
		if (!sessionIds.has(sessionId))
			throw new Error(`Claude trace replay: unknown session ${sessionId}`);
		return transcripts.get(sessionId) ?? [];
	};
	let sent = 0;
	const sentPermissionModes: (PermissionMode | undefined)[] = [];
	let unplannedTurn: Error | undefined;
	// Holds open in the order the replay reaches them, one per release().
	let releases = 0;
	let holdsReached = 0;
	let resultHeld = false;
	const onRelease: (() => void)[] = [];
	const onHold: (() => void)[] = [];
	const release = () => {
		releases += 1;
		for (const wake of onRelease.splice(0)) wake();
	};
	const held = () =>
		holdsReached > releases
			? Promise.resolve()
			: new Promise<void>((resolve) => onHold.push(resolve));

	const query: ClaudeTraceReplayer["sdk"]["query"] = ({ prompt, options }) => {
		const querySessionId = options?.resume ?? sessionId;
		// A replacement process can begin by resuming its persisted parent.
		if (sent === 0 && options?.resume) sessionIds.add(querySessionId);
		if (!sessionIds.has(querySessionId))
			throw new Error(`Claude trace replay: unknown session ${querySessionId}`);
		let interrupted = false;
		let aborted = new AbortController();
		let permissionMode = options?.permissionMode;

		const waitForRelease = async () => {
			// Only this query's own stop may cut a hold short: the runtime also
			// opens and closes spare (pre-warmed) queries.
			const { signal } = aborted;
			const hold = ++holdsReached;
			for (const notify of onHold.splice(0)) notify();
			while (releases < hold && !signal.aborted)
				await new Promise<void>((resolve) => {
					onRelease.push(resolve);
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
		};

		const transcript = transcripts.get(querySessionId) ?? [];
		transcripts.set(querySessionId, transcript);
		const entry = (
			type: "user" | "assistant",
			message: unknown,
			uuid = randomUUID(),
		): SessionMessage => ({
			type,
			uuid,
			session_id: querySessionId,
			message,
			parent_tool_use_id: null,
			parent_agent_id: null,
		});

		async function* replay(): AsyncGenerator<SDKMessage, void> {
			const prompts = (async function* () {
				yield* prompt;
			})();
			let joining = false;
			for (let next = prompts.next(); ; ) {
				const current = await next;
				if (current.done) break;
				const userPrompt = current.value;
				next = prompts.next();
				let queued = false;
				if (plan.joinOpenTurn)
					void next.then((result) => {
						queued = !result.done;
					});
				sent += 1;
				const turn = sent;
				sentPermissionModes.push(permissionMode);
				transcript.push(entry("user", userPrompt.message));
				const trace = traces[turn - 1];
				if (!trace) {
					unplannedTurn ??= new Error(
						`Claude trace replay: turn ${sent} was sent, but only ${traces.length} planned`,
					);
					throw unplannedTurn;
				}
				interrupted = false;
				aborted = new AbortController();
				const { messages, reads } = freshTurn(trace, querySessionId);
				const played = { reads, played: 0 };
				playedTurns.set(querySessionId, [
					...(playedTurns.get(querySessionId) ?? []),
					played,
				]);
				let heldBeforeToolResult = false;
				const isRoundStart = (message: SDKMessage) =>
					message.type === "stream_event" &&
					message.event.type === "message_start";
				// A joined turn has no startup of its own (hooks, init).
				const from = joining
					? Math.max(0, messages.findIndex(isRoundStart))
					: 0;
				joining = false;
				for (const [index, message] of messages.entries()) {
					if (index < from) continue;
					if (plan.delayMs) await sleep(plan.delayMs);
					if (
						turn === plan.holdTurnBeforeToolResult &&
						!heldBeforeToolResult &&
						message.type === "user" &&
						Array.isArray(message.message.content) &&
						message.message.content.some(
							(block) => block.type === "tool_result",
						)
					) {
						heldBeforeToolResult = true;
						await waitForRelease();
					}
					if (
						turn === plan.holdBefore?.turn &&
						index + 1 === plan.holdBefore.message
					)
						await waitForRelease();
					if (interrupted) break;
					// The queued prompt takes over at the next model round.
					if (queued && index > from && isRoundStart(message)) {
						joining = true;
						break;
					}
					// Counted before the yield: the consumer reads transcripts while
					// this generator is suspended there.
					played.played = index + 1;
					if (
						plan.transcriptOnlySubagents &&
						(message.type === "assistant" ||
							message.type === "user" ||
							message.type === "stream_event") &&
						message.parent_tool_use_id != null
					)
						continue;
					yield message;
					if (
						(message.type === "user" || message.type === "assistant") &&
						message.parent_tool_use_id === null
					)
						transcript.push(entry(message.type, message.message, message.uuid));
					if (
						plan.holdAfterResult &&
						!resultHeld &&
						message.type === "result" &&
						index < messages.length - 1
					) {
						resultHeld = true;
						await waitForRelease();
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
				return undefined;
			},
			close: () => {
				interrupted = true;
				aborted.abort();
			},
			// Settings the runtime syncs before each turn; traces are fixed.
			setModel: async () => {},
			setPermissionMode: async (mode: PermissionMode) => {
				permissionMode = mode;
			},
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

	/** Each agent's latest transcript read reached so far in the session. */
	const reachedReads = (parentSessionId: string) => {
		knownSession(parentSessionId);
		const latest = new Map<string, readonly SessionMessage[]>();
		for (const turn of playedTurns.get(parentSessionId) ?? [])
			for (const read of turn.reads)
				if (read.afterMessage <= turn.played)
					latest.set(read.agentId, read.messages);
		return latest;
	};

	return {
		sdk: {
			query,
			subagentSdk: {
				listSubagents: async (parentSessionId) => [
					...reachedReads(parentSessionId).keys(),
				],
				getSubagentMessages: async (parentSessionId, agentId) => [
					...(reachedReads(parentSessionId).get(agentId) ?? []),
				],
			},
			fork: {
				readTranscript: async (parentSessionId) => [
					...knownSession(parentSessionId),
				],
				// Like the SDK: copy through upToMessageId inclusive, or everything.
				forkSession: async (parentSessionId, { upToMessageId }) => {
					const transcript = knownSession(parentSessionId);
					const end =
						upToMessageId === undefined
							? transcript.length
							: transcript.findIndex((entry) => entry.uuid === upToMessageId) +
								1;
					if (end === 0)
						throw new Error(
							`Claude trace replay: ${upToMessageId} is not in session ${parentSessionId}`,
						);
					const fork = { ...forkTrace.forkSession, sessionId: randomUUID() };
					sessionIds.add(fork.sessionId);
					transcripts.set(
						fork.sessionId,
						transcript
							.slice(0, end)
							.map((entry) => ({ ...entry, session_id: fork.sessionId })),
					);
					forks.push({
						parentSessionId,
						sessionId: fork.sessionId,
						...(upToMessageId !== undefined && { upToMessageId }),
					});
					return fork;
				},
			},
			// Session-title generation: a fixed title, never a model call.
			titleQuery: async function* () {
				yield { type: "result", result: "Claude trace replay" };
			},
		},
		sentPermissionModes,
		forks,
		transcript: (sessionId) => transcripts.get(sessionId) ?? [],
		release,
		held,
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
