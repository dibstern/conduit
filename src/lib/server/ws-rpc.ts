import { Rpc, type RpcGroup, RpcSchema } from "@effect/rpc";
import {
	Context,
	Effect,
	Fiber,
	Layer,
	Option,
	Queue,
	type Scope,
	Stream,
	type Take,
} from "effect";
import type { UsageReading } from "../contracts/limit-recovery.js";
import {
	type OpenCodeInstance,
	type ProjectInfo,
	type ServerStatus,
	WsRpcError,
	WsRpcGroup,
} from "../contracts/ws-rpc.js";
import { SessionDirectory } from "../domain/daemon/Services/session-directory.js";
import { subscribeAlerts } from "../domain/relay/Services/alerts.js";
import { subscribeApprovals } from "../domain/relay/Services/approvals-subscription.js";
import { subscribeInputDraft } from "../domain/relay/Services/input-drafts.js";
import { subscribeProjectSettings } from "../domain/relay/Services/project-settings.js";
import { subscribePtys } from "../domain/relay/Services/pty-subscription.js";
import { WebSocketHandlerTag } from "../domain/relay/Services/services.js";
import { subscribeSessionDetail } from "../domain/relay/Services/session-detail-subscription.js";
import { subscribeSessionFamily } from "../domain/relay/Services/session-family-subscription.js";
import { subscribeShell } from "../domain/relay/Services/shell-subscription.js";
import { subscribeSessionTodos } from "../domain/relay/Services/todo-subscription.js";
import { conversationHandlers } from "./ws-rpc/conversation.js";
import { daemonOnlyHandlers } from "./ws-rpc/daemon.js";
import { filesHandlers } from "./ws-rpc/files.js";
import { instancesHandlers } from "./ws-rpc/instances.js";
import { modelsHandlers, subscribeDraftModels } from "./ws-rpc/models.js";
import { projectsHandlers } from "./ws-rpc/projects.js";
import { sessionSkillsHandlers } from "./ws-rpc/session-skills.js";
import { sessionsHandlers } from "./ws-rpc/sessions.js";
import { settingsHandlers } from "./ws-rpc/settings.js";
import { terminalsHandlers } from "./ws-rpc/terminals.js";

export * from "../contracts/ws-rpc.js";

const unaryHandlers = {
	...daemonOnlyHandlers,
	...projectsHandlers,
	...instancesHandlers,
	...settingsHandlers,
	...terminalsHandlers,
	...filesHandlers,
	...sessionSkillsHandlers,
	...modelsHandlers,
	...sessionsHandlers,
	...conversationHandlers,
};

const subscribeSessionDetailWithPresence = (
	options: Parameters<typeof subscribeSessionDetail>[0],
) =>
	Stream.unwrapScoped(
		Effect.gen(function* () {
			const wsHandler = yield* WebSocketHandlerTag;
			yield* Effect.acquireRelease(
				Effect.sync(() => wsHandler.registerSessionViewer(options.sessionId)),
				(removeViewer) => Effect.sync(removeViewer),
			);
			return subscribeSessionDetail(options);
		}),
	);

type WsRpcs = RpcGroup.Rpcs<typeof WsRpcGroup>;

const daemonOnlyStreamHandlers = {
	SubscribeInstances: () =>
		Stream.fail(
			new WsRpcError({ message: "SubscribeInstances requires daemon mode" }),
		),
	SubscribeUsage: () =>
		Stream.fail(
			new WsRpcError({ message: "SubscribeUsage requires daemon mode" }),
		),
	SubscribeProjects: () =>
		Stream.fail(
			new WsRpcError({ message: "SubscribeProjects requires daemon mode" }),
		),
	SubscribeServerStatus: () =>
		Stream.fail(
			new WsRpcError({ message: "SubscribeServerStatus requires daemon mode" }),
		),
};

