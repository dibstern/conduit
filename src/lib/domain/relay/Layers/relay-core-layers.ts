import { Effect, Layer } from "effect";
import { defaultInstanceIdForDriver } from "../../../contracts/provider-instance.js";
import { OpenCodeAPI } from "../../../instance/opencode-api.js";
import {
	createSdkClient,
	type OpenCodeEndpointAuth,
} from "../../../instance/sdk-factory.js";
import { createLogger } from "../../../logger.js";
import type { ProjectRelayConfig } from "../../../types.js";
import { OpenCodeInstancesTag } from "../../daemon/Services/opencode-instances-service.js";
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

export const OpenCodeAPILive: Layer.Layer<
	OpenCodeAPITag,
	never,
	ConfigTag | OpenCodeInstancesTag
> = Layer.effect(
	OpenCodeAPITag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const instances = yield* OpenCodeInstancesTag;
		// The endpoint the last request resolved, for synchronous readers.
		let current: OpenCodeEndpointAuth = {
			baseUrl: config.opencodeUrl ?? "",
			authHeaders: {},
		};
		const { client: sdk } = createSdkClient({
			baseUrl: "http://opencode.invalid",
			// Each request resolves the relay's instance through `use`: a stopped
			// instance starts first, and a respawn on another port is followed.
			resolveEndpoint: Effect.scoped(
				instances.use(defaultInstanceIdForDriver("opencode")),
			).pipe(
				Effect.map((client) => {
					current = {
						baseUrl: client.getBaseUrl(),
						authHeaders: client.getAuthHeaders(),
					};
					return current;
				}),
			),
			...(config.noServer &&
				config.projectDir != null && {
					directory: config.projectDir,
				}),
		});
		return Object.assign(
			new OpenCodeAPI({ sdk, baseUrl: current.baseUrl, authHeaders: {} }),
			{
				getBaseUrl: () => current.baseUrl,
				getAuthHeaders: () => ({ ...current.authHeaders }),
			},
		);
	}),
);
