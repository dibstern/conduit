// Claude SDK trace replayer (E2E Claude lane)
// Plays committed Claude Agent SDK traces (test/fixtures/claude-sdk-traces,
// real captured wire traffic — see docs/adr/0002) through the Claude runtime's
// injected queryFactory. Failure modes are listed and pinned in
// test/unit/e2e/claude-trace-replayer.test.ts.
//
// A trace records one or more inputs (command_lifecycle command_uuid,
// user_message_uuid(s)); older traces record none and count as one. Each sent
// prompt answers the next recorded input in plan order: the first starts its
// trace, and each later one releases the hold before that input's
// command_lifecycle queued frame. Every occurrence of a recorded input id
// becomes the uuid conduit sent for it, so the runtime settles and places it.
// A trace that records an interrupt (the SDK's "[Request interrupted by user"
// user frame) holds before it until interrupt(), which resolves with the
// receipt the trace implies: the inputs queued and not yet started there.
//
// Per replayed trace, envelope ids (uuid, assistant message.id, message_start
// message.id) are fresh so the translator's dedupe never swallows a repeated
// turn; session_id stays stable within each session, including resumed forks.
// Content, including tool_use/task ids, is untouched — plan a trace that
// carries tools at most once per session.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
	SDKControlInterruptResponse,
	SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { decodeClaudeSDKMessage } from "../../../src/lib/contracts/providers/claude-agent-sdk.js";
import type { ClaudeSessionForkSdk } from "../../../src/lib/provider/claude/claude-session-fork.js";
import type {
	PermissionMode,
	SDKMessage,
} from "../../../src/lib/provider/claude/types.js";
import type { ModelInfo } from "../../../src/lib/provider/types.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";

export type ClaudeTraceName =
	| "api-retry-pong-turn"
	| "background-shell-turn"
	| "enter-worktree-turn"
	| "exit-worktree-keep-turn"
	| "extra-folder-read-turn"
	| "pong-thinking-text-turn"
	| "second-input-held-to-turn-end"
	| "queued-input-promoted-to-steer"
	| "side-thread-plan-turn"
	| "skill-loads-turn"
	| "steer-during-tool-folds"
	| "steer-misses-boundary"
	| "stop-with-steer-pending"
	| "subagent-task-turn"
	| "two-steers-one-boundary";

export interface ClaudeReplayPlan {
	/** Committed traces in send order; each answers as many prompts as it
	 *  records inputs (at least one). */
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
	/**
	 * Hold this played trace (1-based, counted across sessions) before its
	 * first tool_result until release(), leaving the tool call running.
	 */
	readonly holdTurnBeforeToolResult?: number;
	/**
	 * Plan indexes (0-based) of turns whose result reports an upstream failure:
	 * a success result with is_error, the shape the SDK gives an API error that
	 * outlasted its retries.
	 */
	readonly failTurns?: readonly number[];
	/** Trace directory override (unit tests only). */
	readonly tracesDir?: string;
	/** Claude model catalog to advertise instead of the bare trace model. */
	readonly models?: readonly ModelInfo[];
}

export interface ClaudeTraceReplayer {
	/** Pass as `claudeSdk` to createRelayStack. */
	readonly sdk: NonNullable<ProjectRelayConfig["claudeSdk"]>;
	/** The permission mode the runtime requested for each sent prompt, in order. */
	readonly sentPermissionModes: readonly (PermissionMode | undefined)[];
	/** Every fork, in call order; upToMessageId is the inclusive cut uuid. */
	readonly forks: readonly {
		readonly parentSessionId: string;
		readonly sessionId: string;
		readonly upToMessageId?: string;
	}[];
	/** The session's transcript as replayed: prompts and main-chain messages. */
	transcript(sessionId: string): readonly SessionMessage[];
	/** Lets a holdAfterResult or holdTurnBeforeToolResult replay continue. */
	release(): void;
	/** Throws unless every recorded input was sent and nothing failed. */
	assertComplete(): void;
}

const TRACES_DIR = join(
	import.meta.dirname,
	"../../fixtures/claude-sdk-traces",
);

function recordedInputIds(message: SDKMessage): readonly string[] {
	if (message.type === "command_lifecycle") return [message.command_uuid];
	if (message.type === "result")
		return [
			...(message.user_message_uuid ? [message.user_message_uuid] : []),
			...(message.user_message_uuids ?? []),
		];
	return [];
}

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

const INTERRUPTED = "[Request interrupted by user";

function isInterruptMarker(message: SDKMessage): boolean {
	if (message.type !== "user") return false;
	const { content } = message.message;
	return typeof content === "string"
		? content.startsWith(INTERRUPTED)
		: content.some(
				(block) => block.type === "text" && block.text.startsWith(INTERRUPTED),
			);
}

/** Where a replay waits: for the prompt answering a later recorded input, or
 *  for interrupt(), which it answers with the inputs still queued there. */