const streamHandlers = {
	SubscribeShell: (request) =>
		subscribeShell({
			...(request.resumeFromSequence === undefined
				? {}
				: { resumeFromSequence: request.resumeFromSequence }),
			...(request.resumeBase === undefined
				? {}
				: { resumeBase: request.resumeBase }),
		}),
	SubscribeApprovals: (request) =>
		subscribeApprovals(
			request.resumeFromSequence === undefined
				? {}
				: { resumeFromSequence: request.resumeFromSequence },
		),
	SubscribeSessionDetail: (request) =>
		subscribeSessionDetailWithPresence({
			sessionId: request.sessionId,
			...(request.resumeFromSequence === undefined
				? {}
				: { resumeFromSequence: request.resumeFromSequence }),
			...(request.resumeBase === undefined
				? {}
				: { resumeBase: request.resumeBase }),
			...(request.resumePoint === undefined
				? {}
				: { resumePoint: request.resumePoint }),
		}),
	SubscribeSessionTodos: (request) =>
		subscribeSessionTodos({
			sessionId: request.sessionId,
			...(request.resumeFromSequence === undefined
				? {}
				: { resumeFromSequence: request.resumeFromSequence }),
		}),
	SubscribeSessionFamily: (request) =>
		subscribeSessionFamily({
			sessionId: request.sessionId,
			...(request.resumeFromSequence === undefined
				? {}
				: { resumeFromSequence: request.resumeFromSequence }),
		}),
	SubscribePtys: () => subscribePtys(),
	SubscribeProjectSettings: () => subscribeProjectSettings(),
	SubscribeDraftModels: (request) => subscribeDraftModels(request),
	SubscribeAlerts: () => subscribeAlerts(),
	SubscribeInputDraft: (request) => subscribeInputDraft(request.sessionId),
	...daemonOnlyStreamHandlers,
} satisfies {
	[K in WsRpcs as Rpc.IsStream<K, K["_tag"]> extends never
		? never
		: K["_tag"]]: (
		request: Rpc.Payload<K>,
	) => Stream.Stream<Rpc.SuccessChunk<K>, unknown, unknown>;
};

type RegisteredStreamHandlers = {
	[K in keyof typeof streamHandlers]: (
		request: Rpc.Payload<Rpc.ExtractTag<WsRpcs, K>>,
	) => Rpc.Wrapper<
		Stream.Stream<
			Stream.Stream.Success<ReturnType<(typeof streamHandlers)[K]>>,
			WsRpcError,
			Stream.Stream.Context<ReturnType<(typeof streamHandlers)[K]>>
		>
	>;
};

type StreamHandlerContext = Stream.Stream.Context<
	ReturnType<(typeof streamHandlers)[keyof typeof streamHandlers]>
>;

export const wsRpcHandlers = WsRpcGroup.of({
	...unaryHandlers,
	// entries/fromEntries erases the correlation between each tag and its handler.
	...(Object.fromEntries(
		Object.entries(streamHandlers).map(([name, handler]) => [
			name,
			(request: never) => {
				const stream: Stream.Stream<unknown, unknown, StreamHandlerContext> =
					handler(request);
				return Rpc.fork(
					stream.pipe(
						Stream.mapError((error) =>
							error instanceof WsRpcError
								? error
								: new WsRpcError({
										message: `${name} failed: ${String(error)}`,
									}),
						),
					),
				);
			},
		]),
	) as RegisteredStreamHandlers),
});

export const WsRpcServerLayer = WsRpcGroup.toLayer(wsRpcHandlers);

export class RpcSubscriptionScopeTag extends Context.Tag(
	"RpcSubscriptionScope",
)<RpcSubscriptionScopeTag, Scope.Scope>() {}

export const RpcSubscriptionScopeLive = Layer.scoped(
	RpcSubscriptionScopeTag,
	Effect.scope,
);

export type ResolveRpcContext = (
	projectSlug: string,
) => Effect.Effect<
	Context.Context<
		Layer.Layer.Context<typeof WsRpcServerLayer> | RpcSubscriptionScopeTag
	>,
	WsRpcError
>;

export type AttachDaemonProject = (payload: {
	readonly originId: string;
	readonly projectSlug?: string | undefined;
	readonly sessionId?: string | undefined;
}) => Effect.Effect<
	{
		readonly projectSlug: string | null;
		readonly sessionSlug: string | null;
	},
	WsRpcError
>;

export type DaemonRpcName =
	| keyof typeof daemonOnlyHandlers
	| "GetProjects"
	| "SaveProject"
	| "RemoveProject"
	| "StartInstance"
	| "StopInstance"
	| "RemoveInstance"
	| "RenameInstance"
	| "AddInstance"
	| "UpdateInstance"
	| "SetDefault"
	| "GetAutoSettleSetting"
	| "SetAutoSettleSetting"
	| "GetWorktreeCleanupSetting"
	| "SetWorktreeCleanupSetting"
	| "CleanUpWorktreesNow"
	| "SetDefaultGroupingMode"
	| "GetDefaultGroupingMode"
	| "GetUsageLimitsSetting"
	| "SetUsageLimitsSetting"
	| "ScanNow"
	| "DetectProxy"
	| "FindFolders"
	| "ListDaemonSessions"
	| "SetLogLevel"
	| "ResolveSession";

