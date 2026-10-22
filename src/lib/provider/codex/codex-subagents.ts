import { Deferred, Effect } from "effect";
import type {
	ProviderRuntimeEventPayloadMap,
	ProviderRuntimeEventType,
} from "../../contracts/providers/provider-runtime-event.js";
import { createEventId } from "../../persistence/events.js";
import type { SessionPermissionMode } from "../../shared-types.js";
import {
	type EventSinkError,
	EventSinkIngestionError,
} from "../event-sink-errors.js";
import type { RunnerSinkBindings } from "../runner/runner-sink-bindings.js";
import type { SessionOutput } from "../runner/session-runner.js";
import type { EventSink } from "../types.js";
import type { KnownNotification } from "./app-server/protocol.js";
import { CodexInteractions } from "./codex-interactions.js";
import {
	codexRuntimeEvent,
	codexSubagentSessionId,
	mapCodexItem,
} from "./codex-item-mapper.js";
import {
	acceptCodexTurn,
	type CodexTurnState,
	completeCodexTurn,
	createCodexTurnState,
	failCodexTurn,
	handleCodexTurnNotification,
	interruptCodexTurn,
} from "./codex-turn-lifecycle.js";

interface TurnOwner {
	readonly get: () => CodexTurnState;
	readonly set: (state: CodexTurnState) => void;
	readonly sink: EventSink;
	readonly permissionMode: SessionPermissionMode | undefined;
	readonly rootRunId?: string | undefined;
	readonly rootTurnId?: string | undefined;
}

interface ChildThread {
	readonly sessionId: string;
	readonly parentSessionId: string;
	owner: TurnOwner;
	turn: { state: CodexTurnState };
	state: CodexTurnState;
	interactions: CodexInteractions;
	retained: boolean;
	readonly userItems: Set<string>;
	callId?: string;
	model?: string;
	result: string;
	outcome?: "completed" | "interrupted" | "error";
}

/** Native threads share one app-server; only their interaction cards use the parent sink. */
export class CodexSubagents {
	private readonly children = new Map<string, ChildThread>();
	private readonly pending = new Map<string, KnownNotification[]>();
	private readonly registrations = new Map<
		string,
		Deferred.Deferred<ChildThread, Error>
	>();
	private readonly owners = new Map<string, TurnOwner>();
	private parent?: TurnOwner;
	private stopping = false;

	constructor(
		private readonly parentSessionId: string,
		private readonly ensure: (
			input: Extract<
				SessionOutput,
				{ type: "ensure-subagent-session" }
			>["input"],
			sink: EventSink,
		) => Effect.Effect<void, EventSinkError>,
		private readonly sinks: RunnerSinkBindings,
		private readonly instanceId: string | undefined,
	) {}

	attach(owner: TurnOwner) {
		this.parent = {
			...owner,
			rootRunId: owner.get().items.runId,
			rootTurnId: owner.get().items.turnId,
		};
		this.stopping = false;
	}

	beginInterrupt() {
		this.stopping = true;
	}

	get runningTurns() {
		return [...this.children].flatMap(([threadId, child]) =>
			!child.state.settled && child.state.executingTurnId
				? [{ threadId, turnId: child.state.executingTurnId }]
				: [],
		);
	}

	get hasRunning(): boolean {
		return [...this.children.values()].some((child) => !child.state.settled);
	}

	request(
		method: string,
		params: unknown,
		id: string | number,
	): Effect.Effect<unknown, unknown> | undefined {
		const threadId =
			params !== null && typeof params === "object" && "threadId" in params
				? params.threadId
				: undefined;
		if (
			typeof threadId !== "string" ||
			threadId === this.parent?.get().items.threadId
		)
			return undefined;
		return Effect.gen({ self: this }, function* () {
			let child = this.children.get(threadId);
			if (!child) {
				child = yield* this.awaitRegistration(threadId);
			}
			const turnId =
				params !== null && typeof params === "object" && "turnId" in params
					? params.turnId
					: undefined;
			if (
				typeof turnId === "string" &&
				child.state.items.nativeTurnId !== turnId
			)
				child = yield* this.awaitRegistration(`${threadId}\0${turnId}`);
			return yield* child.interactions.request(method, params, id) ??
				Effect.fail(new Error(`Unsupported child request: ${method}`));
		});
	}

