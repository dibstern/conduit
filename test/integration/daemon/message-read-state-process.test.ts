// Outside-in failure modes: unsurfaced parts gaining a read flag on the wire,
// a read acknowledgement without a detail update, restart/reconnect losing
// annotations, malformed requests reaching storage, foreign parts being
// writable, a fork not starting from its parent's flags or later writes
// leaking between them, deletion retaining annotations.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect, ManagedRuntime, Schema } from "effect";
import { expect, it } from "vitest";
import { SessionDetailItemSchema } from "../../../src/lib/contracts/ws-rpc.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const hasReadRow = (
	message: Record<string, unknown>,
	partId: string,
	read: boolean,
) => {
	if (message["type"] !== "session_detail") return false;
	const rows =
		message["_tag"] === "snapshot" && Array.isArray(message["rows"])
			? message["rows"]
			: message["_tag"] === "upsert"
				? [message["item"]]
				: [];
	return rows.some(
		(row: unknown) =>
			Schema.is(SessionDetailItemSchema)(row) &&
			row._tag === "part" &&
			row.part.id === partId &&
			row.part.surfacingRead === read,
	);
};

// No judge ships yet, so verdicts are written straight into the stopped
// daemon's event store, the same events a judge would commit.
const seedVerdicts = async (
	storePath: string,
	parts: readonly { sessionId: string; messageId: string; partId: string }[],
) => {
	const db = new Database(storePath, { readonly: true });
	const row = db
		.prepare("SELECT project_id FROM sessions WHERE id = ?")
		.get(parts[0]?.sessionId);
	db.close();
	const projectId = Schema.decodeUnknownSync(
		Schema.Struct({ project_id: Schema.String }),
	)(row).project_id;
	const runtime = ManagedRuntime.make(
		makePersistenceEffectLayer(storePath, projectId),
	);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* ProjectionRunnerEffectTag).recover();
				yield* (yield* makeCommitAndSignal)(
					parts.map(({ sessionId, messageId, partId }) =>
						canonicalEvent(
							"text.surfaced",
							sessionId,
							{
								messageId,
								partId,
								ordinal: 1,
								categorySetVersion: 1,
								model: "process-test",
								probabilities: null,
							},
							{ provider: "conduit" },
						),
					),
				);
			}),
		);
	} finally {
		await runtime.dispose();
	}
};

it(
	"persists per-message reads through restart, forks and a second client",
	{ timeout: 90_000 },
	async () => {
		const harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
		});
		const observations: Record<string, unknown> = {};
		const requests: unknown[] = [];
		let passed = false;
		try {
			writeFileSync(
				join(harness.root, "claude", "conduit-test-record-forks"),
				"record\n",
			);
			await harness.restart();
			const first = await harness.connect(undefined, "read-first");
			const sessionId = await first.createSession("Read state");
			await first.send(sessionId, "Reply with a short finding.");
			const message = (await first.history(sessionId)).find(
				(item) =>
					item.role === "assistant" &&
					item.parts?.some((part) => part.type === "text"),
			);
			const part = message?.parts?.find((item) => item.type === "text");
			if (!message || !part)
				throw new Error("Fake SDK did not produce an assistant text part");
			expect(part).not.toHaveProperty("surfacingRead");
			const request = { sessionId, partIds: [part.id], read: true };
			requests.push(request);
			expect(
				await Effect.runPromise(first.rpc.SetMessagesRead(request)),
			).toEqual({ ok: true });
			await first.view(sessionId);
			const fork = await Effect.runPromise(
				first.rpc.ForkSession({ sessionId, originId: first.originId }),
			);
			const forkPartId = `${part.id}_${fork.sessionId}`;
			const forkHistory = await first.history(fork.sessionId);
			const forkMessage = forkHistory.find((item) =>
				item.parts?.some((candidate) => candidate.id === forkPartId),
			);
			if (!forkMessage)
				throw new Error("Fork is missing the parent's copied text");
			await harness.terminate();
			await seedVerdicts(harness.daemonStorePath(), [
				{ sessionId, messageId: message.id, partId: part.id },
				{
					sessionId: fork.sessionId,
					messageId: forkMessage.id,
					partId: forkPartId,
				},
			]);
			await harness.restart();
			const reader = await harness.connect(sessionId, "read-reconnected");
			const flag = async (id: string, partId: string) =>
				(await reader.history(id))
					.flatMap((item) => item.parts ?? [])
					.find((item) => item.id === partId)?.surfacingRead;
			expect(await flag(sessionId, part.id)).toBe(true);
			expect(await flag(fork.sessionId, forkPartId)).toBe(true);
			const second = await harness.connect(sessionId, "read-second");
			await second.followSession(sessionId);
			observations["secondClientReconnect"] = await second.waitFor((frame) =>
				hasReadRow(frame, part.id, true),
			);
			const cursor = second.frames.length;
			const unread = { sessionId, partIds: [part.id], read: false };
			requests.push(unread);
			await Effect.runPromise(reader.rpc.SetMessagesRead(unread));
			observations["secondClientLive"] = await second.waitFor(
				(frame) => hasReadRow(frame, part.id, false),
				cursor,
			);
			await second.close();
			expect(await flag(fork.sessionId, forkPartId)).toBe(true);
			for (const invalid of [
				{ sessionId, partIds: [], read: true },
				{ sessionId, partIds: [""], read: true },
				{ sessionId: "", partIds: [part.id], read: true },
			]) {
				requests.push(invalid);
				await expect(
					harness.requestRpc({ _tag: "SetMessagesRead", ...invalid }),
				).rejects.toBeDefined();
			}
			await Effect.runPromise(
				reader.rpc.SetMessagesRead({
					sessionId: fork.sessionId,
					partIds: [part.id],
					read: true,
				}),
			);
			expect(await flag(sessionId, part.id)).toBe(false);
			await reader.deleteSession(fork.sessionId);
			await reader.deleteSession(sessionId);
			const db = new Database(harness.daemonStorePath(), { readonly: true });
			try {
				expect(
					db
						.prepare(
							"SELECT part_id FROM message_part_read_state WHERE session_id IN (?, ?)",
						)
						.all(sessionId, fork.sessionId),
				).toEqual([]);
			} finally {
				db.close();
			}
			Object.assign(observations, {
				forkInheritedThenIndependent: true,
				malformedRequestsRejected: 3,
				deletionRemovedAnnotations: true,
			});
			passed = true;
		} finally {
			const logs = harness.logTail;
			const proofFile = join(harness.root, "sdk-proof.ndjson");
			const sdkRequests = existsSync(proofFile)
				? readFileSync(proofFile, "utf8")
				: "";
			await harness.dispose();
			harness.assertNoRunners();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/ahu8-11-message-read-process.json",
				`${JSON.stringify({ passed, requests, observations, sdkRequests, logs }, null, 2)}\n`,
			);
		}
	},
);