type Hold =
	| { readonly kind: "input"; readonly input: number }
	| { readonly kind: "interrupt"; readonly stillQueued: readonly number[] };

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
	const inputIds = [...new Set(messages.flatMap(recordedInputIds))];
	const holds = new Map<number, Hold>();
	for (const [input, id] of inputIds.entries()) {
		if (input === 0) continue;
		const first = lines.findIndex((line) => line.includes(`"${id}"`));
		const queued = messages[first];
		if (queued?.type !== "command_lifecycle" || queued.state !== "queued") {
			throw new Error(
				`Claude trace replay: ${file}:${first + 1} references recorded input ${input + 1} before its command_lifecycle queued frame, so its id would be mapped out of order`,
			);
		}
		holds.set(first, { kind: "input", input });
	}
	for (const [index, message] of messages.entries()) {
		if (!isInterruptMarker(message)) continue;
		// The abort's own user frames (a cancelled tool's result) lead up to it.
		let start = index;
		while (messages[start - 1]?.type === "user") start -= 1;
		const states = (id: string) =>
			messages
				.slice(0, start)
				.flatMap((m) =>
					m.type === "command_lifecycle" && m.command_uuid === id
						? [m.state]
						: [],
				);
		holds.set(start, {
			kind: "interrupt",
			stillQueued: inputIds.flatMap((id, input) => {
				const seen = states(id);
				return seen.length > 0 && seen.every((state) => state === "queued")
					? [input]
					: [];
			}),
		});
	}
	const interrupts = [...holds.values()].filter(
		(hold) => hold.kind === "interrupt",
	).length;
	return {
		name,
		lines,
		holds,
		inputIds,
		interrupts,
		/** Older traces record no input id; they still answer one prompt. */
		inputCount: Math.max(1, inputIds.length),
		/** Only a one-input trace without a recorded interrupt may be cut short. */
		strict: inputIds.length > 1 || interrupts > 0,
		ids: [...new Set(messages.flatMap(envelopeIds))].filter(
			(id) => !inputIds.includes(id),
		),
		sessionIds: [
			...new Set(messages.flatMap((message) => message.session_id ?? [])),
		],
	};
}

type Trace = ReturnType<typeof loadTrace>;