	handle(
		notification: KnownNotification,
	): Effect.Effect<boolean, EventSinkError> {
		return Effect.gen({ self: this }, function* () {
			if (!this.parent) return false;
			if (notification.method === "thread/started") {
				const { thread } = notification.params;
				const source = thread.source;
				if (
					source &&
					typeof source === "object" &&
					typeof source.subAgent === "object" &&
					"thread_spawn" in source.subAgent
				) {
					const parentThreadId = source.subAgent.thread_spawn.parent_thread_id;
					const owner = this.owner(parentThreadId);
					if (owner)
						yield* this.ensureChild(
							thread.id,
							owner,
							thread.model ?? undefined,
						);
				}
				return false;
			}
			if (!("threadId" in notification.params)) return false;
			const { threadId } = notification.params;
			if (!threadId) return false;
			const owner = this.owner(
				threadId,
				"turnId" in notification.params
					? (notification.params.turnId ?? undefined)
					: undefined,
			);
			if (
				(notification.method === "item/started" ||
					notification.method === "item/completed") &&
				owner
			) {
				const { item } = notification.params;
				if (!("raw" in item) && item.type === "collabAgentToolCall") {
					if (item.tool === "spawnAgent") {
						const [items, events] = mapCodexItem(
							{ ...owner.get().items, now: Date.now() },
							notification,
						);
						owner.set({ ...owner.get(), items });
						for (const event of events) yield* owner.sink.push(event);
					}
					for (const receiver of new Set([
						...item.receiverThreadIds,
						...Object.keys(item.agentsStates),
					])) {
						let child = this.children.get(receiver);
						if (!child && item.tool === "spawnAgent")
							child = yield* this.ensureChild(
								receiver,
								owner,
								item.model ?? undefined,
								item.prompt ?? undefined,
							);
						if (!child) continue;
						if (item.tool === "spawnAgent") child.callId = item.id;
						const status = item.agentsStates[receiver];
						if (status?.message) child.result = status.message;
						if (
							status &&
							[
								"completed",
								"interrupted",
								"errored",
								"shutdown",
								"notFound",
							].includes(status.status) &&
							!child.state.settled
						) {
							// A status can precede the child's own terminal. Keep streaming
							// that terminal so its transcript and native turn refs persist.
							yield* this.card(
								child,
								status.status === "completed"
									? "completed"
									: status.status === "errored" || status.status === "notFound"
										? "error"
										: "interrupted",
							);
							if (!child.state.items.nativeTurnId) {
								const update =
									status.status === "completed"
										? completeCodexTurn(child.state)
										: status.status === "errored" ||
												status.status === "notFound"
											? failCodexTurn(
													child.state,
													"provider_error",
													status.message ?? "Codex child failed",
													Date.now(),
												)
											: interruptCodexTurn(child.state, Date.now());
								child.state = update.state;
								for (const event of update.events)
									yield* child.owner.sink.push(event);
								yield* this.push(child, "session.status", {
									sessionId: child.sessionId,
									status: "idle",
								});
								yield* child.interactions.interrupt();
								yield* this.release(child);
							}
						} else yield* this.card(child);
					}
					return true;
				}
				if (!("raw" in item) && item.type === "subAgentActivity") {
					const child =
						this.children.get(item.agentThreadId) ??
						(item.kind === "started"
							? yield* this.ensureChild(
									item.agentThreadId,
									owner,
									item.model ?? undefined,
								)
							: undefined);
					if (child)
						yield* this.card(
							child,
							item.kind === "completed"
								? "completed"
								: item.kind === "interrupted"
									? "interrupted"
									: undefined,
						);
					return true;
				}
			}
			const child = this.children.get(threadId);
			if (!child) {
				if (!owner && threadId !== this.parent.get().items.threadId) {
					// A fast child may emit before spawnAgent supplies its receiver ID.
					const queued = this.pending.get(threadId) ?? [];
					queued.push(notification);
					this.pending.set(threadId, queued);
					return true;
				}
				return false;
			}
			if (notification.method === "serverRequest/resolved") {
				yield* child.interactions.resolve(notification.params.requestId);
				return true;
			}
			if (notification.method === "turn/started") {
				if (child.state.settled) {
					if (
						this.stopping ||
						child.state.items.nativeTurnId === notification.params.turn.id
					)
						return true;
					child.owner = {
						...child.owner,
						sink: this.parent.sink,
						rootRunId: this.parent.rootRunId,
						rootTurnId: this.parent.rootTurnId,
					};
					this.sinks.retainSink(child.owner.sink);
					child.retained = true;
					child.turn = { state: this.newState(child.sessionId, threadId) };
					delete child.outcome;
					child.result = "";
					child.userItems.clear();
					child.interactions = this.interactions(child.owner, () => child);
					yield* this.card(child);
				}
				const firstStart = child.state.acceptedTurnId === undefined;
				child.state = acceptCodexTurn(
					child.state,
					notification.params.turn.id,
					Date.now(),
				);
				if (firstStart) {
					const runId = createEventId();
					child.state = {
						...child.state,
						items: { ...child.state.items, runId },
					};
					yield* this.begin(child);
				}
				const key = `${threadId}\0${notification.params.turn.id}`;
				const ready = this.registrations.get(key);
				this.registrations.delete(key);
				if (ready) yield* Deferred.succeed(ready, child);
			}
			if (
				(notification.method === "item/started" ||
					notification.method === "item/completed") &&
				notification.params.item.type === "userMessage" &&
				!("raw" in notification.params.item)
			) {
				const item = notification.params.item;
				if (!child.userItems.has(item.id)) {
					const first = child.userItems.size === 0;
					child.userItems.add(item.id);
					const messageId = first ? child.state.items.turnId : createEventId();
					if (!first)
						yield* this.push(child, "message.created", {
							sessionId: child.sessionId,
							messageId,
							role: "user",
						});
					yield* this.push(child, "text.delta", {
						messageId,
						partId: `${messageId}:text`,
						text: item.content
							.flatMap((part) => (part.type === "text" ? [part.text] : []))
							.join(""),
					});
				}
				return true;
			}
			const update = handleCodexTurnNotification(
				child.state,
				notification,
				Date.now(),
			);
			child.state = update.state;
			for (const event of update.events) yield* child.owner.sink.push(event);
			if (
				notification.method === "item/started" ||
				notification.method === "item/completed"
			)
				yield* child.interactions.itemMapped(notification.params.item.id);
			if (update.outcome) {
				child.result =
					child.state.items.parts
						.flatMap((part) => (part.kind === "text" ? [part.text] : []))
						.join("\n") ||
					update.outcome.error?.message ||
					child.result;
				yield* this.push(child, "session.status", {
					sessionId: child.sessionId,
					status: "idle",
				});
				yield* this.card(child, update.outcome.status);
				yield* child.interactions.interrupt();
				yield* this.release(child);
			}
			return true;
		}).pipe(Effect.mapError((cause) => new EventSinkIngestionError({ cause })));
	}

