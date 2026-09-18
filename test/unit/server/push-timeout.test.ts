import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";
import { expect, it, vi } from "vitest";
import { AlertLedgerLive } from "../../../src/lib/domain/relay/Services/alert-ledger.js";
import { SessionEventBusTag } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import type { Logger } from "../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { createAllEffectProjectors } from "../../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { sendPushForEventEffect } from "../../../src/lib/relay/sse-wiring.js";
import {
	type PushDeliveryReport,
	PushNotificationManager,
	type WebPushModule,
} from "../../../src/lib/server/push.js";

it.each([
	"sendTo",
	"sendToAll",
] as const)("%s reports an uncancellable transport as failed after the service deadline", async (method) => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-push-timeout-"));
	const sendNotification = vi.fn<WebPushModule["sendNotification"]>();
	sendNotification.mockImplementationOnce(() => new Promise(() => {}));
	sendNotification.mockResolvedValue({ statusCode: 201 });
	const manager = new PushNotificationManager({
		configDir: dir,
		_webpush: {
			generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
			sendNotification,
		},
	});
	try {
		await manager.init();
		manager.addSubscription("device", { endpoint: "https://push.example/a" });
		vi.useFakeTimers();
		const send = () =>
			method === "sendTo"
				? manager.sendTo("device", { title: "Waiting", body: "Answer?" })
				: manager.sendToAll({ title: "Waiting", body: "Answer?" });
		const reports: PushDeliveryReport[] = [];
		void send().then((report) => reports.push(report));
		await vi.advanceTimersByTimeAsync(9_999);
		expect(reports).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(reports).toEqual([
			{
				delivered: [],
				expired: [],
				failed: [{ clientId: "device", cause: expect.any(Error) }],
			},
		]);
		expect(await send()).toEqual({
			delivered: ["device"],
			expired: [],
			failed: [],
		});
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("releases a timed-out delivery claim so a later observation reaches the device", async () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-push-timeout-ledger-"));
	let signalStarted = () => {};
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const sendNotification = vi.fn<WebPushModule["sendNotification"]>();
	sendNotification.mockImplementationOnce(() => {
		signalStarted();
		return new Promise(() => {});
	});
	sendNotification.mockResolvedValue({ statusCode: 201 });
	const manager = new PushNotificationManager({
		configDir: dir,
		_webpush: {
			generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
			sendNotification,
		},
	});
	const bus = Layer.succeed(SessionEventBusTag, {
		publish: () => Effect.void,
		publishAdvance: () => Effect.void,
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	});
	const log: Logger = {
		debug: () => {},
		verbose: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => log,
	};
	try {
		await manager.init();
		manager.addSubscription("device", { endpoint: "https://push.example/a" });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const attempt = Effect.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent(
						"session.created",
						"s1",
						{ sessionId: "s1", title: "Question", provider: "opencode" },
						{ provider: "opencode" },
					),
				]);
				const send = sendPushForEventEffect(
					manager,
					{
						type: "ask_user",
						sessionId: "s1",
						toolId: "question",
						questions: [],
					},
					log,
					{ sessionId: "s1" },
				);
				yield* send;
				yield* send;
				yield* send;
			}).pipe(
				Effect.provide(AlertLedgerLive),
				Effect.provide(
					Layer.merge(
						makePersistenceEffectLayer(
							join(dir, "events.db"),
							createAllEffectProjectors(),
							bus,
						),
						bus,
					),
				),
			),
		);
		await started;
		await vi.advanceTimersByTimeAsync(10_000);
		await attempt;
		expect(sendNotification).toHaveBeenCalledTimes(2);
	} finally {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	}
});
