import { Effect, Layer } from "effect";
import { createLogger } from "../../../logger.js";
import type { ProjectRelayConfig } from "../../../types.js";
import { ConfigTag, LoggerTag } from "../Services/services.js";

export const makeProjectRelayConfigLive = (
	config: ProjectRelayConfig,
): Layer.Layer<ConfigTag> => Layer.sync(ConfigTag, () => config);

export const ProjectRelayLoggerLive: Layer.Layer<LoggerTag, never, ConfigTag> =
	Layer.effect(
		LoggerTag,
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			return config.log ?? createLogger("relay");
		}),
	);
