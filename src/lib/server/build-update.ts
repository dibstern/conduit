import { readFile, stat } from "node:fs/promises";
import { Effect, Layer, PubSub } from "effect";
import { BUILD_ID } from "../build-id.js";
import {
	DaemonEvent,
	DaemonEventBusTag,
} from "../domain/daemon/Services/daemon-pubsub.js";
import { isRecord } from "../utils.js";

// Captured once so detection and the connection handshake use the same identity.
export const SERVER_BUILD_ID =
	process.env["CONDUIT_SERVER_BUILD_ID"] ?? BUILD_ID;

let restartAvailable = false;

export const getRestartAvailable = (): boolean => restartAvailable;

export const isServerSupervised = (): boolean =>
	process.env["CONDUIT_SERVICE"] === "1" ||
	process.env["XPC_SERVICE_NAME"] === "dev.conduit.server";

// Only the daemon starts this layer; SubscribeServerStatus reads its snapshot.
export const ServerBuildUpdateLive = Layer.effectDiscard(
	Effect.gen(function* () {
		if (!isServerSupervised() || SERVER_BUILD_ID === "dev") return;
		const bus = yield* DaemonEventBusTag;

		const markerPath =
			process.env["CONDUIT_BUILD_READY_PATH"] ??
			new URL("../../../build-ready.json", import.meta.url);
		let lastModified: number | null = null;
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				restartAvailable = false;
			}),
		);

		const check = Effect.gen(function* () {
			const modified = yield* Effect.tryPromise(() => stat(markerPath)).pipe(
				Effect.map((info) => info.mtimeMs),
				Effect.catch(() => Effect.succeed(null)),
			);
			if (modified === lastModified) return;
			lastModified = modified;
			const available =
				modified !== null &&
				(yield* Effect.tryPromise(async () => {
					const marker: unknown = JSON.parse(
						await readFile(markerPath, "utf8"),
					);
					return (
						isRecord(marker) &&
						typeof marker["buildId"] === "string" &&
						marker["buildId"].trim().length > 0 &&
						marker["buildId"] !== SERVER_BUILD_ID
					);
				}).pipe(Effect.catch(() => Effect.succeed(false))));
			if (available === restartAvailable) return;
			restartAvailable = available;
			yield* PubSub.publish(bus, DaemonEvent.RestartAvailabilityChanged());
		});

		yield* check;
		yield* check.pipe(
			Effect.delay(
				process.env["NODE_ENV"] === "test"
					? Number(process.env["CONDUIT_TEST_BUILD_POLL_INTERVAL_MS"] ?? 5000)
					: 5000,
			),
			Effect.forever,
			Effect.forkScoped,
		);
	}),
);