/** Fresh envelope ids for one replay of a trace, and the replayer's session. */
function freshIds(trace: Trace, sessionId: string): [string, string][] {
	return [
		...trace.ids.map((id): [string, string] => [
			id,
			id.startsWith("msg_") ? `msg_${randomUUID()}` : randomUUID(),
		]),
		...trace.sessionIds.map((id): [string, string] => [id, sessionId]),
	];
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
	const recordedInput = (input: number, traceIndex: number) =>
		`recorded input ${input + 1} of trace ${traceIndex + 1} (${traces[traceIndex]?.name})`;
	const plannedInputs = traces.flatMap((trace, traceIndex) =>
		Array.from({ length: trace.inputCount }, (_, input) =>
			recordedInput(input, traceIndex),
		),
	);
	const sessionId = randomUUID();
	const sessionIds = new Set<string>([sessionId]);
	const transcripts = new Map<string, SessionMessage[]>();
	const forks: ClaudeTraceReplayer["forks"][number][] = [];
	const knownSession = (sessionId: string) => {
		if (!sessionIds.has(sessionId))
			throw new Error(`Claude trace replay: unknown session ${sessionId}`);
		return transcripts.get(sessionId) ?? [];
	};
	let sent = 0;
	const sentPermissionModes: (PermissionMode | undefined)[] = [];
	let played = 0;
	let failure: Error | undefined;
	const fail = (message: string): Error => {
		const error = new Error(`Claude trace replay: ${message}`);
		failure ??= error;
		return error;
	};
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});

	const query: ClaudeTraceReplayer["sdk"]["query"] = ({ prompt, options }) => {
		const querySessionId = options?.resume ?? sessionId;
		// A replacement process can begin by resuming its persisted parent.
		if (sent === 0 && options?.resume) sessionIds.add(querySessionId);
		if (!sessionIds.has(querySessionId))
			throw new Error(`Claude trace replay: unknown session ${querySessionId}`);
		const prompts = prompt[Symbol.asyncIterator]();
		const closed = new AbortController();
		const whenClosed = new Promise<"closed">((resolve) =>
			closed.signal.addEventListener("abort", () => resolve("closed"), {
				once: true,
			}),
		);
		let interrupted = false;
		let aborted = new AbortController();
		let permissionMode = options?.permissionMode;

		const waitForRelease = async () => {
			// Only this query's own stop may cut a hold short: the runtime also
			// opens and closes spare (pre-warmed) queries.
			const { signal } = aborted;
			if (!signal.aborted)
				await Promise.race([
					held,
					new Promise((resolve) =>
						signal.addEventListener("abort", resolve, { once: true }),
					),
				]);
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
		const promptSent = (userPrompt: { readonly message: unknown }) => {
			sent += 1;
			sentPermissionModes.push(permissionMode);
			transcript.push(entry("user", userPrompt.message));
		};
		let playing:
			| {
					readonly trace: Trace;
					/** Sent prompt uuid per recorded input, filled as prompts arrive. */
					readonly sentIds: string[];
					readonly interrupts: ((
						receipt: SDKControlInterruptResponse,
					) => void)[];
					asked: number;
					wake?: () => void;
			  }
			| undefined;

		async function* replay(): AsyncGenerator<SDKMessage, void> {
			while (true) {
				const first = await prompts.next();
				if (first.done) return;
				promptSent(first.value);
				const trace = traces[played];
				if (!trace) {
					throw fail(
						`prompt ${sent} was sent, but no recorded input matches it (the plan records ${plannedInputs.length})`,
					);
				}
				played += 1;
				const turn = played;
				let heldBeforeToolResult = false;
				interrupted = false;
				aborted = new AbortController();
				const current: NonNullable<typeof playing> = {
					trace,
					sentIds: [first.value.uuid ?? randomUUID()],
					interrupts: [],
					asked: 0,
				};
				playing = current;
				const fresh = freshIds(trace, querySessionId);
				for (const [index, line] of trace.lines.entries()) {
					const hold = trace.holds.get(index);
					if (hold?.kind === "input") {
						const next = await Promise.race([prompts.next(), whenClosed]);
						if (next === "closed" || next.done) {
							fail(
								`${recordedInput(hold.input, played - 1)} was never sent: the query closed while the replay held for it`,
							);
							return;
						}
						promptSent(next.value);
						current.sentIds[hold.input] = next.value.uuid ?? randomUUID();
					}
					if (hold?.kind === "interrupt") {
						while (current.interrupts.length === 0) {
							const woken = await Promise.race([
								new Promise<void>((resolve) => {
									current.wake = resolve;
								}),
								whenClosed,
							]);
							if (woken === "closed") return;
						}
						current.interrupts.shift()?.({
							still_queued: hold.stillQueued.map(
								(input) => current.sentIds[input] ?? "",
							),
						});
					}
					if (plan.delayMs) await sleep(plan.delayMs);
					if (interrupted) break;
					const replacements = [
						...fresh,
						...trace.inputIds.flatMap((id, input) => {
							const to = current.sentIds[input];
							return to ? [[id, to] as const] : [];
						}),
					];
					const message = decodeClaudeSDKMessage(
						JSON.parse(
							replacements.reduce(
								(text, [from, to]) => text.replaceAll(`"${from}"`, `"${to}"`),
								line,
							),
						),
					);
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
						if (interrupted) break;
					}
					yield plan.failTurns?.includes(turn - 1) &&
					message.type === "result" &&
					message.subtype === "success"
						? {
								...message,
								is_error: true,
								result: "API Error: 529 overloaded",
							}
						: message;
					if (
						(message.type === "user" || message.type === "assistant") &&
						message.parent_tool_use_id === null
					)
						transcript.push(entry(message.type, message.message, message.uuid));
					if (
						plan.holdAfterResult &&
						message.type === "result" &&
						index < trace.lines.length - 1
					) {
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
				playing = undefined;
			}
		}

		return Object.assign(replay(), {
			// A trace's recorded interrupt is answered with the receipt it implies.
			// Otherwise Stop mid-turn drops the rest of a one-input trace: the
			// runtime persists turn.interrupted itself and ignores any
			// post-interrupt result, so no SDK error result is synthesized here.
			interrupt: async (): Promise<SDKControlInterruptResponse | undefined> => {
				const current = playing;
				if (current && current.asked < current.trace.interrupts) {
					current.asked += 1;
					return new Promise((resolve) => {
						current.interrupts.push(resolve);
						current.wake?.();
					});
				}
				if (current?.trace.strict) {
					throw fail(
						`interrupt() arrived during ${current.trace.name}, which records no further interrupt`,
					);
				}
				interrupted = true;
				aborted.abort();
				return undefined;
			},
			close: () => {
				interrupted = true;
				aborted.abort();
				closed.abort();
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

	return {
		sdk: {
			query,
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
					// Read on first fork, so a plan's tracesDir need not carry it.
					const forkTrace = JSON.parse(
						readFileSync(
							join(plan.tracesDir ?? TRACES_DIR, "fork-session.json"),
							"utf8",
						),
					) as {
						forkSession: Awaited<
							ReturnType<ClaudeSessionForkSdk["forkSession"]>
						>;
					};
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
		assertComplete() {
			if (failure) throw failure;
			const unsent = plannedInputs[sent];
			if (unsent) {
				throw new Error(
					`Claude trace replay: ${unsent} was never sent (${sent} of ${plannedInputs.length} planned inputs were sent)`,
				);
			}
		},
	};
}
