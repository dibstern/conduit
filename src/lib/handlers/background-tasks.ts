import { Effect } from "effect";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../daemon/config-persistence.js";
import {
	BackgroundLivenessTag,
	ConfigTag,
	OrchestrationEngineTag,
} from "../domain/relay/Services/services.js";
import { ProviderInstanceFailure } from "../provider/errors.js";
import { ProviderRegistryTag } from "../provider/provider-registry.js";

export const stopBackgroundTaskById = (sessionId: string, taskId: string) =>
	Effect.gen(function* () {
		const backgroundOf = yield* BackgroundLivenessTag;
		const isLive = () =>
			backgroundOf(sessionId)?.tasks.some((task) => task.id === taskId) ===
			true;
		if (!isLive()) return;
		const engine = yield* OrchestrationEngineTag;
		const instanceId = yield* engine.getProviderForSessionEffect(sessionId);
		const { configDir } = yield* ConfigTag;
		const driver =
			instanceId &&
			resolveProviderRoutingDriver(loadDaemonConfig(configDir), instanceId);
		const registry = yield* ProviderRegistryTag;
		const provider = driver ? registry.getInstance(driver) : undefined;
		if (!provider?.stopTaskEffect)
			return yield* Effect.fail(
				new ProviderInstanceFailure({
					providerId: instanceId ?? "unknown",
					operation: "stopTask",
					cause: new Error(
						"This provider cannot stop individual background tasks",
					),
				}),
			);
		yield* provider.stopTaskEffect(sessionId, taskId).pipe(
			// Another client or the task itself may finish it while the SDK answers.
			Effect.catchAll((error) => (isLive() ? Effect.fail(error) : Effect.void)),
		);
	});
