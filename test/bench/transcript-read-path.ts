// Repeatable read-path measurement against a temporary store, never live data.
// pnpm exec tsx test/bench/transcript-read-path.ts /tmp/read-path.db /tmp/read-path.json
import { channel } from "node:diagnostics_channel";
import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { defaultDaemonConfig } from "../../src/lib/daemon/config-persistence.js";
import { AccountDirectoryLive } from "../../src/lib/domain/daemon/Services/account-directory.js";
import { subscribeSessionDetail } from "../../src/lib/domain/relay/Services/session-detail-subscription.js";
import { SessionEventBusLive } from "../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../src/lib/provider/claude/claude-sdk-env.js";
import {
	HEAVY_SESSION_ID,
	seedSessionLoadFixture,
} from "../fixtures/session-load.js";

const [filename, output] = process.argv.slice(2);
if (!filename || !output)
	throw new Error(
		"Usage: transcript-read-path.ts <temporary-store> <report.json>",
	);
const heavyTurns = 500;
if (!existsSync(filename)) {
	await seedSessionLoadFixture(filename, { families: 0, heavyTurns });
	// Twenty more tool calls per turn reproduce a long, tool-heavy transcript.
	await Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			for (let turn = 0; turn < heavyTurns; turn++) {
				const createdAt = Date.UTC(2026, 0, 1) + turn * 1_000;
				const messageId = `${HEAVY_SESSION_ID}-a${createdAt}`;
				yield* commit(
					Array.from({ length: 20 }, (_, tool) => {
						const partId = `${messageId}-extra-${tool}`;
						const data = { messageId, partId };
						const options = { provider: "claude", createdAt };
						return [
							canonicalEvent(
								"tool.started",
								HEAVY_SESSION_ID,
								{
									...data,
									toolName: "Bash",
									callId: partId,
									input: { tool: "Bash", command: `inspect-${tool}` },
								},
								options,
							),
							canonicalEvent(
								"tool.completed",
								HEAVY_SESSION_ID,
								{
									...data,
									result: `Tool ${tool}: ${"result line.\n".repeat(500)}`,
									duration: 250,
								},
								options,
							),
						];
					}).flat(),
					{ publish: false },
				);
			}
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(filename, "test-project")),
		),
	);
}

const partsSessionId = "resume-200-parts";
const partsAfter = await Effect.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [{ count = 0 } = {}] = yield* sql<{ count: number }>`
			SELECT COUNT(*) AS count FROM sessions WHERE id = ${partsSessionId}`;
		if (count === 0) {
			const commit = yield* makeCommitAndSignal;
			const start = Date.UTC(2026, 0, 1);
			yield* commit(
				[
					canonicalEvent(
						"session.created",
						partsSessionId,
						{
							sessionId: partsSessionId,
							title: "Old message resume",
							provider: "claude",
						},
						{ provider: "claude", createdAt: start },
					),
					canonicalEvent(
						"message.created",
						partsSessionId,
						{
							sessionId: partsSessionId,
							messageId: "old-parts",
							role: "assistant",
						},
						{ provider: "claude", createdAt: start },
					),
					...Array.from({ length: 51 }, (_, index) =>
						canonicalEvent(
							"message.created",
							partsSessionId,
							{
								sessionId: partsSessionId,
								messageId: `new-${index}`,
								role: "assistant",
							},
							{ provider: "claude", createdAt: start + (index + 1) * 1_000 },
						),
					),
				],
				{ publish: false },
			);
			yield* commit(
				Array.from({ length: 200 }, (_, index) => {
					const data = { messageId: "old-parts", partId: `old-part-${index}` };
					const options = { provider: "claude", createdAt: start };
					return [
						canonicalEvent(
							"tool.started",
							partsSessionId,
							{
								...data,
								toolName: "Bash",
								callId: data.partId,
								input: { tool: "Bash", command: "pwd" },
							},
							options,
						),
						canonicalEvent(
							"tool.completed",
							partsSessionId,
							{
								...data,
								result: "result line.\n".repeat(500),
								duration: 1,
							},
							options,
						),
					];
				}).flat(),
				{ publish: false },
			);
		}
		const [row] = yield* sql<{ after: number }>`
			SELECT MAX(version) AS after FROM messages
			WHERE session_id = ${partsSessionId} AND id <> 'old-parts'`;
		if (!row) throw new Error("Missing 200-part resume fixture");
		return row.after;
	}).pipe(Effect.provide(makePersistenceEffectLayer(filename, "test-project"))),
);

