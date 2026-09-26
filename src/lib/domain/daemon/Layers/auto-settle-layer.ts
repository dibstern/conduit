import { Cause, Clock, Effect, Layer, Option, Ref, Schedule } from "effect";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import { hasColdAutoSettleCandidate } from "../Services/daemon-session-reader.js";
import {
	allProjects,
	broadcastToAll,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";
import { RelayCacheTag } from "../Services/relay-cache.js";

export const AutoSettleLive = Layer.scopedDiscard(
	Effect.gen(function* () {
		const configRef = yield* DaemonConfigRefTag;
		const registry = yield* ProjectRegistryTag;
		const cache = yield* RelayCacheTag;
		const bus = yield* DaemonEventBusTag;

		const sweep = Effect.gen(function* () {
			const days = (yield* Ref.get(configRef)).autoSettleAfterDays;
			if (days === null) return;
			const idleWindowMs = (days === undefined ? 3 : days) * 86_400_000;
			const now = yield* Clock.currentTimeMillis;
			const projects = yield* allProjects.pipe(
				Effect.provideService(ProjectRegistryTag, registry),
			);
			for (const project of projects) {
				yield* Effect.gen(function* () {
					const running = yield* cache.peek(project.slug);
					const relay = Option.isSome(running)
						? running.value
						: (yield* hasColdAutoSettleCandidate(
									project.directory,
									now,
									idleWindowMs,
								))
							? yield* cache.get(project.slug)
							: null;
					if (relay?.settleIdleSessions === undefined) return;
					const count = yield* relay.settleIdleSessions(idleWindowMs, now);
					if (count > 0)
						yield* broadcastToAll({ type: "daemon_sessions_changed" }).pipe(
							Effect.provideService(DaemonEventBusTag, bus),
						);
				}).pipe(
					Effect.catchAllCause((cause) =>
						Cause.isInterruptedOnly(cause)
							? Effect.failCause(cause)
							: Effect.logWarning("automatic settlement failed for project", {
									projectSlug: project.slug,
									cause: Cause.pretty(cause),
								}),
					),
				);
			}
		}).pipe(
			Effect.catchAllCause((cause) =>
				Cause.isInterruptedOnly(cause)
					? Effect.failCause(cause)
					: Effect.logWarning(
							"automatic settlement sweep failed",
							Cause.pretty(cause),
						),
			),
		);

		yield* sweep.pipe(
			Effect.repeat(Schedule.spaced("1 minute")),
			Effect.forkScoped,
		);
	}),
);