export class RpcCaller extends Context.Tag("RpcCaller")<
	RpcCaller,
	{ readonly kind: "browser"; readonly ip: string } | { readonly kind: "cli" }
>() {}

/** Browser mutations revoke connections after their reply has been written. */
export class RpcPinChangeResponse extends Context.Tag("RpcPinChangeResponse")<
	RpcPinChangeResponse,
	(invalidate: () => void) => void
>() {}

/** Connection invalidators share the daemon lifetime; Unix clients never register. */
export class BrowserRpcConnectionsTag extends Context.Tag(
	"BrowserRpcConnections",
)<BrowserRpcConnectionsTag, Set<() => void>>() {}

export const BrowserRpcConnectionsLive = Layer.sync(
	BrowserRpcConnectionsTag,
	() => new Set<() => void>(),
);

export type DaemonRpcHandlers = {
	[K in DaemonRpcName]: (
		payload: Parameters<(typeof unaryHandlers)[K]>[0],
	) => Effect.Effect<
		Rpc.Success<
			Extract<RpcGroup.Rpcs<typeof WsRpcGroup>, { readonly _tag: K }>
		>,
		Rpc.Error<Extract<RpcGroup.Rpcs<typeof WsRpcGroup>, { readonly _tag: K }>>,
		K extends "SetPin" ? RpcCaller : never
	>;
} & {
	readonly SubscribeInstances: () => Stream.Stream<
		{ readonly instances: readonly OpenCodeInstance[] },
		WsRpcError
	>;
	readonly SubscribeUsage: () => Stream.Stream<
		{ readonly readings: readonly UsageReading[] },
		WsRpcError
	>;
	readonly SubscribeProjects: () => Stream.Stream<
		{
			readonly projects: readonly ProjectInfo[];
			readonly newSessionProject?: string;
		},
		WsRpcError
	>;
	readonly SubscribeServerStatus: () => Stream.Stream<ServerStatus, WsRpcError>;
	/** Told after a session is created in `projectSlug`. */
	readonly sessionCreated: (projectSlug: string) => Effect.Effect<void>;
};

export const makeRoutedWsRpcServerLayer = <
	D extends DaemonRpcHandlers | undefined = undefined,
