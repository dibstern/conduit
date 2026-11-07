import {
	Context,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Layer,
	Option,
	Ref,
	Semaphore,
} from "effect";
import type { OpenCodeAPI } from "../../../instance/opencode-api.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import type {
	PreWarmSessionInput,
	ProviderCall,
} from "../../../provider/types.js";
import { DaemonStoreAvailability } from "../../daemon/Services/daemon-store-availability.js";
import { ProjectRegistryTag } from "../../daemon/Services/project-registry-service.js";
import { LoggerTag } from "./services.js";
import { createLocalSessionId } from "./session-manager-service.js";

export const draftLaunchKey = (
	input: Omit<PreWarmSessionInput, "sessionId" | "providerState">,
) =>
	JSON.stringify({
		projectId: input.projectId,
		accountId: input.instanceId,
		model: input.model,
		variant: input.variant,
		contextWindow: input.contextWindow,
		permissionMode: input.permissionMode,
		agent: input.agent,
		workspaceRoot: input.workspaceRoot,
		extraFolders: input.extraFolders,
	});

export class DraftPreWarmTag extends Context.Service<
	DraftPreWarmTag,
	{
		readonly discardDraft: (draftId: string) => Effect.Effect<void>;
		readonly discardProject: (projectId: string) => Effect.Effect<void>;
		readonly discardSession: (
			sessionId: string,
			call?: ProviderCall,
		) => Effect.Effect<void>;
		readonly warmDirectory: (
			instanceId: string,
			client: OpenCodeAPI,
			directory: string,
		) => Effect.Effect<void, unknown>;
		readonly warm: <E, R>(
			originId: string,
			draftId: string,
			projectId: string,
			input: Effect.Effect<
				Omit<PreWarmSessionInput, "sessionId"> | undefined,
				E,
				R
			>,
		) => Effect.Effect<void, E, R>;
		readonly take: (
			originId: string,
			draftId: string,
			launchKey: string | undefined,
		) => Effect.Effect<string | undefined>;
	}
>()("DraftPreWarm") {}

