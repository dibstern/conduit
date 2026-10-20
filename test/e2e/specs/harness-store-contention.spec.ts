// Measurement only: three SaveProject registrations, two new Claude sessions
// each, six simultaneous input.submit RPCs replaying the same recorded stream
// at 10 ms per frame. Latency runs from submit to the session-row turn-end
// notification, including RPC and runner startup. Percentiles use nearest rank.
// Daemon metrics accumulate from startup: eventLoopDelayMs is the 10 ms Node
// sampling histogram (including that interval); commitPermitWaitMs measures
// request-to-acquisition for each commit, including failed attempts; sqliteBusy
// counts failed commits with SQLITE_BUSY/SQLITE_BUSY_SNAPSHOT causes, once each.
// Wait for a fresh one-second flush, round milliseconds to 0.1, and write raw
// measurements to test-results/82tn6-contention.json. No performance thresholds.
//
// Write contention pin (conduit-test-16c8.4), artifact
// test-results/16c8-4-write-contention.json. One uncontended baseline turn,
// then six turns streaming at once across two projects into the shared store.
// Failure modes and the assertion that catches each:
// - A commit loses a SQLITE_BUSY race or the store reports "database is
//   locked": sqliteBusy in the daemon's contention metrics is 0, and the
//   complete daemon output plus daemon.log contain no BUSY/LOCKED text.
// - An RPC fails under load: every input.submit returns ok and every
//   DeleteSession resolves; a rejected RPC throws and fails the test.
// - A write is dropped, duplicated or reordered under contention: each
//   session's non-delta event counts equal the baseline's, its ordered text
//   and thinking parts contain every native byte, its turn.completed count
//   equals the replayed result frames, and its stream versions have no gaps.
//   Delta row counts vary with the runner's 50 ms per-part coalescing window.
// - Foreign keys are not enforced on the daemon's connection. PRAGMA
//   foreign_keys read here would describe this reader's connection, not the
//   daemon's, so enforcement is observed by its effect instead: DeleteSession
//   is a single DELETE FROM sessions that relies on ON DELETE CASCADE. Each
//   deleted session first has turns, messages and parts; afterwards none
//   remain and PRAGMA foreign_key_check, which inspects stored rows, reports no
//   orphans. With enforcement off the session row goes and its children stay.
// - A hang: bounded waits for startup, turn ends, settling and deletion.
// Timings are recorded, never asserted.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import type { ProcessBrowser } from "../../helpers/process-harness.js";
import { expect, test } from "../helpers/process-harness-fixture.js";

// The longest existing single-input, single-result harness trace by streaming
// delta count: 52 deltas in 87 frames, without steering or a second input.
const fixture = "background-shell-ends-between-turns";
const prompt = "Run the recorded streaming turn.";
// Each test starts its own daemon. Generous startup bounds keep a loaded
// machine from failing startup or ending a turn with "Runner startup timed out".
test.use({
	startHarness: false,
	harnessOptions: { claudeReplay: { turns: [fixture], delayMs: 10 } },
});
test.beforeEach(({ isMobile }) => {
	test.skip(isMobile, "Store contention is measured once on desktop");
});

