import {
	Context,
	Effect,
	Fiber,
	HashMap,
	Option,
	Result,
	Stream,
} from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";
import {
	type PtyEnvelope,
	type ShellProjectsFrame,
	WsRpcError,
	type WsRpcGroup,
} from "../contracts/ws-rpc.js";
import { SessionDirectory } from "../domain/daemon/Services/session-directory.js";
import type { Envelope } from "../domain/relay/Services/read-model-subscription.js";
import { ConfigTag } from "../domain/relay/Services/services.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import {
	type Audience,
	delivers,
	EventDelivery,
	type Interests,
} from "./event-audiences.js";

/** Provided once per socket, never keyed by a caller-supplied originId. */
export const CurrentEventDelivery = Context.Reference<
	EventDelivery | undefined
>("conduit/server/EventDelivery", { defaultValue: () => undefined });

type WsRpcs = RpcGroup.Rpcs<typeof WsRpcGroup>;
export interface SubscriptionProducer {
	readonly projectId: string | undefined;
}
export type SubscriptionAudienceTable<Rpcs extends Rpc.Any = WsRpcs> = {
	[R in Rpcs as Rpc.IsStream<R, R["_tag"]> extends never ? never : R["_tag"]]: (
		request: Rpc.Payload<R>,
		producer: SubscriptionProducer,
	) => Effect.Effect<Audience, WsRpcError>;
};

const globalAudience = (): Effect.Effect<Audience> =>
	Effect.succeed({ _tag: "global" });
const projectAudience = (
	request: { readonly projectSlug: string },
	producer: SubscriptionProducer,
): Effect.Effect<Audience, WsRpcError> =>
	producer.projectId !== undefined && request.projectSlug !== producer.projectId
		? Effect.fail(
				new WsRpcError({
					code: "project-mismatch",
					message: `Project ${request.projectSlug} does not match producer ${producer.projectId}`,
				}),
			)
		: Effect.succeed({ _tag: "project", projectId: producer.projectId });

const sessionAudience = (
	sessionId: string,
	producer: SubscriptionProducer,
): Effect.Effect<Extract<Audience, { _tag: "session" }>, WsRpcError> =>
	Effect.gen(function* () {
		const directory = yield* Effect.serviceOption(SessionDirectory);
		const read = yield* Effect.serviceOption(ReadQueryEffectTag);
		const lookup: Effect.Effect<string | undefined, unknown> = Option.isSome(
			directory,
		)
			? directory.value
					.projectOf(sessionId)
					.pipe(Effect.map(Option.getOrUndefined))
			: Option.isSome(read)
				? read.value
						.getSession(sessionId)
						.pipe(Effect.map((row) => row?.project_id ?? undefined))
				: Effect.succeed(undefined);
		const owner = yield* lookup.pipe(
			Effect.mapError(
				(error) =>
					new WsRpcError({
						code: "ownership-lookup-failed",
						message: `Could not resolve owner of ${sessionId}: ${String(error)}`,
					}),
			),
		);
		if (owner === undefined)
			return yield* new WsRpcError({
				code: "unknown-session",
				message: `Unknown session: ${sessionId}`,
			});
		if (producer.projectId !== undefined && owner !== producer.projectId)
			return yield* new WsRpcError({
				code: "project-mismatch",
				message: `Session ${sessionId} belongs to ${owner}, not producer ${producer.projectId}`,
			});
		return {
			_tag: "session",
			sessionId,
			projectId: producer.projectId ?? owner,
		};
	});

