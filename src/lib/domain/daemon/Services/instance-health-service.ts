import { Buffer } from "node:buffer";
import { Context, Effect, Layer } from "effect";
import type { OpenCodeInstance } from "../../../shared-types.js";

export interface InstanceHealthCheckInput {
	readonly instance: OpenCodeInstance;
	readonly url: string;
}

export interface InstanceHealthCheckService {
	readonly check: (input: InstanceHealthCheckInput) => Effect.Effect<boolean>;
}

export class InstanceHealthCheckTag extends Context.Tag("InstanceHealthCheck")<
	InstanceHealthCheckTag,
	InstanceHealthCheckService
>() {}

const healthUrl = (baseUrl: string): string =>
	new URL(
		"/health",
		baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
	).toString();

const authHeaders = (
	instance: OpenCodeInstance,
): Record<string, string> | undefined => {
	const password =
		instance.env?.["OPENCODE_SERVER_PASSWORD"] ??
		process.env["OPENCODE_SERVER_PASSWORD"];
	if (!password) return undefined;

	const username =
		instance.env?.["OPENCODE_SERVER_USERNAME"] ??
		process.env["OPENCODE_SERVER_USERNAME"] ??
		"opencode";

	return {
		Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
	};
};

export const InstanceHealthCheckLiveService: InstanceHealthCheckService = {
	check: ({ instance, url }) =>
		Effect.tryPromise({
			try: async () => {
				const headers = authHeaders(instance);
				const res = await fetch(
					healthUrl(url),
					headers === undefined ? undefined : { headers },
				);
				return res.ok;
			},
			catch: () => false,
		}).pipe(Effect.catchAll(() => Effect.succeed(false))),
};

export const InstanceHealthCheckLive: Layer.Layer<InstanceHealthCheckTag> =
	Layer.succeed(InstanceHealthCheckTag, InstanceHealthCheckLiveService);