test("measures writes across three projects during six streaming turns", async ({
	harness,
}, testInfo) => {
	test.setTimeout(120_000);
	const metricsFile = join(harness.root, "contention-metrics.json");
	await harness.restart({
		startupTimeoutMs: 90_000,
		runnerStartupTimeoutMs: 60_000,
		serviceEnvironment: { CONDUIT_CONTENTION_METRICS: metricsFile },
	});
	const control = await harness.connect(undefined, undefined, undefined, false);
	const turns: { browser: ProcessBrowser; sessionId: string }[] = [];
	for (let project = 0; project < 3; project++) {
		const folder = join(harness.root, `contention-project-${project}`);
		mkdirSync(folder);
		const { savedSlug } = await Effect.runPromise(
			control.rpc.SaveProject({
				title: `Contention project ${project}`,
				folders: [folder],
			}),
		);
		if (!savedSlug) throw new Error("SaveProject omitted the project slug");
		const browser = await harness.connect(
			undefined,
			undefined,
			savedSlug,
			false,
		);
		for (let turn = 0; turn < 2; turn++) {
			const sessionId = await browser.createSession(`Contention turn ${turn}`);
			turns.push({ browser, sessionId });
		}
	}

	const latencies = await Promise.all(
		turns.map(async ({ browser, sessionId }) => {
			const cursor = browser.frames.length;
			const completion = browser
				.waitForTurnEnd(sessionId, cursor, 60_000)
				.then((done) => ({ done, completedAt: performance.now() }));
			const started = performance.now();
			// Use the send RPC directly so history reads in browser.send are not timed.
			const [submitted, { done, completedAt }] = await Promise.all([
				Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId,
						originId: browser.originId,
						inputId: randomUUID(),
						delivery: "queue",
						text: prompt,
					}).pipe(Effect.timeout(60_000)),
				),
				completion,
			]);
			if (!submitted.ok) throw new Error(`Submit refused: ${submitted.reason}`);
			expect(done["status"]).toBe("idle");
			return completedAt - started;
		}),
	);
	const completedAt = Date.now();
	await expect
		.poll(() => (existsSync(metricsFile) ? statSync(metricsFile).mtimeMs : 0), {
			timeout: 10_000,
		})
		.toBeGreaterThan(completedAt + 1_000);
	const metrics: {
		eventLoopDelayMs: {
			min: number;
			mean: number;
			p50: number;
			p99: number;
			max: number;
		};
		commitPermitWaitMs: {
			count: number;
			p50: number;
			p99: number;
			max: number;
		};
		sqliteBusy: number;
	} = JSON.parse(readFileSync(metricsFile, "utf8"));
	expect(metrics).toEqual({
		eventLoopDelayMs: {
			min: expect.any(Number),
			mean: expect.any(Number),
			p50: expect.any(Number),
			p99: expect.any(Number),
			max: expect.any(Number),
		},
		commitPermitWaitMs: {
			count: expect.any(Number),
			p50: expect.any(Number),
			p99: expect.any(Number),
			max: expect.any(Number),
		},
		sqliteBusy: expect.any(Number),
	});
	latencies.sort((a, b) => a - b);
	const round = (ms: number) => Math.round(ms * 10) / 10;
	const percentile = (p: number) =>
		round(latencies[Math.ceil((p / 100) * latencies.length) - 1] ?? 0);
	const artifact = resolve("test-results/82tn6-contention.json");
	expect(existsSync(harness.daemonStorePath())).toBe(true);
	mkdirSync(resolve("test-results"), { recursive: true });
	writeFileSync(
		artifact,
		`${JSON.stringify(
			{
				storeModel: "shared",
				projects: 3,
				turnsPerProject: 2,
				fixture,
				turnLatencyMs: {
					p50: percentile(50),
					p99: percentile(99),
					max: percentile(100),
				},
				...metrics,
			},
			null,
			2,
		)}\n`,
	);
	await testInfo.attach("store-contention", {
		path: artifact,
		contentType: "application/json",
	});
});