	interrupt(
		status: "interrupted" | "error" = "interrupted",
		message = "Codex app-server exited",
		ownerSink?: EventSink,
	) {
		return Effect.gen({ self: this }, function* () {
			if (this.stopping) status = "interrupted";
			if (!ownerSink) {
				for (const ready of this.registrations.values())
					yield* Deferred.fail(ready, new Error("Codex children interrupted"));
				this.registrations.clear();
			}
			const children = [...this.children.values()].filter(
				(child) => !ownerSink || child.owner.sink === ownerSink,
			);
			for (const child of children) {
				yield* child.interactions.interrupt();
				if (child.state.settled) {
					yield* this.release(child);
					continue;
				}
				const update =
					status === "error"
						? failCodexTurn(
								child.state,
								"provider_unavailable",
								message,
								Date.now(),
							)
						: interruptCodexTurn(child.state, Date.now());
				child.state = update.state;
				if (status === "error") child.result ||= message;
				for (const event of update.events) yield* child.owner.sink.push(event);
				yield* this.push(child, "session.status", {
					sessionId: child.sessionId,
					status: "idle",
				});
				yield* this.card(child, status);
				yield* this.release(child);
			}
		});
	}

	private release(child: ChildThread) {
		if (!child.retained) return Effect.void;
		child.retained = false;
		return this.sinks.releaseSinkEffect(child.owner.sink);
	}