/** Owned by the daemon in shared mode, or the standalone relay otherwise. */
export const DraftPreWarmLive = Layer.effect(
	DraftPreWarmTag,
	Effect.gen(function* () {
		const registry = yield* ProviderRegistryTag;
		const log = yield* LoggerTag;
		const projects = yield* Effect.serviceOption(ProjectRegistryTag);
		const unavailable = yield* DaemonStoreAvailability;
		const canWarm = (projectId: string) =>
			Effect.gen(function* () {
				if (Option.isSome(projects)) {
					const project = HashMap.get(
						yield* Ref.get(projects.value),
						projectId,
					);
					if (Option.isNone(project) || project.value._tag === "Error")
						return false;
				}
				return !unavailable.has(projectId);
			});
		const scope = yield* Effect.scope;
		const gate = yield* Semaphore.make(1);
		const directoryGate = yield* Semaphore.make(1);
		const configured = Number(
			process.env["CONDUIT_TEST_DRAFT_PREWARM_TTL_MS"] ?? 600_000,
		);
		const ttl =
			Number.isInteger(configured) && configured > 0 ? configured : 600_000;
		type Reservation = {
			readonly draftId: string;
			readonly sessionId: string;
			readonly launchKey: string;
			readonly call: ProviderCall | undefined;
			readonly expiresAt: number;
			readonly warm: Fiber.Fiber<boolean>;
			readonly timer: Fiber.Fiber<void>;
		};
		// One entry per origin also bounds live runners while switching drafts.
		const reservations = new Map<string, Reservation>();
		// Object identity is the generation, including hints still resolving input.
		const preparations = new Map<
			string,
			{ draftId: string; projectId: string }
		>();
		const directories = new Map<
			string,
			{ identity: string; paths: Set<string> }
		>();
		const end = (sessionId: string, call?: ProviderCall) =>
			(
				registry
					.getInstance("claude")
					?.endSessionEffect(sessionId, ...(call ? ([call] as const) : [])) ??
				Effect.void
			).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() =>
						log.debug(`Draft pre-warm cleanup failed: ${String(cause)}`),
					),
				),
			);
		const discard = (originId: string, entry: Reservation) =>
			Effect.gen(function* () {
				reservations.delete(originId);
				yield* Fiber.interrupt(entry.timer);
				yield* Fiber.interrupt(entry.warm);
				yield* end(entry.sessionId, entry.call);
			});
		const refresh = (
			originId: string,
			draftId: string,
			sessionId: string,
			launchKey: string,
			warm: Fiber.Fiber<boolean>,
			call: ProviderCall | undefined,
		) =>
			Effect.gen(function* () {
				const expiresAt = Date.now() + ttl;
				const timer = yield* Effect.forkIn(
					Effect.sleep(ttl).pipe(
						Effect.andThen(
							gate.withPermits(1)(
								Effect.gen(function* () {
									const current = reservations.get(originId);
									if (
										current?.sessionId !== sessionId ||
										current.expiresAt !== expiresAt
									)
										return;
									reservations.delete(originId);
									yield* Fiber.interrupt(current.warm);
									yield* end(sessionId, call);
								}).pipe(Effect.uninterruptible),
							),
						),
						Effect.interruptible,
					),
					scope,
					{ uninterruptible: "inherit" },
				);
				reservations.set(originId, {
					draftId,
					sessionId,
					launchKey,
					call,
					expiresAt,
					timer,
					warm,
				});
			});
		yield* Effect.addFinalizer(() =>
			gate.withPermits(1)(
				Effect.forEach(
					[...reservations],
					([originId, entry]) => discard(originId, entry),
					{ discard: true },
				),
			),
		);
		return {
			discardDraft: (draftId) =>
				gate
					.withPermits(1)(
						Effect.gen(function* () {
							for (const [originId, preparation] of preparations)
								if (preparation.draftId === draftId)
									preparations.delete(originId);
							for (const [originId, entry] of reservations)
								if (entry.draftId === draftId) yield* discard(originId, entry);
						}),
					)
					.pipe(Effect.uninterruptible),
			discardProject: (projectId) =>
				gate
					.withPermits(1)(
						Effect.gen(function* () {
							for (const [originId, preparation] of preparations)
								if (preparation.projectId === projectId)
									preparations.delete(originId);
							for (const [originId, entry] of reservations)
								if (entry.call?.projectId === projectId)
									yield* discard(originId, entry);
						}),
					)
					.pipe(Effect.uninterruptible),
			discardSession: end,
			warmDirectory: (instanceId, client, directory) =>
				directoryGate.withPermits(1)(
					Effect.gen(function* () {
						let cached = directories.get(instanceId);
						if (cached?.identity !== client.processIdentity) {
							cached = { identity: client.processIdentity, paths: new Set() };
							directories.set(instanceId, cached);
						}
						if (cached.paths.has(directory)) return;
						yield* Effect.tryPromise(() => client.app.path(directory));
						cached.paths.add(directory);
					}),
				),
			warm: (originId, draftId, projectId, resolveInput) =>
				Effect.acquireUseRelease(
					gate.withPermits(1)(
						Effect.gen(function* () {
							if (!(yield* canWarm(projectId))) return;
							const preparation = { draftId, projectId };
							preparations.set(originId, preparation);
							return preparation;
						}),
					),
					(preparation) =>
						Effect.gen(function* () {
							if (!preparation) return;
							const input = yield* resolveInput;
							if (!input || preparations.get(originId) !== preparation) return;
							return yield* Effect.uninterruptibleMask((restore) =>
								gate
									.withPermits(1)(
										Effect.gen(function* () {
											if (preparations.get(originId) !== preparation) return;
											if (!(yield* canWarm(input.projectId ?? projectId)))
												return;
											const instance = registry.getInstance("claude");
											if (!instance?.preWarmSessionEffect) return;
											const launchKey = draftLaunchKey(input);
											const current = reservations.get(originId);
											if (current) {
												// A failed warm is retried under a fresh id, never rejoined.
												const warmExit = current.warm.pollUnsafe();
												const failed =
													warmExit !== undefined &&
													(!Exit.isSuccess(warmExit) || !warmExit.value);
												if (
													current.draftId === draftId &&
													current.launchKey === launchKey &&
													current.expiresAt > Date.now() &&
													!failed
												) {
													yield* Fiber.interrupt(current.timer);
													yield* refresh(
														originId,
														draftId,
														current.sessionId,
														launchKey,
														current.warm,
														current.call,
													);
													return current.warm;
												}
												yield* discard(originId, current);
											}
											if (reservations.size >= 8) {
												const oldest = [...reservations].sort(
													(a, b) => a[1].expiresAt - b[1].expiresAt,
												)[0];
												if (oldest) yield* discard(...oldest);
											}
											if (!(yield* canWarm(input.projectId ?? projectId)))
												return;
											const sessionId = createLocalSessionId();
											const call =
												input.account && input.projectId && input.shellEnv
													? {
															sessionId,
															account: input.account,
															projectId: input.projectId,
															workspaceRoot: input.workspaceRoot,
															extraFolders: input.extraFolders,
															shellEnv: input.shellEnv,
															shellConfig: input.shellConfig,
														}
													: undefined;
											const warm = yield* Effect.forkIn(
												Effect.interruptible(
													instance.preWarmSessionEffect({
														...input,
														sessionId,
														draftPreWarm: true,
													}),
												).pipe(
													Effect.as(true),
													Effect.catchCause((cause) =>
														Effect.sync(() => {
															log.debug(
																`Draft pre-warm failed: ${String(cause)}`,
															);
															return false;
														}),
													),
												),
												scope,
												{ uninterruptible: "inherit" },
											);
											yield* refresh(
												originId,
												draftId,
												sessionId,
												launchKey,
												warm,
												call,
											);
											return warm;
										}),
									)
									.pipe(
										Effect.flatMap((warm) =>
											warm ? restore(Fiber.join(warm)) : Effect.void,
										),
										Effect.asVoid,
									),
							);
						}),
					(preparation) =>
						Effect.sync(() => {
							if (preparations.get(originId) === preparation)
								preparations.delete(originId);
						}),
				),
			take: (originId, draftId, launchKey) =>
				gate
					.withPermits(1)(
						Effect.gen(function* () {
							// Fence this draft's pending hint even when its reservation was consumed.
							if (preparations.get(originId)?.draftId === draftId)
								preparations.delete(originId);
							const entry = reservations.get(originId);
							if (!entry || entry.draftId !== draftId) return undefined;
							if (
								(entry.call !== undefined &&
									!(yield* canWarm(entry.call.projectId))) ||
								entry.expiresAt <= Date.now() ||
								entry.launchKey !== launchKey
							) {
								yield* discard(originId, entry);
								return undefined;
							}
							reservations.delete(originId);
							yield* Fiber.interrupt(entry.timer);
							return entry.sessionId;
						}),
					)
					.pipe(Effect.uninterruptible),
		};
	}),
);
