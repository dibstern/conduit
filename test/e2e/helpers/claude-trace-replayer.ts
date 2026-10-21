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
//
// A trace's agent transcript reads (<name>.subagent-reads.json, captured
// alongside it) are served by subagentSdk as they were read at that point of
// the trace, with the same fresh ids as the replayed stream.

import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
	SDKControlInitializeResponse,
	SDKControlInterruptResponse,
	SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
	| "background-shell-during-next-turn"
	| "background-shell-during-next-turn-metadata-only"
	| "background-shell-ends-between-turns"
	| "background-shell-turn"
	| "concurrent-background-work-after-restart-turn"
	| "concurrent-background-work-turn"
	| "enter-worktree-turn"
	| "exit-worktree-keep-turn"
	| "extra-folder-read-turn"
	| "foreground-agent-backgrounded-turn"
	| "pong-thinking-text-turn"
	| "second-input-held-to-turn-end"
	| "queued-input-promoted-to-steer"
	| "side-thread-ask-turn"
	| "side-thread-compacting-turn"
	| "skill-loads-turn"
	| "steer-during-tool-folds"
	| "steer-misses-boundary"
	| "stop-with-steer-pending"
	| "subagent-task-error-turn"
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
	 * Hold whatever a trace carries after its first `result` (a background
	 * task ending after its turn) until release(). Live, real time passes
	 * there; replayed, the test decides when.
	 */
	readonly holdAfterResult?: boolean;
	/** Deliver agent steps only through captured transcript reads, exercising feeds. */
	readonly transcriptOnlySubagents?: boolean;
	/**
	 * Hold each played trace (1-based, counted across sessions) before its
	 * message-th line (1-based) until release(), e.g. mid-way through background work.
	 */
	readonly holdBefore?:
		| { readonly turn: number; readonly message: number }
		| readonly { readonly turn: number; readonly message: number }[];
	/** End the SDK stream after its trace, rather than awaiting another prompt. */
	readonly endAfterTrace?: boolean;
	/** Delay this agent's transcript reads once the trace reaches this line. */
	readonly holdSubagentReadAfter?: {
		readonly turn: number;
		readonly message: number;
		readonly agentId: string;
	};
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
	/**
	 * Open the session on this named Claude account (declared in daemon.json)
	 * instead of the default `claude` instance.
	 */
	readonly instanceId?: string;
	/** Trace directory override (unit tests only). */
	readonly tracesDir?: string;
	/** Fixture-owned Claude directory; never infer a writable path from HOME. */
	readonly transcriptConfigDir?: string;
	/** Claude model catalog to advertise instead of the bare trace model. */
	readonly models?: readonly ModelInfo[];
}

