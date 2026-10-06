import { Data, Effect } from "effect";
import { DEFAULT_OPENCODE_PORT } from "../../../constants.js";
import { defaultInstanceIdForDriver } from "../../../contracts/provider-instance.js";
import {
	findFreePort,
	isOpencodeInstalled,
	probeOpenCode,
} from "../../../daemon/daemon-utils.js";
import { canReuseManagedOpenCode } from "../../../instance/managed-opencode-process.js";
import type { DaemonInstanceConfig } from "./daemon-state.js";

/**
 * Canonical id for the default OpenCode instance. The composer rail keys every
 * non-Claude provider to this id, so the daemon must seed the default OpenCode
 * server under the same id or the OpenCode harness is unpickable/duplicated.
 */
const DEFAULT_OPENCODE_INSTANCE_ID: string =
	defaultInstanceIdForDriver("opencode");

export class OpenCodeUnavailableError extends Data.TaggedError(
	"OpenCodeUnavailableError",
)<{
	readonly url: string;
	readonly port: number;
}> {
	override get message(): string {
		return (
			`OpenCode is not running at ${this.url} and the "opencode" ` +
			"binary was not found on PATH.\n" +
			"Install OpenCode first: https://opencode.ai\n" +
			`Or start it manually: opencode serve --port ${this.port}`
		);
	}
}

export interface SmartDefaultInstanceOptions {
	readonly defaultOpencodeUrl?: string | undefined;
	/** Resolve the default instance on first use instead of trusting its URL. */
	readonly smartDefault?: boolean | undefined;
	/** Where smart default looks for OpenCode (default: DEFAULT_OPENCODE_URL). */
	readonly smartDefaultUrl?: string | undefined;
}

const portFromUrl = (url: string): number => {
	try {
		const parsed = new URL(url);
		return parsed.port
			? Number.parseInt(parsed.port, 10)
			: DEFAULT_OPENCODE_PORT;
	} catch {
		return DEFAULT_OPENCODE_PORT;
	}
};

export const defaultInstanceForUrl = (url: string): DaemonInstanceConfig => ({
	id: DEFAULT_OPENCODE_INSTANCE_ID,
	name: "Default",
	port: portFromUrl(url),
	managed: false,
	url,
});

const defaultUrlForInstance = (instance: DaemonInstanceConfig): string =>
	instance.url ?? `http://localhost:${instance.port}`;

const probeReachable = (url: string, env?: Record<string, string>) =>
	Effect.tryPromise(() => probeOpenCode(url, env)).pipe(
		Effect.orElseSucceed(() => false),
	);

const hasOpenCodeBinary = Effect.tryPromise(() => isOpencodeInstalled()).pipe(
	Effect.orElseSucceed(() => false),
);

const findAvailablePort = (startFrom: number) =>
	Effect.tryPromise(() => findFreePort(startFrom)).pipe(
		Effect.catchAll((cause) => Effect.die(cause)),
	);

const convertUnreachableDefault = (instance: DaemonInstanceConfig) =>
	Effect.gen(function* () {
		const url = defaultUrlForInstance(instance);
		const reachable = yield* probeReachable(url, instance.env);
		if (reachable) return instance;

		const installed = yield* hasOpenCodeBinary;
		if (!installed) {
			return yield* new OpenCodeUnavailableError({
				url,
				port: instance.port,
			});
		}

		const freePort = yield* findAvailablePort(instance.port);
		const { url: _url, ...managedInstance } = instance;
		return {
			...managedInstance,
			port: freePort,
			managed: true,
		} satisfies DaemonInstanceConfig;
	});

const resolvePersistedManagedDefault = (
	instance: DaemonInstanceConfig,
	smartDefaultUrl: string,
) =>
	Effect.gen(function* () {
		// Our supervised OpenCode outlives a restart and may be the listener on
		// smartDefaultUrl. Keep it managed so its credentials stay in use.
		const ownSurvivor = yield* Effect.tryPromise(() =>
			canReuseManagedOpenCode(instance),
		).pipe(Effect.orElseSucceed(() => false));
		if (ownSurvivor) return instance;

		const reachable = yield* probeReachable(smartDefaultUrl);
		if (reachable) {
			return { ...defaultInstanceForUrl(smartDefaultUrl), name: instance.name };
		}

		const installed = yield* hasOpenCodeBinary;
		if (!installed) {
			return yield* new OpenCodeUnavailableError({
				url: smartDefaultUrl,
				port: portFromUrl(smartDefaultUrl),
			});
		}

		const freePort = yield* findAvailablePort(instance.port);
		const { url: _url, ...managedInstance } = instance;
		return {
			...managedInstance,
			port: freePort,
			managed: true,
		} satisfies DaemonInstanceConfig;
	});

/**
 * First-use smart default: reuse a reachable OpenCode at the default URL and
 * run a managed one only when nothing answers there at that moment.
 */
export const resolveSmartDefaultInstance = (
	instance: DaemonInstanceConfig,
	smartDefaultUrl: string,
): Effect.Effect<DaemonInstanceConfig, OpenCodeUnavailableError> =>
	(instance.managed
		? resolvePersistedManagedDefault(instance, smartDefaultUrl)
		: convertUnreachableDefault(instance)
	).pipe(Effect.withSpan("daemon.smartDefault.resolveInstance"));
