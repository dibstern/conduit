// PTY subscription adapter (conduit-test-ni8.11).
// The seam is the adapter: a real PtyManager feed behind a terminal service
// whose discovery is faked, read through `subscribePtys`.

import { describe, it } from "@effect/vitest";
import { Chunk, Effect, Fiber, Layer, Stream, TestClock } from "effect";
import { expect } from "vitest";
import type { PtyEnvelope } from "../../../src/lib/contracts/ws-rpc.js";
import { subscribePtys } from "../../../src/lib/domain/relay/Services/pty-subscription.js";
import {
	type OpenCodeTerminalService,
	OpenCodeTerminalServiceTag,
} from "../../../src/lib/domain/relay/Services/terminal-service.js";
import { PtyManager } from "../../../src/lib/relay/pty-manager.js";
import type { PtyInfo } from "../../../src/lib/shared-types.js";

const pty = (id: string, status: PtyInfo["status"] = "running"): PtyInfo => ({
	id,
	title: "Shell",
	command: "zsh",
	cwd: "/repo",
	status,
	pid: 1,
});

const upstream = () => ({
	readyState: 1,
	send: () => undefined,
	close: () => undefined,
	terminate: () => undefined,
});

const terminalLayer = (
	manager: PtyManager,
	discovered: readonly PtyInfo[] = [],
) =>
	Layer.succeed(OpenCodeTerminalServiceTag, {
		create: () => Effect.void,
		list: () => Effect.succeed([...discovered]),
		snapshot: () =>
			manager.listSessions().map(({ id, status }) => ({
				pty: { ...(manager.getSession(id)?.info ?? pty(id)), status },
				scrollback: manager.getScrollback(id),
			})),
		subscribe: (listener) => manager.subscribe(listener),
		sendInput: () => Effect.void,
		close: () => Effect.void,
		resize: () => Effect.void,
	} satisfies OpenCodeTerminalService);

/** Run the subscription until `count` envelopes arrived, driving the clock. */
const collect = (
	manager: PtyManager,
	count: number,
	publish: () => void,
	discovered: readonly PtyInfo[] = [],
) =>
	Effect.gen(function* () {
		const fiber = yield* subscribePtys().pipe(
			Stream.take(count),
			Stream.runCollect,
			Effect.fork,
		);
		// Let the subscription attach before publishing.
		yield* Effect.yieldNow();
		yield* TestClock.adjust("1 millis");
		publish();
		for (let i = 0; i < 10; i++) yield* TestClock.adjust("50 millis");
		return Chunk.toReadonlyArray(yield* Fiber.join(fiber));
	}).pipe(Effect.provide(terminalLayer(manager, discovered)));

const outputs = (envelopes: readonly PtyEnvelope[]) =>
	envelopes.filter(
		(envelope): envelope is Extract<PtyEnvelope, { _tag: "output" }> =>
			envelope._tag === "output",
	);

describe("subscribePtys", () => {
	it.effect(
		"opens with every PTY and its scrollback, then synchronized",
		() => {
			const manager = new PtyManager({});
			manager.registerSession("pty-1", upstream(), "local", pty("pty-1"));
			manager.appendScrollback("pty-1", "hello ");
			manager.appendScrollback("pty-1", "world");
			return Effect.gen(function* () {
				const envelopes = yield* collect(manager, 2, () => undefined, [
					pty("pty-2", "exited"),
				]);
				expect(envelopes).toEqual([
					{
						_tag: "snapshot",
						rows: [
							{ pty: pty("pty-1"), scrollback: "hello world" },
							{ pty: pty("pty-2", "exited"), scrollback: "" },
						],
					},
					{ _tag: "synchronized" },
				]);
			});
		},
	);

	it.effect(
		"a burst of writes inside one 50 ms window arrives as far fewer envelopes",
		() => {
			const manager = new PtyManager({});
			manager.registerSession("pty-1", upstream(), "local", pty("pty-1"));
			// Below the 512-event chunk bound, so one window holds the whole burst.
			const writes = Array.from({ length: 500 }, (_, i) => `${i},`);
			return Effect.gen(function* () {
				const envelopes = yield* collect(manager, 3, () => {
					for (const data of writes)
						manager.publish({ _tag: "output", ptyId: "pty-1", data });
				});
				const live = outputs(envelopes);
				expect(live.length).toBeLessThanOrEqual(1);
				expect(live.map(({ data }) => data).join("")).toBe(writes.join(""));
			});
		},
	);

	it.effect(
		"keeps each terminal's own order across an exit and a replace",
		() => {
			const manager = new PtyManager({});
			manager.registerSession("pty-1", upstream(), "local", pty("pty-1"));
			manager.registerSession("pty-2", upstream(), "local", pty("pty-2"));
			return Effect.gen(function* () {
				const envelopes = yield* collect(manager, 6, () => {
					manager.publish({ _tag: "output", ptyId: "pty-1", data: "a" });
					manager.publish({ _tag: "output", ptyId: "pty-2", data: "x" });
					manager.publish({ _tag: "output", ptyId: "pty-1", data: "b" });
					manager.publish({ _tag: "upsert", item: pty("pty-1", "exited") });
					manager.publish({ _tag: "output", ptyId: "pty-1", data: "c" });
					manager.publish({
						_tag: "output",
						ptyId: "pty-2",
						data: "fresh",
						replace: true,
					});
					manager.publish({ _tag: "output", ptyId: "pty-2", data: "!" });
				});
				expect(envelopes.slice(2)).toEqual([
					{ _tag: "output", ptyId: "pty-1", data: "ab" },
					{ _tag: "output", ptyId: "pty-2", data: "fresh!", replace: true },
					{ _tag: "upsert", item: pty("pty-1", "exited") },
					{ _tag: "output", ptyId: "pty-1", data: "c" },
				]);
			});
		},
	);

	it.effect("every subscriber on the project sees the same terminals", () => {
		const manager = new PtyManager({});
		manager.registerSession("pty-1", upstream(), "local", pty("pty-1"));
		return Effect.gen(function* () {
			const subscriber = subscribePtys().pipe(
				Stream.take(4),
				Stream.runCollect,
				Effect.map(Chunk.toReadonlyArray),
				Effect.fork,
			);
			const a = yield* subscriber;
			const b = yield* subscriber;
			yield* Effect.yieldNow();
			yield* TestClock.adjust("1 millis");
			manager.publish({ _tag: "output", ptyId: "pty-1", data: "ls\r\n" });
			yield* TestClock.adjust("60 millis");
			manager.publish({ _tag: "remove", id: "pty-1" });
			for (let i = 0; i < 4; i++) yield* TestClock.adjust("50 millis");
			const seenByA = yield* Fiber.join(a);
			expect(yield* Fiber.join(b)).toEqual(seenByA);
			expect(seenByA.slice(2)).toEqual([
				{ _tag: "output", ptyId: "pty-1", data: "ls\r\n" },
				{ _tag: "remove", id: "pty-1" },
			]);
			expect(manager.listenerCount).toBe(0);
		}).pipe(Effect.provide(terminalLayer(manager)));
	});
});
