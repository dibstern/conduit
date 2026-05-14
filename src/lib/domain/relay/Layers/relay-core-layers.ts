import { Effect, Layer } from "effect";
import { GapEndpoints } from "../../../instance/gap-endpoints.js";
import { OpenCodeAPI } from "../../../instance/opencode-api.js";
import { createSdkClientEffect } from "../../../instance/sdk-factory.js";
import { createLogger } from "../../../logger.js";
import type { ProjectRelayConfig } from "../../../types.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
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

export const OpenCodeAPILive: Layer.Layer<OpenCodeAPITag, never, ConfigTag> =
	Layer.effect(
		OpenCodeAPITag,
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const {
				client: sdkClient,
				fetch: sdkFetch,
				authHeaders,
			} = yield* createSdkClientEffect({
				baseUrl: config.opencodeUrl,
				...(config.noServer &&
					config.projectDir != null && {
						directory: config.projectDir,
					}),
			});

			const gapEndpoints = new GapEndpoints({
				baseUrl: config.opencodeUrl,
				fetch: sdkFetch,
				headers: authHeaders,
			});

			return new OpenCodeAPI({
				sdk: sdkClient,
				gapEndpoints,
				baseUrl: config.opencodeUrl,
				authHeaders,
			});
		}),
	);