test.describe("write contention", () => {
	test.use({
		harnessOptions: {
			claudeReplay: { turns: [fixture], delayMs: 10, logLevel: "warn" },
		},
	});

	test("persists every event across concurrent sessions with foreign keys enforced", async ({
		harness,
	}, testInfo) => {
		test.setTimeout(240_000);
		const metricsFile = join(harness.root, "contention-metrics.json");
		const logFile = join(harness.root, "daemon-output.log");
		const startedAt = performance.now();
		await harness.restart({
			startupTimeoutMs: 90_000,
			runnerStartupTimeoutMs: 60_000,
			logFile,
			serviceEnvironment: { CONDUIT_CONTENTION_METRICS: metricsFile },
		});
		const startupMs = performance.now() - startedAt;
		const trace = readFileSync(
			resolve(`test/fixtures/claude-sdk-traces/${fixture}.jsonl`),
			"utf8",
		)
			.split("\n")
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						event?: {
							type?: string;
							index?: number;
							content_block?: {
								type?: string;
								text?: string;
								thinking?: string;
							};
							delta?: { type?: string; text?: string; thinking?: string };
						};
					},
			);
		const nativeParts: {
			type: "text" | "thinking";
			text: string;
			fragments: number;
		}[] = [];
		const activeParts = new Map<number, (typeof nativeParts)[number]>();
		for (const { event } of trace) {
			if (event?.type === "message_start") activeParts.clear();
			if (event?.index === undefined) continue;
			const block = event.content_block;
			if (
				event.type === "content_block_start" &&
				(block?.type === "text" || block?.type === "thinking")
			) {
				const text = block.type === "text" ? block.text : block.thinking;
				const part: (typeof nativeParts)[number] = {
					type: block.type,
					text: text ?? "",
					fragments: text ? 1 : 0,
				};
				nativeParts.push(part);
				activeParts.set(event.index, part);
			}
			const delta = event.delta;
			if (
				event.type === "content_block_delta" &&
				(delta?.type === "text_delta" || delta?.type === "thinking_delta")
			) {
				const part = activeParts.get(event.index);
				if (!part || `${part.type}_delta` !== delta.type)
					throw new Error("Trace delta has no matching text or thinking part");
				part.text +=
					(delta.type === "text_delta" ? delta.text : delta.thinking) ?? "";
				part.fragments++;
			}
		}
		const submittedText = "Run the recorded streaming turn.";
		const expectedParts = [
			{ role: "user", type: "text", text: submittedText },
			...nativeParts.map(({ type, text }) => ({
				role: "assistant",
				type,
				text,
			})),
		];
		const emitted = {
			"thinking.delta": trace.filter(
				(frame) => frame.event?.delta?.type === "thinking_delta",
			).length,
			"turn.completed": trace.filter((frame) => frame.type === "result").length,
		};
		const store = () =>
			new DatabaseSync(harness.daemonStorePath(), { readOnly: true });
		const read = <T>(query: (db: DatabaseSync) => T): T => {
			const db = store();
			try {
				return query(db);
			} finally {
				db.close();
			}
		};
		const eventCounts = (sessionId: string) =>
			Object.fromEntries(
				read((db) =>
					db
						.prepare(
							"SELECT type, COUNT(*) AS n FROM events WHERE session_id = ? GROUP BY type ORDER BY type",
						)
						.all(sessionId),
				).map((row) => [String(row["type"]), Number(row["n"])]),
			);
		const nonDeltaCounts = (counts: Record<string, number>) =>
			Object.fromEntries(
				Object.entries(counts).filter(
					([type]) => type !== "text.delta" && type !== "thinking.delta",
				),
			);
		const contentParts = (sessionId: string) => {
			const parts: {
				role: "user" | "assistant";
				type: "text" | "thinking";
				text: string;
				fragments: number;
			}[] = [];
			let previousKey: string | undefined;
			for (const row of read((db) =>
				db
					.prepare(
						`SELECT events.sequence, events.type, events.data, messages.role FROM events
						LEFT JOIN messages ON messages.id = json_extract(events.data, '$.messageId')
							AND messages.session_id = events.session_id
						WHERE events.session_id = ?
							AND events.type IN ('text.delta', 'thinking.delta')
						ORDER BY events.sequence`,
					)
					.all(sessionId),
			)) {
				const data = JSON.parse(String(row["data"])) as {
					messageId: string;
					partId: string;
					text: string;
				};
				const role = row["role"];
				if (role !== "user" && role !== "assistant")
					throw new Error(
						`Delta at sequence ${row["sequence"]} has no user or assistant message`,
					);
				const type = row["type"] === "text.delta" ? "text" : "thinking";
				const key = JSON.stringify([data.messageId, data.partId, type]);
				let part = parts.at(-1);
				if (previousKey !== key || !part) {
					part = { role, type, text: "", fragments: 0 };
					parts.push(part);
					previousKey = key;
				}
				part.text += data.text;
				part.fragments++;
			}
			return parts;
		};
		const runTurn = async (browser: ProcessBrowser, sessionId: string) => {
			const cursor = browser.frames.length;
			const started = performance.now();
			const [submitted, done] = await Promise.all([
				Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId,
						originId: browser.originId,
						inputId: randomUUID(),
						delivery: "queue",
						text: submittedText,
					}).pipe(Effect.timeout(90_000)),
				),
				browser.waitForTurnEnd(sessionId, cursor, 90_000),
			]);
			if (!submitted.ok) throw new Error(`Submit refused: ${submitted.reason}`);
			expect(done["status"]).toBe("idle");
			return performance.now() - started;
		};

		const control = await harness.connect(
			undefined,
			undefined,
			undefined,
			false,
		);
		const browsers: ProcessBrowser[] = [];
		for (let project = 0; project < 2; project++) {
			const folder = join(harness.root, `write-contention-${project}`);
			mkdirSync(folder);
			const { savedSlug } = await Effect.runPromise(
				control.rpc.SaveProject({
					title: `Write contention ${project}`,
					folders: [folder],
				}),
			);
			if (!savedSlug) throw new Error("SaveProject omitted the project slug");
			browsers.push(
				await harness.connect(undefined, undefined, savedSlug, false),
			);
		}
		const [first, second] = browsers;
		if (!first || !second) throw new Error("Two projects were not connected");

		// The replay's background task finishes after the turn ends. Settled
		// means every tool has completed and the counts held for half a second.
		const baselineId = await first.createSession("Baseline");
		const baselineLatencyMs = await runTurn(first, baselineId);
		let previous: Record<string, number> = {};
		await expect(() => {
			const counts = eventCounts(baselineId);
			const last = previous;
			previous = counts;
			expect(counts["tool.started"]).toBeGreaterThan(0);
			expect(counts["tool.completed"]).toBe(counts["tool.started"]);
			expect(counts).toEqual(last);
		}).toPass({ timeout: 30_000, intervals: [500] });
		const baseline = eventCounts(baselineId);
		expect(baseline).toMatchObject({
			"turn.completed": emitted["turn.completed"],
			"thinking.start": nativeParts.filter(({ type }) => type === "thinking")
				.length,
			"thinking.end": nativeParts.filter(({ type }) => type === "thinking")
				.length,
		});
		expect(
			contentParts(baselineId).map(({ role, type, text }) => ({
				role,
				type,
				text,
			})),
		).toEqual(expectedParts);

		const sessions: { label: string; browser: ProcessBrowser; id: string }[] =
			[];
		for (const [project, browser] of browsers.entries())
			for (let turn = 0; turn < 3; turn++)
				sessions.push({
					label: `project-${project}/session-${turn}`,
					browser,
					id: await browser.createSession(`Concurrent ${turn}`),
				});
		const waveStartedAt = performance.now();
		const latencies = await Promise.all(
			sessions.map(({ browser, id }) => runTurn(browser, id)),
		);
		const waveMs = performance.now() - waveStartedAt;
		for (const { id } of sessions)
			await expect
				.poll(
					() => ({
						events: nonDeltaCounts(eventCounts(id)),
						parts: contentParts(id).map(({ role, type, text }) => ({
							role,
							type,
							text,
						})),
					}),
					{ timeout: 30_000 },
				)
				.toEqual({ events: nonDeltaCounts(baseline), parts: expectedParts });
		const settledMs = performance.now() - waveStartedAt;
		for (const id of [baselineId, ...sessions.map((session) => session.id)]) {
			for (const [index, part] of contentParts(id).entries()) {
				expect(part.fragments).toBeGreaterThan(0);
				if (part.role === "user") expect(part.fragments).toBe(1);
				else
					expect(part.fragments).toBeLessThanOrEqual(
						nativeParts[index - 1]?.fragments ?? 0,
					);
			}
			const versions = read((db) =>
				db
					.prepare(
						"SELECT COUNT(*) AS n, MAX(stream_version) - MIN(stream_version) + 1 AS span FROM events WHERE session_id = ?",
					)
					.get(id),
			);
			expect(versions?.["span"]).toBe(versions?.["n"]);
		}
		const persistedTextParts = Object.fromEntries(
			[{ label: "baseline", id: baselineId }, ...sessions].map(
				({ label, id }) => [label, contentParts(id)],
			),
		);

		const orphans = () =>
			read((db) => db.prepare("PRAGMA foreign_key_check").all());
		const children = (sessionId: string) => {
			const row =
				read((db) =>
					db
						.prepare(
							`SELECT
							(SELECT COUNT(*) FROM turns WHERE session_id = ?1) AS turns,
							(SELECT COUNT(*) FROM messages WHERE session_id = ?1) AS messages,
							(SELECT COUNT(*) FROM message_parts WHERE message_id IN
								(SELECT id FROM messages WHERE session_id = ?1)) AS parts,
							(SELECT COUNT(*) FROM sessions WHERE id = ?1) AS sessions`,
						)
						.get(sessionId),
				) ?? {};
			return {
				turns: Number(row["turns"]),
				messages: Number(row["messages"]),
				parts: Number(row["parts"]),
				sessions: Number(row["sessions"]),
			};
		};
		expect(orphans()).toEqual([]);
		const deleted = sessions.filter((_, index) => index % 3 === 0);
		const childrenBeforeDelete = deleted.map(({ label, id }) => ({
			label,
			...children(id),
		}));
		for (const { label, ...before } of childrenBeforeDelete)
			for (const [table, count] of Object.entries(before))
				expect(count, `${label} ${table} before delete`).toBeGreaterThan(0);
		const deleteStartedAt = performance.now();
		await Promise.all(
			deleted.map(({ browser, id }) => browser.deleteSession(id)),
		);
		for (const { id } of deleted)
			await expect
				.poll(() => children(id), { timeout: 15_000 })
				.toEqual({ turns: 0, messages: 0, parts: 0, sessions: 0 });
		const deleteMs = performance.now() - deleteStartedAt;
		const orphansAfterDelete = orphans();
		expect(orphansAfterDelete).toEqual([]);
		for (const { id } of sessions.filter(
			(session) => !deleted.includes(session),
		))
			expect(children(id).sessions).toBe(1);

		const completedAt = Date.now();
		await expect
			.poll(
				() => (existsSync(metricsFile) ? statSync(metricsFile).mtimeMs : 0),
				{
					timeout: 10_000,
				},
			)
			.toBeGreaterThan(completedAt + 1_000);
		const { sqliteBusy }: { sqliteBusy: number } = JSON.parse(
			readFileSync(metricsFile, "utf8"),
		);
		const daemonLog = join(harness.configDir, "daemon.log");
		const output = [logFile, daemonLog]
			.filter(existsSync)
			.map((file) => readFileSync(file, "utf8"))
			.join("\n");
		const lockErrors = output
			.split("\n")
			.filter((line) =>
				/SQLITE_BUSY|SQLITE_LOCKED|database is locked|FOREIGN KEY constraint/i.test(
					line,
				),
			);
		expect(lockErrors).toEqual([]);
		expect(sqliteBusy).toBe(0);

		const round = (ms: number) => Math.round(ms * 10) / 10;
		const artifact = resolve("test-results/16c8-4-write-contention.json");
		mkdirSync(resolve("test-results"), { recursive: true });
		writeFileSync(
			artifact,
			`${JSON.stringify(
				{
					storeModel: "shared",
					projects: 2,
					concurrentSessions: sessions.length,
					fixture,
					emitted,
					nativeTextParts: nativeParts,
					expectedContentParts: expectedParts,
					persistedTextParts,
					baselineEventCounts: baseline,
					sessionEventCounts: Object.fromEntries(
						sessions.map(({ label, id }) => [label, eventCounts(id)]),
					),
					errors: {
						sqliteBusyCommits: sqliteBusy,
						lockOrForeignKeyLogLines: lockErrors.length,
						rpcFailures: 0,
					},
					foreignKeys: {
						observation:
							"DeleteSession cascade removed every child row; PRAGMA foreign_key_check found no orphans",
						deletedSessions: childrenBeforeDelete,
						orphansAfterContention: 0,
						orphansAfterDelete: orphansAfterDelete.length,
					},
					timingsMs: {
						startup: round(startupMs),
						baselineTurn: round(baselineLatencyMs),
						concurrentTurns: Object.fromEntries(
							sessions.map(({ label }, index) => [
								label,
								round(latencies[index] ?? 0),
							]),
						),
						wave: round(waveMs),
						waveSettled: round(settledMs),
						deletes: round(deleteMs),
					},
				},
				null,
				2,
			)}\n`,
		);
		await testInfo.attach("write-contention", {
			path: artifact,
			contentType: "application/json",
		});
	});
});
