import { Context, Effect, Exit, Fiber, Layer, Option } from "effect";
import type { OpenCodeAPI } from "../../../instance/opencode-api.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import type { PreWarmSessionInput } from "../../../provider/types.js";
import { LoggerTag } from "./services.js";
import { createLocalSessionId } from "./session-manager-service.js";

export const draftLaunchKey = (
	input: Omit<PreWarmSessionInput, "sessionId" | "providerState">,
) =>
	JSON.stringify({
		accountId: input.instanceId,
		model: input.model,
		variant: input.variant,
		contextWindow: input.contextWindow,
		permissionMode: input.permissionMode,
		agent: input.agent,
		workspaceRoot: input.workspaceRoot,
		extraFolders: input.extraFolders,
	});

export class DraftPreWarmTag extends Context.Tag("DraftPreWarm")<
	DraftPreWarmTag,
	{
		readonly discardSession: (sessionId: string) => Effect.Effect<void>;
		readonly warmDirectory: (
			instanceId: string,
			client: OpenCodeAPI,
			directory: string,
		) => Effect.Effect<void, unknown>;
		readonly warm: (
			originId: string,
			draftId: string,
			input: Omit<PreWarmSessionInput, "sessionId">,
		) => Effect.Effect<void>;
		readonly take: (
			originId: string,
			draftId: string,
			launchKey: string | undefined,
		) => Effect.Effect<string | undefined>;
	}
>() {}

/** Reservations belong to this relay and must die before its provider detaches. */
export const DraftPreWarmLive = Layer.scoped(
	DraftPreWarmTag,
	Effect.gen(function* () {
		const registry = yield* ProviderRegistryTag;
		const log = yield* LoggerTag;
		const scope = yield* Effect.scope;
		const gate = yield* Effect.makeSemaphore(1);
		const directoryGate = yield* Effect.makeSemaphore(1);
		const configured = Number(
			process.env["CONDUIT_TEST_DRAFT_PREWARM_TTL_MS"] ?? 600_000,
		);
		const ttl =
			Number.isInteger(configured) && configured > 0 ? configured : 600_000;
		type Reservation = {
			readonly draftId: string;
			readonly sessionId: string;
			readonly launchKey: string;
			readonly expiresAt: number;
			readonly warm: Fiber.RuntimeFiber<boolean>;
			readonly timer: Fiber.RuntimeFiber<void>;
		};
		// One entry per origin also bounds live runners while switching drafts.
		const reservations = new Map<string, Reservation>();
		const directories = new Map<
			string,
			{ identity: string; paths: Set<string> }
		>();
		const end = (sessionId: string) =>
			(
				registry.getInstance("claude")?.endSessionEffect(sessionId) ??
				Effect.void
			).pipe(
				Effect.catchAllCause((cause) =>
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
				yield* end(entry.sessionId);
			});
		const refresh = (
			originId: string,
			draftId: string,
			sessionId: string,
			launchKey: string,
			warm: Fiber.RuntimeFiber<boolean>,
		) =>
			Effect.gen(function* () {
				const expiresAt = Date.now() + ttl;
				const timer = yield* Effect.forkIn(
					Effect.sleep(ttl).pipe(
						Effect.zipRight(
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
									yield* end(sessionId);
								}).pipe(Effect.uninterruptible),
							),
						),
						Effect.interruptible,
					),
					scope,
				);
				reservations.set(originId, {
					draftId,
					sessionId,
					launchKey,
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
			warm: (originId, draftId, input) =>
				Effect.uninterruptibleMask((restore) =>
					gate
						.withPermits(1)(
							Effect.gen(function* () {
								const instance = registry.getInstance("claude");
								if (!instance?.preWarmSessionEffect) return;
								const launchKey = draftLaunchKey(input);
								const current = reservations.get(originId);
								if (current) {
									// A failed warm is retried under a fresh id, never rejoined.
									const failed = Option.exists(
										yield* Fiber.poll(current.warm),
										(exit) => !Exit.isSuccess(exit) || !exit.value,
									);
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
								const sessionId = createLocalSessionId();
								const warm = yield* Effect.forkIn(
									Effect.interruptible(
										instance.preWarmSessionEffect({
											...input,
											sessionId,
											draftPreWarm: true,
										}),
									).pipe(
										Effect.as(true),
										Effect.catchAllCause((cause) =>
											Effect.sync(() => {
												log.debug(`Draft pre-warm failed: ${String(cause)}`);
												return false;
											}),
										),
									),
									scope,
								);
								yield* refresh(originId, draftId, sessionId, launchKey, warm);
								return warm;
							}),
						)
						.pipe(
							Effect.flatMap((warm) =>
								warm ? restore(Fiber.join(warm)) : Effect.void,
							),
							Effect.asVoid,
						),
				),
			take: (originId, draftId, launchKey) =>
				gate
					.withPermits(1)(
						Effect.gen(function* () {
							const entry = reservations.get(originId);
							if (!entry || entry.draftId !== draftId) return undefined;
							if (
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
