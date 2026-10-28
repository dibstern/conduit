// Driver refusals must survive the socket connection, including legacy hellos.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { expect } from "vitest";
import { connectRunner } from "../../../src/lib/provider/runner/runner-connection.js";
import {
	RUNNER_PROTOCOL_VERSION,
	RunnerSocket,
} from "../../../src/lib/provider/runner/runner-protocol.js";

for (const driverKind of ["claude", "cursor", "codex"] as const) {
	for (const peerDriver of ["claude", "cursor", "codex", undefined]) {
		if ((peerDriver ?? "claude") === driverKind) continue;
		it.effect(
			`${driverKind} refuses a ${peerDriver ?? "legacy Claude"} runner with runner_incompatible`,
			() =>
				Effect.gen(function* () {
					const root = yield* Effect.acquireRelease(
						Effect.sync(() => mkdtempSync(join(tmpdir(), "runner-driver-"))),
						(root) =>
							Effect.sync(() => rmSync(root, { recursive: true, force: true })),
					);
					const path = join(root, "runner.sock");
					const peers: RunnerSocket[] = [];
					const server = yield* Effect.acquireRelease(
						Effect.sync(() =>
							createServer((socket) => {
								const peer = new RunnerSocket(
									socket,
									(message) => {
										if (message.type === "hello")
											peer.write({
												type: "hello",
												protocolVersion: RUNNER_PROTOCOL_VERSION,
												stampsRunIds: true,
												buildId: "fixture",
												runnerId: "runner",
												sessionId: "session",
												...(peerDriver ? { driverKind: peerDriver } : {}),
											});
									},
									() => {},
								);
								peers.push(peer);
							}),
						),
						(server) =>
							Effect.callback<void>((resume) => {
								for (const peer of peers) peer.destroy();
								server.close(() => resume(Effect.void));
							}),
					);
					yield* Effect.callback<void, unknown>((resume) => {
						server.once("error", (cause) => resume(Effect.fail(cause)));
						server.listen(path, () => resume(Effect.void));
					});
					const result = yield* connectRunner({
						socketPath: path,
						sessionId: "session",
						runnerId: "runner",
						driverKind,
						deps: { workspaceRoot: root },
						runFork: () => undefined,
						emit: () => Effect.succeed({}),
						onHello: () => Effect.void,
						onClose: () => {},
					}).pipe(Effect.result);
					expect(Result.isFailure(result) && result.failure).toMatchObject({
						code: "runner_incompatible",
						operation: "runner hello",
						message: expect.stringContaining("Runner driver mismatch"),
					});
				}),
		);
	}
}