>(
	resolveContext: ResolveRpcContext,
	daemonHandlers?: D,
	defaultProjectSlug?: string,
	attachProject?: AttachDaemonProject,
) =>
	Layer.unwrapEffect(
		Effect.gen(function* () {
			const directory = yield* SessionDirectory;
			const projectSlugFor = (payload: object, fallback?: string) =>
				Effect.gen(function* () {
					if ("sessionId" in payload && typeof payload.sessionId === "string") {
						const owner = yield* directory.projectOf(payload.sessionId).pipe(
							Effect.mapError(
								(error) =>
									new WsRpcError({
										code: "ambiguous-session",
										message: error.message,
									}),
							),
						);
						if (Option.isNone(owner))
							return yield* new WsRpcError({
								code: "unknown-session",
								message: `Unknown session: ${payload.sessionId}`,
							});
						return owner.value;
					}
					const slug =
						"projectSlug" in payload && typeof payload.projectSlug === "string"
							? payload.projectSlug
							: fallback;
					if (slug === undefined)
						return yield* new WsRpcError({
							message: "projectSlug is required",
						});
					return slug;
				});
			const routeHandler =
				<P extends object, A, E, R>(
					handler: (payload: P) => Effect.Effect<A, E, R>,
					fallbackProjectSlug?: string,
				) =>
				(payload: P) =>
					Effect.gen(function* () {
						const slug = yield* projectSlugFor(payload, fallbackProjectSlug);
						const context = yield* resolveContext(slug);
						return yield* Effect.provide(handler(payload), context);
					});

			const daemon: DaemonRpcHandlers | undefined = daemonHandlers;
			const daemonUnaryHandlers =
				daemon &&
				(Object.fromEntries(
					Object.entries(daemon).filter(([name]) => {
						const rpc = WsRpcGroup.requests.get(name);
						return (
							rpc !== undefined && !RpcSchema.isStreamSchema(rpc.successSchema)
						);
					}),
				) as
					| Pick<
							DaemonRpcHandlers,
							Extract<keyof DaemonRpcHandlers, keyof typeof unaryHandlers>
					  >
					| undefined);
			const daemonStreamHandlers =
				daemon &&
				(Object.fromEntries(
					Object.entries(daemon).filter(([name]) => {
						const rpc = WsRpcGroup.requests.get(name);
						return (
							rpc !== undefined && RpcSchema.isStreamSchema(rpc.successSchema)
						);
					}),
				) as
					| Pick<
							DaemonRpcHandlers,
							Extract<keyof DaemonRpcHandlers, keyof typeof streamHandlers>
					  >
					| undefined);

			// Object.entries/fromEntries loses the key-to-payload/result correlation.
			// Each wrapper preserves its original handler's payload and success type.
			const handlers = Object.fromEntries(
				Object.entries({ ...unaryHandlers, ...daemonUnaryHandlers }).map(
					([name, handler]) => [
						name,
						(daemonUnaryHandlers && Object.hasOwn(daemonUnaryHandlers, name)) ||
						Object.hasOwn(daemonOnlyHandlers, name)
							? handler
							: routeHandler<never, unknown, unknown, unknown>(
									handler,
									name === "CreateSession" ? undefined : defaultProjectSlug,
								),
					],
				),
			) as {
				-readonly [K in keyof typeof unaryHandlers]: (
					payload: Parameters<(typeof unaryHandlers)[K]>[0],
				) => Effect.Effect<
					Effect.Effect.Success<ReturnType<(typeof unaryHandlers)[K]>>,
					| Effect.Effect.Error<ReturnType<(typeof unaryHandlers)[K]>>
					| WsRpcError,
					K extends "SetPin"
						? D extends DaemonRpcHandlers
							? Effect.Effect.Context<ReturnType<D["SetPin"]>>
							: never
						: never
				>;
			};
			if (attachProject) handlers.AttachProject = attachProject;
			if (daemonHandlers) {
				const routeCreateSession = routeHandler(unaryHandlers.CreateSession);
				handlers.CreateSession = (
					payload: Parameters<(typeof unaryHandlers)["CreateSession"]>[0],
				) =>
					routeCreateSession(payload).pipe(
						Effect.tap(() =>
							daemonHandlers.sessionCreated(payload.projectSlug),
						),
					);
			}
			const routeStream = <
				A,
				E,
				R extends Layer.Layer.Context<typeof WsRpcServerLayer>,
			>(
				payload: object,
				make: () => Stream.Stream<A, E, R>,
			) =>
				Rpc.fork(
					Stream.unwrapScoped(
						Effect.gen(function* () {
							const projectSlug = yield* projectSlugFor(payload);
							const context = yield* resolveContext(projectSlug);
							const queue = yield* Effect.acquireRelease(
								Queue.bounded<Take.Take<A, E>>(2),
								Queue.shutdown,
							);
							// Project removal and browser cancellation both await this producer
							// before SQLite closes. Queue shutdown ends the consumer cleanly.
							yield* Effect.acquireRelease(
								Stream.runIntoQueue(
									Stream.provideContext(make(), context),
									queue,
								).pipe(
									Effect.interruptible,
									Effect.onInterrupt(() => Queue.shutdown(queue)),
									Effect.forkIn(Context.get(context, RpcSubscriptionScopeTag)),
								),
								Fiber.interrupt,
							);
							return Stream.fromQueue(queue).pipe(
								Stream.flattenTake,
								Stream.mapError(
									(error) =>
										new WsRpcError({
											message: `Subscription failed: ${String(error)}`,
										}),
								),
							);
						}),
					),
				);
			return WsRpcGroup.toLayer({
				...handlers,
				// The same stream definitions serve direct and project-routed clients.
				...(Object.fromEntries(
					Object.entries(streamHandlers).map(([name, handler]) => {
						const daemonHandler =
							daemonStreamHandlers?.[
								name as keyof typeof daemonStreamHandlers
							] ??
							(Object.hasOwn(daemonOnlyStreamHandlers, name)
								? daemonOnlyStreamHandlers[
										name as keyof typeof daemonOnlyStreamHandlers
									]
								: undefined);
						return [
							name,
							(
								request: never,
							): Rpc.Wrapper<Stream.Stream<unknown, WsRpcError>> => {
								if (daemonHandler) return Rpc.fork(daemonHandler());
								return routeStream<unknown, unknown, StreamHandlerContext>(
									request,
									() => handler(request),
								);
							},
						];
					}),
				) as {
					[K in keyof typeof streamHandlers]: (
						request: Rpc.Payload<Rpc.ExtractTag<WsRpcs, K>>,
					) => Rpc.Wrapper<
						Stream.Stream<
							Rpc.SuccessChunk<Rpc.ExtractTag<WsRpcs, K>>,
							WsRpcError
						>
					>;
				}),
			});
		}),
	);
