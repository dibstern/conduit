import { Context, Duration, Effect, Layer, Option, Schedule } from "effect";
import { ENV } from "../../../env.js";
import { recordPermissionTimedOut } from "../../../handlers/permissions.js";
import { createLogger } from "../../../logger.js";
import { PendingInteractionServiceTag } from "../../relay/Services/pending-interaction-service.js";
import { LoggerTag } from "../../relay/Services/services.js";
import {
	allProjects,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";
import { ProviderAdapters } from "../Services/provider-adapters.js";

/**
 * One loop for every registered project (82tn.16): every check interval (30 seconds; tests
 * shorten it) it takes each served project's timed-out permissions and records the ones no
 * provider turn was waiting on as rejected, which takes their cards down through the approvals
 * subscription. An awaited one fails its turn, and the turn records the resolution itself.
 * A project nothing serves has no waiting asks to time out.
 */
export const PermissionTimeoutLive: Layer.Layer<
	never,
	never,
	ProviderAdapters | ProjectRegistryTag
> = Layer.effectDiscard(
	Effect.gen(function* () {
		const adapters = yield* ProviderAdapters;
		const registry = yield* ProjectRegistryTag;
		const logger = createLogger("permission-timeout");
		const check = (projectId: string) =>
			Option.match(adapters.projectContext(projectId), {
				onNone: () => Effect.void,
				onSome: (context) =>
					Effect.gen(function* () {
						const pending = Context.get(context, PendingInteractionServiceTag);
						for (const entry of yield* pending.takeTimedOutPermissions()) {
							if (!entry.awaited) yield* recordPermissionTimedOut(entry);
						}
					}).pipe(
						Effect.provide(context),
						Effect.provideService(LoggerTag, logger),
					),
			});
		yield* Effect.forkScoped(
			Effect.repeat(
				allProjects.pipe(
					Effect.provideService(ProjectRegistryTag, registry),
					Effect.flatMap((projects) =>
						Effect.forEach(projects, ({ slug }) => check(slug), {
							discard: true,
						}),
					),
				),
				Schedule.fixed(Duration.millis(ENV.permissionTimeoutCheckMs)),
			),
			{ uninterruptible: "inherit" },
		);
	}),
);
