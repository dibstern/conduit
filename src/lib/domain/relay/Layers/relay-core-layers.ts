import { Effect, Layer, Option } from "effect";
import { defaultInstanceIdForDriver } from "../../../contracts/provider-instance.js";
import { OpenCodeAPI } from "../../../instance/opencode-api.js";
import {
	createSdkClient,
	type OpenCodeEndpointAuth,
} from "../../../instance/sdk-factory.js";
import { createLogger } from "../../../logger.js";
import type { ProjectRelayConfig } from "../../../types.js";
import {
	OpenCodeInstancesTag,
	OpenCodeUnavailable,
} from "../../daemon/Services/opencode-instances-service.js";
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

/**
 * The relay's default client. Each request resolves the relay's instance:
 * through `use` when `startsInstance` (a stopped instance starts first), else
 * through `ifRunning` (fails while stopped). Either way a respawn on another
 * port is followed.
 */
const makeOpenCodeAPI = (startsInstance: boolean) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const instances = yield* OpenCodeInstancesTag;
		const instanceId = defaultInstanceIdForDriver("opencode");
		// The endpoint the last request resolved, for synchronous readers.
		let current: OpenCodeEndpointAuth = {
			baseUrl: config.opencodeUrl ?? "",
			authHeaders: {},
		};
		const { client: sdk } = createSdkClient({
			baseUrl: "http://opencode.invalid",
			resolveEndpoint: Effect.scoped(
				startsInstance
					? instances.use(instanceId)
					: Effect.flatMap(
							instances.ifRunning(instanceId),
							Option.match({
								onNone: () =>
									Effect.fail(
										new OpenCodeUnavailable({
											instanceId,
											reason: "unreachable",
											message: `OpenCode instance "${instanceId}" is not running`,
										}),
									),
								onSome: Effect.succeed,
							}),
						),
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
	});

/** For user actions: a request starts a stopped instance. */
export const OpenCodeAPILive: Layer.Layer<
	OpenCodeAPITag,
	never,
	ConfigTag | OpenCodeInstancesTag
> = Layer.effect(OpenCodeAPITag, makeOpenCodeAPI(true));

/** For background and polling paths: never starts OpenCode. */
export const backgroundOpenCodeAPI = makeOpenCodeAPI(false);