	private awaitRegistration(key: string) {
		let ready = this.registrations.get(key);
		if (!ready) {
			ready = Deferred.makeUnsafe<ChildThread, Error>();
			this.registrations.set(key, ready);
		}
		return Deferred.await(ready).pipe(Effect.timeout("10 seconds"));
	}

	private interactions(
		owner: TurnOwner,
		read: () => ChildThread,
	): CodexInteractions {
		return new CodexInteractions(
			owner.sink,
			owner.permissionMode,
			() => ({
				...read().state.items,
				runId: owner.rootRunId,
				sessionId: this.parentSessionId,
				turnId: owner.rootTurnId ?? owner.get().items.turnId,
			}),
			(requestId, kind) =>
				this.sinks.withdrawInteraction(owner.sink, requestId, kind),
			(message, requestId) =>
				this.push(read(), "text.delta", {
					messageId: read().state.items.messageId,
					partId: `${read().state.items.messageId}:${requestId}:diagnostic`,
					text: message,
				}),
		);
	}

	private owner(threadId: string, turnId?: string): TurnOwner | undefined {
		const key = `${threadId}:${turnId}`;
		if (turnId && this.owners.has(key)) return this.owners.get(key);
		const child = this.children.get(threadId);
		const turn = child?.turn;
		const owner: TurnOwner | undefined =
			child && turn
				? {
						...child.owner,
						get: () => turn.state,
						set: (state) => {
							turn.state = state;
						},
					}
				: this.parent?.get().items.threadId === threadId
					? this.parent
					: undefined;
		const nativeTurn = owner?.get().items.nativeTurnId;
		if (turnId && nativeTurn && nativeTurn !== turnId) return undefined;
		if (turnId && owner) this.owners.set(key, owner);
		return owner;
	}

	private newState(sessionId: string, threadId: string) {
		return createCodexTurnState({
			sessionId,
			threadId,
			turnId: createEventId(),
			messageId: createEventId(),
			providerId: "codex",
			now: Date.now(),
		});
	}

	private ensureChild(
		threadId: string,
		owner: TurnOwner,
		model?: string,
		prompt?: string,
	): Effect.Effect<ChildThread, EventSinkError> {
		return Effect.gen({ self: this }, function* () {
			const existing = this.children.get(threadId);
			if (existing) return existing;
			const parentSessionId = owner.get().items.sessionId;
			const sessionId = codexSubagentSessionId(parentSessionId, threadId);
			const child: ChildThread = {
				sessionId,
				parentSessionId,
				owner,
				turn: { state: this.newState(sessionId, threadId) },
				get state() {
					return this.turn.state;
				},
				set state(state: CodexTurnState) {
					this.turn.state = state;
				},
				userItems: new Set(),
				result: "",
				retained: true,
				...(model ? { model } : {}),
				interactions: this.interactions(owner, () => child),
			};
			this.sinks.retainSink(owner.sink);
			this.children.set(threadId, child);
			const ready = this.registrations.get(threadId);
			this.registrations.delete(threadId);
			if (ready) yield* Deferred.succeed(ready, child);
			yield* this.ensure(
				{
					childSessionId: sessionId,
					parentSessionId,
					providerSessionId: threadId,
					title: prompt?.split("\n")[0]?.slice(0, 100) || "Codex subagent",
					...(this.instanceId ? { instanceId: this.instanceId } : {}),
					...(model ? { modelId: model } : {}),
				},
				owner.sink,
			);
			const unlinked = owner
				.get()
				.items.parts.filter(
					(part) =>
						part.kind === "tool" &&
						part.toolName === "Task" &&
						!part.metadata["childSessionId"],
				);
			if (unlinked.length === 1 && unlinked[0]) {
				child.callId = unlinked[0].itemId;
				yield* this.card(child);
			}
			const queued = this.pending.get(threadId) ?? [];
			this.pending.delete(threadId);
			for (const notification of queued) yield* this.handle(notification);
			return child;
		});
	}

