import { readFile, stat } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { BUILD_ID } from "../build-id.js";
import { DaemonWsClientRegistryTag } from "../domain/daemon/Services/daemon-ws-client-registry.js";
import { broadcastToAll } from "../domain/daemon/Services/project-registry-service.js";
import { isRecord } from "../utils.js";

// Captured once so detection and the connection handshake use the same identity.
export const SERVER_BUILD_ID =
	process.env["CONDUIT_SERVER_BUILD_ID"] ?? BUILD_ID;

let restartAvailable = false;

export const getRestartAvailable = (): boolean => restartAvailable;

// Only the daemon starts this layer; relays read its process-wide snapshot.
export const ServerBuildUpdateLive = Layer.scopedDiscard(
	Effect.gen(function* () {
		const supervised =
			process.env["CONDUIT_SERVICE"] === "1" ||
			process.env["XPC_SERVICE_NAME"] === "dev.conduit.server";
		if (!supervised || SERVER_BUILD_ID === "dev") return;
		const daemonWsClients = yield* DaemonWsClientRegistryTag;

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
				Effect.orElseSucceed(() => null),
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
				}).pipe(Effect.orElseSucceed(() => false)));
			if (available === restartAvailable) return;
			restartAvailable = available;
			const message = { type: "server_update", restartAvailable } as const;
			// Relays reach attached browsers; the root view has no relay.
			yield* broadcastToAll(message);
			yield* daemonWsClients.broadcastUnattached(message);
		});

		yield* check;
		yield* check.pipe(
			Effect.delay("5 seconds"),
			Effect.forever,
			Effect.forkScoped,
		);
	}),
);
