import { Data, Effect } from "effect";
import {
	DEFAULT_OPENCODE_PORT,
	DEFAULT_OPENCODE_URL,
} from "../../../constants.js";
import {
	findFreePort,
	isOpencodeInstalled,
	probeOpenCode,
} from "../../../daemon/daemon-utils.js";
import type { DaemonInstanceConfig } from "./daemon-state.js";

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
	readonly smartDefault?: boolean | undefined;
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
	id: "default",
	name: "Default",
	port: portFromUrl(url),
	managed: false,
	url,
});

const defaultUrlForInstance = (instance: DaemonInstanceConfig): string =>
	instance.url ?? `http://localhost:${instance.port}`;

const probeReachable = (url: string) =>
	Effect.tryPromise(() => probeOpenCode(url)).pipe(
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
		const reachable = yield* probeReachable(url);
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

const detectDefaultInstance = Effect.gen(function* () {
	const reachable = yield* probeReachable(DEFAULT_OPENCODE_URL);
	if (reachable) return defaultInstanceForUrl(DEFAULT_OPENCODE_URL);

	const installed = yield* hasOpenCodeBinary;
	if (!installed) {
		return yield* new OpenCodeUnavailableError({
			url: DEFAULT_OPENCODE_URL,
			port: DEFAULT_OPENCODE_PORT,
		});
	}

	const freePort = yield* findAvailablePort(DEFAULT_OPENCODE_PORT);
	return {
		id: "default",
		name: "Default",
		port: freePort,
		managed: true,
	} satisfies DaemonInstanceConfig;
});

export const resolveSmartDefaultInstances = (
	initialInstances: ReadonlyArray<DaemonInstanceConfig>,
	options: SmartDefaultInstanceOptions = {},
): Effect.Effect<
	ReadonlyArray<DaemonInstanceConfig>,
	OpenCodeUnavailableError
> =>
	Effect.gen(function* () {
		let instances = [...initialInstances];
		const existingDefault = instances.find(
			(instance) => instance.id === "default",
		);
		if (existingDefault == null && options.defaultOpencodeUrl != null) {
			instances = [
				defaultInstanceForUrl(options.defaultOpencodeUrl),
				...instances,
			];
		}

		if (options.smartDefault !== true) return instances;

		const defaultIndex = instances.findIndex(
			(instance) => instance.id === "default",
		);
		if (defaultIndex >= 0) {
			const defaultInstance = instances[defaultIndex];
			if (defaultInstance == null || defaultInstance.managed) return instances;
			const resolvedDefault = yield* convertUnreachableDefault(defaultInstance);
			return instances.map((instance, index) =>
				index === defaultIndex ? resolvedDefault : instance,
			);
		}

		return [yield* detectDefaultInstance, ...instances];
	}).pipe(Effect.withSpan("daemon.smartDefault.resolveInstances"));