	private begin(child: ChildThread) {
		return Effect.gen({ self: this }, function* () {
			const runId = child.state.items.runId;
			if (!runId) return;
			yield* this.push(child, "message.created", {
				sessionId: child.sessionId,
				messageId: child.state.items.turnId,
				role: "user",
			});
			yield* this.push(child, "run.started", {
				inputId: child.state.items.turnId,
				requestedRunId: runId,
			});
			yield* this.push(child, "session.status", {
				sessionId: child.sessionId,
				status: "busy",
			});
			yield* this.push(child, "message.created", {
				sessionId: child.sessionId,
				messageId: child.state.items.messageId,
				role: "assistant",
				parentID: child.state.items.turnId,
			});
		});
	}

	private push<
		K extends Exclude<ProviderRuntimeEventType, "workspace.changed">,
	>(child: ChildThread, type: K, data: ProviderRuntimeEventPayloadMap[K]) {
		return Effect.suspend(() => {
			const [items, event] = codexRuntimeEvent(
				{ ...child.state.items, now: Date.now() },
				type,
				data,
			);
			child.state = { ...child.state, items };
			return child.owner.sink.push(event);
		});
	}

	private card(
		child: ChildThread,
		status?: "completed" | "interrupted" | "error",
	) {
		return Effect.gen(function* () {
			if (!child.callId) return;
			const current = child.owner.get();
			const owner = {
				...current,
				items: { ...current.items, now: Date.now() },
			};
			const part = owner.items.parts.find(
				(part) => part.kind === "tool" && part.itemId === child.callId,
			);
			if (!part || part.kind !== "tool") return;
			if (status) child.outcome = status;
			const outcome = child.outcome;
			const metadata = {
				...part.metadata,
				childSessionId: child.sessionId,
				outcome: null,
				subagentResult: null,
				isError: false,
				subagentResumed: part.closed && !outcome,
				...(child.model ? { subagentModel: child.model } : {}),
				...(outcome
					? {
							subagentResult: child.result,
							outcome:
								outcome === "interrupted"
									? "stopped"
									: outcome === "error"
										? "failed"
										: "completed",
							isError: outcome === "error",
						}
					: {}),
			};
			const updated = {
				...part,
				metadata,
				result: child.result,
				closed: !!outcome,
			};
			if (
				part.closed === updated.closed &&
				part.result === updated.result &&
				JSON.stringify(part.metadata) === JSON.stringify(metadata)
			)
				return;
			const [items, event] = outcome
				? codexRuntimeEvent(
						owner.items,
						"tool.completed",
						{
							messageId: owner.items.messageId,
							partId: part.id,
							input: part.input,
							result: child.result,
							metadata,
							duration: 0,
						},
						part.itemId,
					)
				: codexRuntimeEvent(
						owner.items,
						"tool.running",
						{ messageId: owner.items.messageId, partId: part.id, metadata },
						part.itemId,
					);
			const next = {
				...owner,
				items: {
					...items,
					parts: items.parts.map((entry) =>
						entry.id === part.id ? updated : entry,
					),
				},
			};
			child.owner.set(next);
			yield* child.owner.sink.push(event);
		});
	}
}
