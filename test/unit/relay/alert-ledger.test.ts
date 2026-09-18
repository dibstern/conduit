// ─── The Alert Ledger (ni8.23, loop 4) ──────────────────────────────────────
// A badge is state and can be re-derived on every reload; a ding is an alert and
// must fire exactly once. The difference is that nothing about a missed or
// duplicated ding is visible in any row afterwards, so the guarantee has to be
// written down where it can be tested: a durable claim, taken before the send,
// given back if the send does not happen.
//
// The anchor is what makes "the same alert" mean something. It is the session's
// latest turn, so a second path observing the same completed turn claims the
// same key and loses, while the next turn claims a new one and dings.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Either, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import {
	makeAlertLedger,
	type SessionAlert,
} from "../../../src/lib/domain/relay/Services/alert-ledger.js";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import { createAllEffectProjectors } from "../../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const silentBus = Layer.succeed(SessionEventBusTag, {
	publish: () => Effect.void,
	publishAdvance: () => Effect.void,
	subscribe: () => Effect.succeed(Stream.empty),
	subscribeAdvances: () => Effect.succeed(Stream.empty),
} satisfies SessionEventBus);

/** Run a body against a real store; `reopen` runs a second body on the SAME file. */
const withStore = async <A>(
	body: (
		reopen: <B>(
			second: Effect.Effect<B, unknown, PersistenceEffectContext>,
		) => Promise<B>,
	) => Effect.Effect<A, unknown, PersistenceEffectContext>,
): Promise<A> => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-alert-ledger-"));
	const dbPath = join(dir, "events.db");
	const layer = () =>
		Layer.merge(
			makePersistenceEffectLayer(
				dbPath,
				createAllEffectProjectors(),
				silentBus,
			),
			silentBus,
		);
	const reopen = <B>(
		second: Effect.Effect<B, unknown, PersistenceEffectContext>,
	) => Effect.runPromise(second.pipe(Effect.provide(layer()), Effect.orDie));
	try {
		return await Effect.runPromise(
			body(reopen).pipe(Effect.provide(layer()), Effect.orDie),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const seedSession = (id: string) =>
	Effect.gen(function* () {
		const commit = yield* makeCommitAndSignal;
		yield* commit([
			canonicalEvent(
				"session.created",
				id,
				{ sessionId: id, title: id, provider: "claude" },
				{ provider: "claude" },
			),
		]);
	});

/** A completed turn is what a "done" alert is about. */
const seedTurn = (sessionId: string, turnId: string, requestedAt: number) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			INSERT INTO turns (id, session_id, state, requested_at, completed_at)
			VALUES (${turnId}, ${sessionId}, 'completed', ${requestedAt}, ${requestedAt + 1})`;
	});

const doneFor = (sessionId: string): SessionAlert => ({
	sessionId,
	kind: "done",
});

it("fires for a completed turn, and the second path to notice fires nothing", async () => {
	const fired = await withStore(() =>
		Effect.gen(function* () {
			yield* seedSession("s1");
			yield* seedTurn("s1", "turn-1", 1000);
			const ledger = yield* makeAlertLedger;
			const sends: string[] = [];

			const first = yield* ledger.fireOnce(
				doneFor("s1"),
				Effect.sync(() => void sends.push("sse")),
			);
			// The status poller's safety-net done for the same turn.
			const second = yield* ledger.fireOnce(
				doneFor("s1"),
				Effect.sync(() => void sends.push("status-poller")),
			);

			expect([first, second]).toEqual([true, false]);
			return sends;
		}),
	);
	expect(fired).toEqual(["sse"]);
});

it("dings again on the next turn", async () => {
	const fired = await withStore(() =>
		Effect.gen(function* () {
			yield* seedSession("s1");
			yield* seedTurn("s1", "turn-1", 1000);
			const ledger = yield* makeAlertLedger;
			const sends: string[] = [];
			const send = (label: string) => Effect.sync(() => void sends.push(label));

			yield* ledger.fireOnce(doneFor("s1"), send("turn-1"));
			yield* seedTurn("s1", "turn-2", 2000);
			yield* ledger.fireOnce(doneFor("s1"), send("turn-2"));

			return sends;
		}),
	);
	expect(fired).toEqual(["turn-1", "turn-2"]);
});

it("does not re-fire after a restart — the claim outlives the process", async () => {
	const second = await withStore((reopen) =>
		Effect.gen(function* () {
			yield* seedSession("s1");
			yield* seedTurn("s1", "turn-1", 1000);
			const ledger = yield* makeAlertLedger;
			yield* ledger.fireOnce(doneFor("s1"), Effect.void);

			// A fresh ledger over the same file is what a daemon restart looks
			// like: the reconnect reconciliation re-observes a turn that ended
			// while the daemon was down. An in-memory set would ding again here.
			return yield* Effect.promise(() =>
				reopen(
					Effect.gen(function* () {
						const restarted = yield* makeAlertLedger;
						return yield* restarted.fireOnce(doneFor("s1"), Effect.void);
					}),
				),
			);
		}),
	);
	expect(second).toBe(false);
});

it("gives the claim back when the send fails, so the ding is not lost silently", async () => {
	const result = await withStore(() =>
		Effect.gen(function* () {
			yield* seedSession("s1");
			yield* seedTurn("s1", "turn-1", 1000);
			const ledger = yield* makeAlertLedger;
			const sql = yield* SqlClient.SqlClient;

			// A push that never reached the browser must not leave a ledger row
			// claiming it did — that row would suppress every retry, and nothing
			// anywhere would say the user was never told.
			const failed = yield* Effect.either(
				ledger.fireOnce(doneFor("s1"), Effect.fail("push endpoint gone")),
			);
			const rowsAfterFailure = yield* sql<{
				n: number;
			}>`SELECT COUNT(*) AS n FROM sent_alerts`;
			const retried = yield* ledger.fireOnce(doneFor("s1"), Effect.void);

			return {
				failure: Either.isLeft(failed) ? failed.left : undefined,
				rowsAfterFailure: rowsAfterFailure[0]?.n,
				retried,
			};
		}),
	);
	expect(result.failure).toBe("push endpoint gone");
	expect(result.rowsAfterFailure).toBe(0);
	expect(result.retried).toBe(true);
});

it("tells two different errors in one turn apart", async () => {
	const fired = await withStore(() =>
		Effect.gen(function* () {
			yield* seedSession("s1");
			yield* seedTurn("s1", "turn-1", 1000);
			const ledger = yield* makeAlertLedger;
			const sends: string[] = [];
			const alert = (detail: string): SessionAlert => ({
				sessionId: "s1",
				kind: "error",
				detail,
			});

			yield* ledger.fireOnce(
				alert("rate limited"),
				Effect.sync(() => void sends.push("rate limited")),
			);
			yield* ledger.fireOnce(
				alert("rate limited"),
				Effect.sync(() => void sends.push("rate limited again")),
			);
			yield* ledger.fireOnce(
				alert("disk full"),
				Effect.sync(() => void sends.push("disk full")),
			);

			return sends;
		}),
	);
	expect(fired).toEqual(["rate limited", "disk full"]);
});

it("still dings for a session with no turn rows", async () => {
	const fired = await withStore(() =>
		Effect.gen(function* () {
			yield* seedSession("s1");
			const ledger = yield* makeAlertLedger;
			// No turn to anchor to. An alert that cannot be identified is fired
			// rather than dropped: a ding that repeats is a nuisance, a ding that
			// never arrives is the bug this whole bead is about.
			return yield* ledger.fireOnce(doneFor("s1"), Effect.void);
		}),
	);
	expect(fired).toBe(true);
});