export interface ClaudeTraceReplayer {
	/** Pass as `claudeSdk` to createRelayStack. */
	readonly sdk: NonNullable<ProjectRelayConfig["claudeSdk"]> & {
		readonly subagentSdk: ClaudeSubagentSdk;
	};
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
	/** Opens the next hold the replay reaches (or has reached): one per hold. */
	release(): void;
	/** Resolves once the replay waits at a hold not yet released. */
	held(): Promise<void>;
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

/** An agent's transcript as the capture read it, after `afterMessage` trace lines. */
interface TranscriptRead {
	readonly afterMessage: number;
	readonly agentId: string;
	readonly messages: readonly SessionMessage[];
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
	const readsFile = join(dir, `${name}.subagent-reads.json`);
	const reads: readonly TranscriptRead[] = existsSync(readsFile)
		? JSON.parse(readFileSync(readsFile, "utf8"))
		: [];
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
	const stamps = lines.flatMap((line) => {
		const timestamp: unknown = JSON.parse(line).timestamp;
		return typeof timestamp === "string" ? [Date.parse(timestamp)] : [];
	});
	return {
		name,
		lines,
		initialization: messages.find(
			(
				message,
			): message is Extract<SDKMessage, { type: "system"; subtype: "init" }> =>
				message.type === "system" && message.subtype === "init",
		),
		/** The capture's first wall-clock stamp, if it recorded any. */
		capturedAt: stamps[0],
		reads,
		holds,
		inputIds,
		interrupts,
		/** Older traces record no input id; they still answer one prompt. */
		inputCount: Math.max(1, inputIds.length),
		/** Only a one-input trace without a recorded interrupt may be cut short. */
		strict: inputIds.length > 1 || interrupts > 0,
		ids: [
			...new Set([
				...messages.flatMap(envelopeIds),
				...reads.flatMap((read) => read.messages.map((entry) => entry.uuid)),
			]),
		].filter((id) => !inputIds.includes(id)),
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
	let played = 0;
	let failure: Error | undefined;
	const fail = (message: string): Error => {
		const error = new Error(`Claude trace replay: ${message}`);
		failure ??= error;
		return error;
	};
	// Holds open in the order the replay reaches them, one per release().
	let releases = 0;
	let holdsReached = 0;
	let resultHeld = false;
	const onRelease: (() => void)[] = [];
	const onHold: (() => void)[] = [];
	let subagentReadHold: Promise<void> | undefined;
	const release = () => {
		releases += 1;
		for (const wake of onRelease.splice(0)) wake();
	};
	const held = () =>
		holdsReached > releases
			? Promise.resolve()
			: new Promise<void>((resolve) => onHold.push(resolve));

	const query: ClaudeTraceReplayer["sdk"]["query"] = ({
		prompt,
		options,
		configDir,
	}) => {
		const nativeFork = options?.forkSession === true;
		const requestedSessionId = nativeFork
			? options?.sessionId
			: (options?.resume ?? sessionId);
		if (!requestedSessionId)
			throw fail("native fork requires a child sessionId");
		const querySessionId = requestedSessionId;
		if (nativeFork) {
			if (!options?.resume) throw fail("native fork requires a parent resume");
			knownSession(options.resume);
			if (sessionIds.has(querySessionId))
				throw fail(`fork session ${querySessionId} already exists`);
			sessionIds.add(querySessionId);
		} else {
			// A replacement process can begin by resuming its persisted parent.
			if (sent === 0 && options?.resume) sessionIds.add(querySessionId);
			knownSession(querySessionId);
		}
		let transcriptFile: string | undefined;
		if (plan.transcriptConfigDir !== undefined) {
			const cwd = options?.cwd;
			if (
				configDir.path !== plan.transcriptConfigDir ||
				options?.env?.["CLAUDE_CONFIG_DIR"] !== plan.transcriptConfigDir ||
				!cwd
			)
				throw fail(
					"query must use the fixture's Claude config directory and cwd",
				);
			transcriptFile = join(
				plan.transcriptConfigDir,
				"projects",
				realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-"),
				`${querySessionId}.jsonl`,
			);
			mkdirSync(dirname(transcriptFile), { recursive: true });
		}
		const capturedInit = traces[played]?.initialization;
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
		const record = (message: SessionMessage) => {
			if (transcriptFile)
				appendFileSync(transcriptFile, `${JSON.stringify(message)}\n`);
			transcript.push(message);
		};
		let initialization: Promise<SDKControlInitializeResponse> | undefined;
		const initialize = (): Promise<SDKControlInitializeResponse> => {
			initialization ??= Promise.resolve()
				.then((): SDKControlInitializeResponse => {
					if (!capturedInit) throw fail("query has no captured system/init");
					if (nativeFork) {
						if (!options?.resume || !transcriptFile)
							throw fail(
								"native fork requires fixture-owned transcript storage",
							);
						const parent = knownSession(options.resume);
						const cut = options.resumeSessionAt;
						const end =
							cut === undefined
								? parent.length
								: parent.findIndex((message) => message.uuid === cut) + 1;
						if (end === 0)
							throw fail(
								`native fork boundary ${cut} is not in ${options.resume}`,
							);
						const inherited = parent.slice(0, end).map((message) => ({
							...message,
							session_id: querySessionId,
						}));
						// Readiness establishes the full child transcript before intake.
						writeFileSync(
							transcriptFile,
							`${inherited.map((message) => JSON.stringify(message)).join("\n")}\n`,
							{ flag: "wx" },
						);
						transcript.push(...inherited);
						forks.push({
							parentSessionId: options.resume,
							sessionId: querySessionId,
							...(cut !== undefined && { upToMessageId: cut }),
						});
					}
					// Init captures names, but no descriptions or account credentials.
					return {
						commands: capturedInit.slash_commands.map((name) => ({
							name,
							description: "",
							argumentHint: "",
						})),
						agents: (capturedInit.agents ?? []).map((name) => ({
							name,
							description: "",
						})),
						models: [
							{
								value: capturedInit.model,
								displayName: capturedInit.model,
								description: "",
							},
						],
						output_style: capturedInit.output_style,
						available_output_styles: [capturedInit.output_style],
						account: { apiKeySource: capturedInit.apiKeySource },
						claude_code_version: capturedInit.claude_code_version,
					};
				})
				.catch((cause: unknown) => {
					throw fail(cause instanceof Error ? cause.message : String(cause));
				});
			return initialization;
		};
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
			record(entry("user", userPrompt.message));
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
			if (nativeFork) await initialize();
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
				// SDK epoch fields (task_updated end_time) come from the capture's
				// clock. Shift them into replay time, keeping their distance from the
				// capture's start, as live they share the machine clock with conduit.
				const clockShift =
					trace.capturedAt === undefined ? 0 : Date.now() - trace.capturedAt;
				const fresh = freshIds(trace, querySessionId);
				const remapIds = (json: string) =>
					[
						...fresh,
						...trace.inputIds.flatMap((id, input) => {
							const to = current.sentIds[input];
							return to ? [[id, to] as const] : [];
						}),
					].reduce(
						(text, [from, to]) => text.replaceAll(`"${from}"`, `"${to}"`),
						json,
					);
				const transcriptTurn = {
					get reads(): readonly TranscriptRead[] {
						return JSON.parse(remapIds(JSON.stringify(trace.reads)));
					},
					played: 0,
				};
				playedTurns.set(querySessionId, [
					...(playedTurns.get(querySessionId) ?? []),
					transcriptTurn,
				]);
				// Older captures omit the start signal for the input they consume.
				if (trace.inputIds.length === 0)
					yield decodeClaudeSDKMessage({
						type: "command_lifecycle",
						state: "started",
						command_uuid: current.sentIds[0],
						uuid: randomUUID(),
						session_id: querySessionId,
					});
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
					const decoded = decodeClaudeSDKMessage(JSON.parse(remapIds(line)));
					const message =
						decoded.type === "system" &&
						decoded.subtype === "task_updated" &&
						decoded.patch.end_time !== undefined
							? {
									...decoded,
									patch: {
										...decoded.patch,
										end_time: decoded.patch.end_time + clockShift,
									},
								}
							: decoded;
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
					if (
						[plan.holdBefore ?? []]
							.flat()
							.some((hold) => hold.turn === turn && hold.message === index + 1)
					)
						await waitForRelease();
					if (interrupted) break;
					// Counted before the yield: the consumer reads transcripts while
					// this generator is suspended there.
					transcriptTurn.played = index + 1;
					if (
						plan.transcriptOnlySubagents &&
						(message.type === "assistant" ||
							message.type === "user" ||
							message.type === "stream_event") &&
						message.parent_tool_use_id != null
					)
						continue;
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
						record(entry(message.type, message.message, message.uuid));
					if (
						plan.holdAfterResult &&
						!resultHeld &&
						message.type === "result" &&
						index < trace.lines.length - 1
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
				playing = undefined;
				if (plan.endAfterTrace) return;
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
			// Unrecorded pre-warms keep the existing unsupported-control behavior.
			initializationResult:
				nativeFork || capturedInit
					? initialize
					: unsupported("initializationResult"),
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
				getSubagentMessages: async (parentSessionId, agentId) => {
					const hold = plan.holdSubagentReadAfter;
					if (
						hold?.agentId === agentId &&
						hold.turn === played &&
						(playedTurns.get(parentSessionId)?.at(-1)?.played ?? 0) >=
							hold.message
					) {
						subagentReadHold ??= (async () => {
							const reached = ++holdsReached;
							for (const notify of onHold.splice(0)) notify();
							while (releases < reached)
								await new Promise<void>((resolve) => onRelease.push(resolve));
						})();
						await subagentReadHold;
					}
					return [...(reachedReads(parentSessionId).get(agentId) ?? [])];
				},
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
		held,
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
