import {
	Context,
	Data,
	Deferred,
	Effect,
	Layer,
	type Scope,
	SynchronizedRef,
} from "effect";
import {
	decideRelayCommand,
	initialRelayReadModel,
	projectRelayEvents,
	type QueuedRelayCommand,
	type RelayCommand,
	type RelayReadModel,
} from "./relay-domain-model.js";

export class RelayCommandRejected extends Data.TaggedError(
	"RelayCommandRejected",
)<{
	readonly commandId: string;
	readonly reason: "duplicate" | "closed";
}> {
	get message(): string {
		return `Relay command ${this.commandId} rejected: ${this.reason}`;
	}
}

export interface RelayCommandGate {
	readonly submit: <A, E, R>(
		command: QueuedRelayCommand,
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | RelayCommandRejected, R>;
	readonly markReady: (readyAt?: number) => Effect.Effect<void>;
	readonly stop: (stoppedAt?: number) => Effect.Effect<void>;
	readonly snapshot: Effect.Effect<RelayReadModel>;
}

export class RelayCommandGateTag extends Context.Tag("RelayCommandGate")<
	RelayCommandGateTag,
	RelayCommandGate
>() {}

interface GateEntry {
	readonly command: QueuedRelayCommand;
	readonly accepted: Deferred.Deferred<void, RelayCommandRejected>;
	readonly completed: Deferred.Deferred<void>;
}

interface GateState {
	readonly model: RelayReadModel;
	readonly pending: readonly GateEntry[];
}

type RegisterResult =
	| { readonly _tag: "accepted" }
	| { readonly _tag: "queued"; readonly entry: GateEntry }
	| { readonly _tag: "rejected"; readonly reason: "duplicate" | "closed" };

const DEFAULT_COMMAND_GATE_CAPACITY = 1024;

const receivedCommand = (command: QueuedRelayCommand): RelayCommand => ({
	_tag: "ClientCommandReceived",
	commandId: command.commandId,
	clientId: command.clientId,
	messageType: command.messageType,
	...(command.sessionId != null ? { sessionId: command.sessionId } : {}),
	receivedAt: command.receivedAt,
});

const classifyRegisterResult = (
	events: readonly ReturnType<typeof decideRelayCommand>[number][],
	entry: GateEntry,
): RegisterResult => {
	if (events.some((event) => event._tag === "ClientCommandQueued")) {
		return { _tag: "queued", entry };
	}
	if (events.some((event) => event._tag === "ClientCommandAccepted")) {
		return { _tag: "accepted" };
	}
	return { _tag: "rejected", reason: "duplicate" };
};

const completeCommand = (
	stateRef: SynchronizedRef.SynchronizedRef<GateState>,
	commandId: string,
	completedAt: number,
) =>
	SynchronizedRef.update(stateRef, (state) => ({
		...state,
		model: projectRelayEvents(
			state.model,
			decideRelayCommand(state.model, {
				_tag: "ClientCommandCompleted",
				commandId,
				completedAt,
			}),
		),
	}));

export const makeRelayCommandGate = (
	projectSlug: string,
	options: {
		readonly capacity?: number;
		readonly now?: () => number;
	} = {},
): Effect.Effect<RelayCommandGate, never, Scope.Scope> =>
	Effect.gen(function* () {
		const now = options.now ?? Date.now;
		const capacity = options.capacity ?? DEFAULT_COMMAND_GATE_CAPACITY;
		const permits = yield* Effect.makeSemaphore(capacity);
		const stateRef = yield* SynchronizedRef.make<GateState>({
			model: initialRelayReadModel(projectSlug),
			pending: [],
		});

		const register = (
			command: QueuedRelayCommand,
			entry: GateEntry,
		): Effect.Effect<RegisterResult> =>
			SynchronizedRef.modify(
				stateRef,
				(state): readonly [RegisterResult, GateState] => {
					if (
						state.model.lifecycle === "stopping" ||
						state.model.lifecycle === "stopped"
					) {
						return [{ _tag: "rejected", reason: "closed" }, state];
					}

					const events = decideRelayCommand(
						state.model,
						receivedCommand(command),
					);
					const result = classifyRegisterResult(events, entry);
					if (result._tag === "rejected") return [result, state];

					const model = projectRelayEvents(state.model, events);
					const pending =
						result._tag === "queued"
							? [...state.pending, entry]
							: state.pending;

					return [result, { model, pending }];
				},
			);

		const runAccepted = <A, E, R>(
			command: QueuedRelayCommand,
			effect: Effect.Effect<A, E, R>,
			completed: Deferred.Deferred<void>,
		): Effect.Effect<A, E, R> =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(effect);
				yield* completeCommand(stateRef, command.commandId, now());
				yield* Deferred.succeed(completed, undefined);
				return yield* exit;
			}).pipe(
				Effect.ensuring(
					Deferred.succeed(completed, undefined).pipe(Effect.ignore),
				),
			);

		const submit = <A, E, R>(
			command: QueuedRelayCommand,
			effect: Effect.Effect<A, E, R>,
		): Effect.Effect<A, E | RelayCommandRejected, R> =>
			permits.withPermits(1)(
				Effect.gen(function* () {
					const accepted = yield* Deferred.make<void, RelayCommandRejected>();
					const completed = yield* Deferred.make<void>();
					const entry = { command, accepted, completed };
					const result = yield* register(command, entry);

					if (result._tag === "rejected") {
						return yield* Effect.fail(
							new RelayCommandRejected({
								commandId: command.commandId,
								reason: result.reason,
							}),
						);
					}

					if (result._tag === "queued") {
						yield* Deferred.await(result.entry.accepted);
						return yield* runAccepted(command, effect, completed);
					}

					return yield* runAccepted(command, effect, completed);
				}),
			);

		const markReady = (readyAt: number = now()) =>
			Effect.gen(function* () {
				const pending = yield* SynchronizedRef.modify(stateRef, (state) => {
					const events = decideRelayCommand(state.model, {
						_tag: "RelayReady",
						readyAt,
					});
					const model = projectRelayEvents(state.model, events);
					return [state.pending, { model, pending: [] }] as const;
				});

				yield* Effect.fork(
					Effect.forEach(
						pending,
						(entry) =>
							Deferred.succeed(entry.accepted, undefined).pipe(
								Effect.zipRight(Deferred.await(entry.completed)),
							),
						{ concurrency: 1 },
					),
				);
			});

		const stop = (stoppedAt: number = now()) =>
			Effect.gen(function* () {
				const pending = yield* SynchronizedRef.modify(stateRef, (state) => {
					const events = decideRelayCommand(state.model, {
						_tag: "RelayStopping",
						stoppedAt,
					});
					const model = projectRelayEvents(state.model, events);
					return [state.pending, { model, pending: [] }] as const;
				});

				for (const entry of pending) {
					yield* Deferred.fail(
						entry.accepted,
						new RelayCommandRejected({
							commandId: entry.command.commandId,
							reason: "closed",
						}),
					);
					yield* Deferred.succeed(entry.completed, undefined).pipe(
						Effect.ignore,
					);
				}
			});

		yield* Effect.addFinalizer(() => stop());

		return {
			submit,
			markReady,
			stop,
			snapshot: SynchronizedRef.get(stateRef).pipe(
				Effect.map((state) => state.model),
			),
		} satisfies RelayCommandGate;
	});

export const makeRelayCommandGateLive = (
	projectSlug: string,
	options?: {
		readonly capacity?: number;
		readonly now?: () => number;
	},
): Layer.Layer<RelayCommandGateTag> =>
	Layer.scoped(RelayCommandGateTag, makeRelayCommandGate(projectSlug, options));