/** Every streaming RPC chooses its address once, before its producer opens. */
export const subscriptionAudiences = {
	SubscribeShell: globalAudience,
	SubscribeSessionDetail: (request, producer) =>
		sessionAudience(request.sessionId, producer),
	SubscribeSessionTodos: (request, producer) =>
		sessionAudience(request.sessionId, producer),
	SubscribeSessionFamily: (request, producer) =>
		sessionAudience(request.sessionId, producer).pipe(
			Effect.map(
				(audience): Audience => ({
					_tag: "project",
					projectId: audience.projectId,
				}),
			),
		),
	SubscribePtys: projectAudience,
	SubscribeApprovals: (request, producer) =>
		projectAudience(request, producer).pipe(Effect.andThen(globalAudience)),
	SubscribeProjectSettings: projectAudience,
	SubscribeDraftModels: (request, producer) =>
		projectAudience(request, producer).pipe(Effect.andThen(globalAudience)),
	SubscribeAlerts: projectAudience,
	SubscribeInputDraft: (request, producer) =>
		"session" in request.key
			? sessionAudience(request.key.session, producer)
			: globalAudience(),
	SubscribeDrafts: globalAudience,
	SubscribeRecaps: (request, producer) =>
		sessionAudience(request.sessionId, producer),
	SubscribeInstances: globalAudience,
	SubscribeUsage: globalAudience,
	SubscribeServerStatus: globalAudience,
} satisfies SubscriptionAudienceTable;

type SubscribeMethod = keyof typeof subscriptionAudiences;
type SubscribeRequest<K extends SubscribeMethod> = Rpc.Payload<
	Rpc.ExtractTag<WsRpcs, K>
>;

const interestsFor = (audience: Audience): Interests => ({
	sessions: new Set(audience._tag === "session" ? [audience.sessionId] : []),
	projects: new Set(
		audience._tag !== "global" && audience.projectId !== undefined
			? [audience.projectId]
			: [],
	),
	ptys: new Map(
		audience._tag === "pty" && audience.projectId !== undefined
			? [[audience.ptyId, new Set([audience.projectId])]]
			: [],
	),
});

const untilUncovered = (
	delivery: EventDelivery,
	audience: Audience,
	onUncovered: () => void,
) =>
	Effect.callback<void>((resume) => {
		// Cleanup returned below runs only on interruption, so revocation releases itself.
		const check = () => {
			if (delivery.covers(audience)) return;
			release();
			onUncovered();
			resume(Effect.void);
		};
		const release = delivery.onChange(check);
		check();
		return Effect.sync(release);
	});

/** Address and check each row together, before the next row changes Interests. */
const deliverRows = <A, B, E, R>(
	source: Stream.Stream<A, E, R>,
	delivery: EventDelivery,
	address: (value: A) => { readonly audience: Audience; readonly value: B },
) =>
	source.pipe(
		Stream.filterMap((value) => {
			const row = address(value);
			return delivery.covers(row.audience)
				? Result.succeed(row.value)
				: Result.fail(undefined);
		}),
	);

/** Fixed-address events pass through without effects or rechunking. */
export const deliverEventStream = <K extends SubscribeMethod, A, E, R>(
	method: K,
	request: SubscribeRequest<K>,
	source: Stream.Stream<A, E, R>,
	producer?: SubscriptionProducer,
): Stream.Stream<A, E | WsRpcError, R> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const delivery = (yield* CurrentEventDelivery) ?? new EventDelivery();
			const config = yield* Effect.serviceOption(ConfigTag);
			const openedProducer = producer ?? {
				projectId: Option.isSome(config) ? config.value.slug : undefined,
			};
			// The record is exhaustive and each call retains its method's payload type.
			const address = subscriptionAudiences[method] as (
				request: SubscribeRequest<K>,
				producer: SubscriptionProducer,
			) => Effect.Effect<Audience, WsRpcError>;
			const audience = yield* address(request, openedProducer);
			yield* Effect.acquireRelease(
				Effect.sync(() => delivery.subscription(interestsFor(audience))),
				(view) => Effect.sync(view.release),
			);
			if (!delivery.covers(audience)) return Stream.empty;
			// Arm before opening the source and latch revocation across re-coverage.
			let covered = true;
			const watcher = yield* Effect.forkScoped(
				untilUncovered(delivery, audience, () => {
					covered = false;
				}),
				{ startImmediately: true },
			);
			return source.pipe(
				Stream.provideService(CurrentEventDelivery, delivery),
				Stream.interruptWhen(Fiber.join(watcher)),
				Stream.takeWhile(() => covered),
			);
		}),
	);

