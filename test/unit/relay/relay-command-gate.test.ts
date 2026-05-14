import { describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { expect } from "vitest";
import {
	makeRelayCommandGate,
	RelayCommandRejected,
} from "../../../src/lib/domain/relay/Services/relay-command-gate.js";
import type { QueuedRelayCommand } from "../../../src/lib/domain/relay/Services/relay-domain-model.js";

const command = (
	commandId: string,
	messageType = "message",
): QueuedRelayCommand => ({
	commandId,
	clientId: "client-1",
	messageType,
	receivedAt: 1000,
});

describe("RelayCommandGate", () => {
	it.effect("queues commands until ready, then drains them FIFO", () =>
		Effect.gen(function* () {
			const gate = yield* makeRelayCommandGate("project-a");
			const order: string[] = [];

			const first = yield* gate
				.submit(
					command("cmd-a"),
					Effect.sync(() => {
						order.push("cmd-a");
						return "a";
					}),
				)
				.pipe(Effect.fork);
			const second = yield* gate
				.submit(
					command("cmd-b"),
					Effect.sync(() => {
						order.push("cmd-b");
						return "b";
					}),
				)
				.pipe(Effect.fork);

			yield* Effect.yieldNow();
			expect(order).toEqual([]);

			yield* gate.markReady(2000);

			expect(yield* Fiber.join(first)).toBe("a");
			expect(yield* Fiber.join(second)).toBe("b");
			expect(order).toEqual(["cmd-a", "cmd-b"]);

			const snapshot = yield* gate.snapshot;
			expect(snapshot.lifecycle).toBe("ready");
			expect(snapshot.queuedCommands).toEqual([]);
			expect(snapshot.completedCommandIds.has("cmd-a")).toBe(true);
			expect(snapshot.completedCommandIds.has("cmd-b")).toBe(true);
		}).pipe(Effect.scoped),
	);

	it.effect("runs commands immediately after the relay is ready", () =>
		Effect.gen(function* () {
			const gate = yield* makeRelayCommandGate("project-a");

			yield* gate.markReady(2000);
			const result = yield* gate.submit(
				command("cmd-ready"),
				Effect.succeed(42),
			);

			expect(result).toBe(42);
			const snapshot = yield* gate.snapshot;
			expect(snapshot.inFlightCommandIds.has("cmd-ready")).toBe(false);
			expect(snapshot.completedCommandIds.has("cmd-ready")).toBe(true);
		}).pipe(Effect.scoped),
	);

	it.effect(
		"propagates queued failures and keeps draining later commands",
		() =>
			Effect.gen(function* () {
				const gate = yield* makeRelayCommandGate("project-a");
				const order: string[] = [];

				const failed = yield* gate
					.submit(
						command("cmd-fail"),
						Effect.sync(() => {
							order.push("cmd-fail");
						}).pipe(Effect.zipRight(Effect.fail("boom"))),
					)
					.pipe(Effect.either, Effect.fork);
				const succeeded = yield* gate
					.submit(
						command("cmd-ok"),
						Effect.sync(() => {
							order.push("cmd-ok");
							return "ok";
						}),
					)
					.pipe(Effect.either, Effect.fork);

				yield* gate.markReady(2000);

				const failedResult = yield* Fiber.join(failed);
				const succeededResult = yield* Fiber.join(succeeded);

				expect(failedResult).toMatchObject({ _tag: "Left", left: "boom" });
				expect(succeededResult).toMatchObject({ _tag: "Right", right: "ok" });
				expect(order).toEqual(["cmd-fail", "cmd-ok"]);
			}).pipe(Effect.scoped),
	);

	it.effect("rejects duplicate command ids while a command is queued", () =>
		Effect.gen(function* () {
			const gate = yield* makeRelayCommandGate("project-a");

			const first = yield* gate
				.submit(command("cmd-a"), Effect.succeed("first"))
				.pipe(Effect.fork);
			yield* Effect.yieldNow();

			const duplicate = yield* gate
				.submit(command("cmd-a"), Effect.succeed("duplicate"))
				.pipe(Effect.either);

			expect(duplicate._tag).toBe("Left");
			if (duplicate._tag === "Left") {
				expect(duplicate.left).toBeInstanceOf(RelayCommandRejected);
				expect(duplicate.left.reason).toBe("duplicate");
			}

			yield* gate.markReady(2000);
			expect(yield* Fiber.join(first)).toBe("first");
		}).pipe(Effect.scoped),
	);
});
