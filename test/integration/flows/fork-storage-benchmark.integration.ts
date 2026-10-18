// Opt in with CONDUIT_FORK_SNAPSHOT and CONDUIT_FORK_BASELINE_REF. The source is
// read only; commands run on separate copies of the named session's data.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient, Statement } from "effect/sql";
import { expect, it } from "vitest";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { forkSession } from "../../../src/lib/domain/relay/Services/session-command.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { claudeSdk } from "../../helpers/fake-claude-process-sdk.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const snapshot = process.env["CONDUIT_FORK_SNAPSHOT"];
const baselineRef = process.env["CONDUIT_FORK_BASELINE_REF"];
const sessionId = "ses_d87c87bc61474bb080110b076ede65b9";

it.skipIf(!snapshot || !baselineRef)(
	"measures the production fork command on the heavy snapshot session",
	async () => {
		if (!snapshot || !baselineRef)
			throw new Error("Snapshot and baseline ref are required");
		if (resolve(snapshot).includes("/.config/conduit/"))
			throw new Error("Use a snapshot, never the live store");
		const directory = mkdtempSync(join(tmpdir(), "conduit-fork-benchmark-"));
		mkdirSync(resolve("test-results"), { recursive: true });
		const sourceDirectory = mkdtempSync(
			join(resolve("test-results"), "fork-baseline-"),
		);
		try {
			const commandPath = "src/lib/domain/relay/Services/session-command.ts";
			const historyPath = "src/lib/persistence/fork-history.ts";
			for (const [original, target] of [
				[historyPath, "fork-history.ts"],
				[commandPath, "session-command.ts"],
			] as const) {
				const code = execFileSync(
					"git",
					["show", `${baselineRef}:${original}`],
					{ encoding: "utf8", maxBuffer: 1024 * 1024 },
				);
				writeFileSync(
					join(sourceDirectory, target),
					code.replace(
						/from "(\.[^"]+)"/g,
						(_match: string, specifier: string) => {
							const path = specifier.endsWith("/fork-history.js")
								? join(sourceDirectory, "fork-history.ts")
								: resolve(dirname(original), specifier).replace(/\.js$/, ".ts");
							if (!existsSync(path))
								throw new Error(`Missing baseline dependency ${path}`);
							return `from ${JSON.stringify(path)}`;
						},
					),
				);
			}
			const baseline: { forkSession: typeof forkSession } = await import(
				join(sourceDirectory, "session-command.ts")
			);
			const seedFile = join(directory, "seed.db");
			const source = new Database(resolve(snapshot), {
				readonly: true,
				fileMustExist: true,
			});
			const seed = new Database(seedFile);
			let projectId: string;
			let model: { model_id: string; variant: string; context_window: string };
			let inputEvents: number;
			try {
				const owner = source
					.prepare<[string], { project_id: string }>(
						"SELECT project_id FROM events WHERE session_id = ? LIMIT 1",
					)
					.get(sessionId);
				const parent = source
					.prepare<[string], typeof model>(
						"SELECT model_id, variant, context_window FROM sessions WHERE id = ?",
					)
					.get(sessionId);
				if (!owner || !parent)
					throw new Error("Snapshot is missing the heavy session");
				projectId = owner.project_id;
				model = parent;
				const tables = source
					.prepare<[], { name: string; sql: string }>(
						"SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
					)
					.all();
				for (const table of tables) seed.exec(table.sql);
				seed.prepare("ATTACH DATABASE ? AS source").run(resolve(snapshot));
				seed.transaction(() => {
					for (const { name } of tables) {
						const table = `"${name.replaceAll('"', '""')}"`;
						const columns = source
							.prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
							.all()
							.map(({ name }) => name);
						// table_info excludes generated columns, which SELECT * includes.
						const fields = columns
							.map((name) => `"${name.replaceAll('"', '""')}"`)
							.join(", ");
						const insert = `INSERT INTO ${table} (${fields}) SELECT ${fields} FROM source.${table}`;
						if (name === "sessions")
							seed.prepare(`${insert} WHERE id = ?`).run(sessionId);
						else if (name === "message_parts")
							seed
								.prepare(
									`${insert} WHERE message_id IN (SELECT id FROM messages)`,
								)
								.run();
						else if (columns.includes("session_id"))
							seed.prepare(`${insert} WHERE session_id = ?`).run(sessionId);
						else if (
							[
								"_migrations",
								"effect_sql_migrations",
								"read_model_counter",
								"store_identity",
								"projector_cursors",
								"provider_command_meta",
								"session_sidebar_horizon",
							].includes(name)
						)
							seed.exec(insert);
					}
				})();
				seed.exec("DETACH DATABASE source");
				for (const { sql } of source
					.prepare<[], { sql: string }>(
						"SELECT sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL",
					)
					.all())
					seed.exec(sql);
				// Isolate storage work from SDK I/O; a fresh canonical fork has no native receipt.
				seed
					.prepare(
						"DELETE FROM provider_state WHERE session_id = ? AND (key LIKE 'nativeThread:%' OR key IN ('resumeSessionId', 'claudeConfigDir'))",
					)
					.run(sessionId);
				inputEvents =
					seed
						.prepare<[string], { count: number }>(
							"SELECT COUNT(*) AS count FROM events WHERE session_id = ?",
						)
						.get(sessionId)?.count ?? 0;
			} finally {
				seed.close();
				source.close();
			}

			const cases = ["fork", "side-thread"] as const;
			const measurements = [];
			for (const kind of cases) {
				for (const [version, command] of [
					["before", baseline.forkSession],
					["after", forkSession],
				] as const) {
					const samples: number[] = [];
					const eventReads: string[][] = [];
					const hashes: string[] = [];
					let copiedEvents = 0;
					for (let index = 0; index < 4; index++) {
						const filename = join(directory, `${kind}-${version}-${index}.db`);
						copyFileSync(seedFile, filename);
						const configDir = join(directory, "config");
						mkdirSync(configDir, { recursive: true });
						const runtime = ManagedRuntime.make(
							Layer.mergeAll(
								Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
								Layer.succeed(OpenCodeInstancesTag)(
									makeOpenCodeInstancesStub(),
								),
								makePersistenceEffectLayer(filename, projectId),
								makeOverridesStateLive(),
								Layer.succeed(ConfigTag)(
									makeMockConfig({
										projectDir: directory,
										configDir,
										claudeSdk,
									}),
								),
								Layer.succeed(LoggerTag)(makeMockLogger()),
								Layer.succeed(OrchestrationEngineTag)(
									withDispatchEffect({
										dispatchEffect: () =>
											Effect.succeed({
												models: [
													{
														id: model.model_id,
														name: model.model_id,
														providerId: "claude",
														variants: { [model.variant]: {} },
														contextWindowOptions: [
															{
																value: model.context_window,
																label: "Inherited",
															},
														],
													},
												],
												supportsTools: true,
												supportsThinking: true,
												supportsPermissions: true,
												supportsQuestions: true,
												supportsAttachments: true,
												supportsFork: true,
												supportsRevert: false,
												commands: [],
											}),
									}),
								),
							),
						);
						try {
							// Startup/migration and OS-cache warming are outside the command timer.
							await runtime.runPromise(
								Effect.gen(function* () {
									const sql = yield* SqlClient.SqlClient;
									yield* sql`SELECT data FROM events WHERE session_id = ${sessionId} ORDER BY sequence`;
								}),
							);
							const reads: string[] = [];
							const started = performance.now();
							const child = await runtime.runPromise(
								command(
									sessionId,
									kind === "side-thread"
										? {
												side: {
													title: "Storage benchmark",
													inputId: "benchmark-input",
												},
											}
										: undefined,
								).pipe(
									Effect.provideService(
										Statement.CurrentTransformer,
										(statement) => {
											const [sql] = statement.compile();
											if (
												/^\s*(SELECT|WITH)/i.test(sql) &&
												/\bFROM events\b/i.test(sql)
											)
												reads.push(sql);
											return Effect.succeed(statement);
										},
									),
								),
							);
							const elapsed = performance.now() - started;
							const result = new Database(filename, { readonly: true });
							try {
								const events = result
									.prepare<
										[string],
										{
											event_id: string;
											type: string;
											data: string;
											metadata: string;
											provider: string;
											created_at: number;
										}
									>(
										"SELECT event_id, type, data, metadata, provider, created_at FROM events WHERE session_id = ? AND (type NOT LIKE 'session.%' OR type = 'session.compaction') ORDER BY sequence",
									)
									.all(child.id);
								copiedEvents = events.length;
								hashes.push(
									createHash("sha256")
										.update(
											JSON.stringify(events).replaceAll(child.id, "CHILD"),
										)
										.digest("hex"),
								);
							} finally {
								result.close();
							}
							if (index > 0) {
								samples.push(elapsed);
								eventReads.push(reads);
							}
						} finally {
							await runtime.dispose();
						}
					}
					measurements.push({
						kind,
						version,
						samplesMs: samples,
						medianMs: [...samples].sort((a, b) => a - b)[1],
						eventReadCount: eventReads.map((reads) => reads.length),
						contentReadCount: eventReads.map(
							(reads) =>
								reads.filter((sql) => /\bdata\s*,\s*metadata\b/.test(sql))
									.length,
						),
						eventReadSql: eventReads[0],
						copiedEvents,
						hashes,
					});
				}
			}
			for (const kind of cases) {
				const before = measurements.find(
					(value) => value.kind === kind && value.version === "before",
				);
				const after = measurements.find(
					(value) => value.kind === kind && value.version === "after",
				);
				expect(new Set(before?.hashes)).toEqual(new Set(after?.hashes));
				expect(after?.copiedEvents).toBe(before?.copiedEvents);
			}
			const output = resolve(
				process.env["CONDUIT_FORK_OUTPUT"] ??
					join(tmpdir(), "fork-storage.json"),
			);
			writeFileSync(
				output,
				`${JSON.stringify({ ticket: "conduit-test-8rdf.6", snapshot: resolve(snapshot), baselineRef, sessionId, inputEvents, measuredAt: new Date().toISOString(), method: "Actual production forkSession command including bounded reads, copy, append and projection; native SDK I/O excluded; one warmup then three samples per case", measurements }, null, 2)}\n`,
			);
			console.log(
				JSON.stringify(
					{
						output,
						measurements: measurements.map(
							({ hashes, eventReadSql, ...measurement }) => measurement,
						),
					},
					null,
					2,
				),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
			rmSync(sourceDirectory, { recursive: true, force: true });
		}
	},
	360_000,
);