/** Rows arrive typed and receive their address before the shared delivery test. */
export const deliverSessionRows = <
	A extends { readonly id: string; readonly projectSlug?: string },
	E,
	R,
>(
	source: Stream.Stream<Envelope<A> | ShellProjectsFrame, E, R>,
	producerProjectId?: string,
): Stream.Stream<Envelope<A> | ShellProjectsFrame, E, R> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const delivery = (yield* CurrentEventDelivery) ?? new EventDelivery();
			const config = yield* Effect.serviceOption(ConfigTag);
			const projectId = Option.isSome(config)
				? config.value.slug
				: producerProjectId;
			const initial = interestsFor({ _tag: "project", projectId });
			const hold = yield* Effect.acquireRelease(
				Effect.sync(() => delivery.subscription(initial)),
				(view) => Effect.sync(view.release),
			);
			let held = HashMap.empty<string, Audience>();
			const addressed = (value: A) => ({
				audience: {
					_tag: "project",
					projectId: value.projectSlug,
				} satisfies Audience,
				value,
			});
			return deliverRows(
				source,
				delivery,
				(
					envelope,
				): { audience: Audience; value: Envelope<A> | ShellProjectsFrame } => {
					switch (envelope._tag) {
						case "projects":
							hold.update(
								{
									...initial,
									projects: new Set(
										envelope.projects.map((project) => project.slug),
									),
								},
								true,
							);
							return {
								audience: { _tag: "global" } satisfies Audience,
								value: envelope,
							};
						case "snapshot": {
							const rows = envelope.rows.map(addressed);
							held = HashMap.fromIterable(
								rows.map((row) => [row.value.id, row.audience] as const),
							);
							return {
								audience: { _tag: "global" } satisfies Audience,
								value: {
									...envelope,
									rows: rows
										.filter((row) => delivers(row.audience, delivery.interests))
										.map((row) => row.value),
								},
							};
						}
						case "upsert": {
							const row = addressed(envelope.item);
							held = HashMap.set(held, row.value.id, row.audience);
							return { audience: row.audience, value: envelope };
						}
						case "remove": {
							const audience =
								(envelope.projectSlug === undefined
									? undefined
									: {
											_tag: "project" as const,
											projectId: envelope.projectSlug,
										}) ??
								Option.getOrUndefined(HashMap.get(held, envelope.id)) ??
								({ _tag: "project", projectId } satisfies Audience);
							held = HashMap.remove(held, envelope.id);
							return { audience, value: envelope };
						}
						case "synchronized":
							return {
								audience: { _tag: "global" } satisfies Audience,
								value: envelope,
							};
					}
				},
			);
		}),
	);

export const deliverPtyRows = <E, R>(
	source: Stream.Stream<PtyEnvelope, E, R>,
	producerProjectId: string | undefined,
): Stream.Stream<PtyEnvelope, E, R> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const delivery = (yield* CurrentEventDelivery) ?? new EventDelivery();
			const config = yield* Effect.serviceOption(ConfigTag);
			const projectId = Option.isSome(config)
				? config.value.slug
				: producerProjectId;
			const initial = interestsFor({ _tag: "project", projectId });
			const hold = yield* Effect.acquireRelease(
				Effect.sync(() => delivery.subscription(initial)),
				(view) => Effect.sync(view.release),
			);
			let attached: ReadonlySet<string> = new Set();
			return deliverRows(source, delivery, (value) => {
				if (value._tag === "snapshot")
					attached = new Set(value.rows.map((row) => row.pty.id));
				else if (value._tag === "upsert")
					attached = new Set([...attached, value.item.id]);
				else if (value._tag === "remove")
					attached = new Set([...attached].filter((id) => id !== value.id));
				if (value._tag !== "output")
					hold.update({
						...initial,
						ptys: new Map([...attached].map((id) => [id, initial.projects])),
					});
				const audience: Audience =
					value._tag === "output"
						? { _tag: "pty", ptyId: value.ptyId, projectId }
						: { _tag: "project", projectId };
				return { audience, value };
			});
		}),
	);