let kind = "";
let measuring = false;
let reads: Record<
	string,
	{
		rows: number;
		bytes: number;
		partRows: number;
		partBytes: number;
		messageBytes: number;
	}
> = {};
const prepare = DatabaseSync.prototype.prepare;
Object.defineProperty(DatabaseSync.prototype, "prepare", {
	value: function (this: DatabaseSync, source: string) {
		const statement = prepare.call(this, source);
		const all = statement.all;
		Object.defineProperty(statement, "all", {
			value: (...parameters: unknown[]) => {
				const rows: unknown = Reflect.apply(all, statement, parameters);
				if (measuring && Array.isArray(rows)) {
					const read = (reads[kind] ??= {
						rows: 0,
						bytes: 0,
						partRows: 0,
						partBytes: 0,
						messageBytes: 0,
					});
					read.rows += rows.length;
					read.bytes += Buffer.byteLength(JSON.stringify(rows));
					for (const row of rows) {
						if (typeof row !== "object" || row === null) continue;
						if ("message_id" in row && "type" in row) {
							read.partRows++;
							read.partBytes += Buffer.byteLength(JSON.stringify(row));
						} else if ("session_id" in row && "role" in row) {
							read.messageBytes += Buffer.byteLength(JSON.stringify(row));
						}
					}
				}
				return rows;
			},
		});
		return statement;
	},
});
const diagnostics = channel("conduit:read-model-read");
const onRead = (value: unknown) => {
	if (typeof value === "object" && value !== null && "kind" in value)
		kind = String(value.kind);
};
diagnostics.subscribe(onRead);

const runtime = ManagedRuntime.make(
	Layer.mergeAll(
		makePersistenceEffectLayer(filename, "test-project"),
		SessionEventBusLive,
		AccountDirectoryLive(
			configuredClaudeConfigDir("/isolated-read-path-login"),
			defaultDaemonConfig().instances,
		),
	),
);
const sample = async (
	resume: boolean,
	sessionId = HEAVY_SESSION_ID,
	after = 0,
) => {
	reads = {};
	measuring = true;
	const start = performance.now();
	const envelopes = await runtime.runPromise(
		subscribeSessionDetail({
			sessionId,
			...(resume
				? { resumeFromSequence: after, resumeBase: { sequence: after } }
				: {}),
		}).pipe(
			Stream.takeUntil((envelope) => envelope._tag === "synchronized"),
			Stream.runCollect,
		),
	);
	const ms = performance.now() - start;
	measuring = false;
	const snapshot = envelopes.find((envelope) => envelope._tag === "snapshot");
	if (!snapshot)
		throw new Error("Expected a snapshot for a cold or stale open");
	return {
		ms: Math.round(ms * 100) / 100,
		frameBytes: Buffer.byteLength(JSON.stringify(snapshot)),
		messages: snapshot.rows.filter((row) => row._tag === "message").length,
		reads,
	};
};
try {
	await sample(false);
	await sample(true);
	await sample(true, partsSessionId, partsAfter);
	const cold = [];
	const stale = [];
	const oldMessageResume = [];
	for (let index = 0; index < 5; index++) {
		cold.push(await sample(false));
		stale.push(await sample(true));
		oldMessageResume.push(await sample(true, partsSessionId, partsAfter));
	}
	const report = {
		sessionId: HEAVY_SESSION_ID,
		heavyTurns,
		cold,
		stale,
		oldMessageResume: {
			sessionId: partsSessionId,
			changedMessages: 1,
			changedParts: 200,
			resumeFromSequence: partsAfter,
			samples: oldMessageResume,
		},
	};
	writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report));
	if (process.argv.includes("--assert")) {
		for (const sample of [...cold, ...stale]) {
			const base = sample.reads["base"];
			if (!base || base.bytes > 2 * sample.frameBytes)
				throw new Error(
					"Snapshot materialized more than twice its frame bytes",
				);
		}
		for (const sample of [...stale, ...oldMessageResume]) {
			const resume = sample.reads["resume"];
			if (!resume || resume.partRows !== 0 || resume.messageBytes !== 0)
				throw new Error("Stale preflight read transcript bodies");
		}
	}
} finally {
	DatabaseSync.prototype.prepare = prepare;
	diagnostics.unsubscribe(onRead);
	await runtime.dispose();
}
