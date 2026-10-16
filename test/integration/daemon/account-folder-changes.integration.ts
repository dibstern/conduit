/*
 * Folder changes through the foreground daemon, browser RPC and runner process:
 * - An idle live query must not keep an edited or cleared account folder.
 * - An unused prewarmed query must not survive a folder edit or clear.
 * - Editing during a turn must preserve that turn's query and settings.
 * - Steering that turn must still reach its original query after a folder edit.
 * - A steer during runner startup must retain the original turn's saved account.
 * - Missing native history in the new folder must use the canonical handoff.
 * - A shared transcript may resume, but its old receipt cannot pick the folder.
 * - Legacy receipts without a folder must also fall back when resume is missing.
 * - Forking before the next turn after a folder edit must copy bounded canonical
 *   history without reading the old native transcript from the new login.
 * All logins, daemon state and child processes belong to the process harness.
 */
import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import {
	AddInstance,
	ForkSessionForSession,
	UpdateInstance,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

interface Launch {
	pid: number;
	prompt: string;
	configDir: string;
	resumeId: string | null;
}

describe("Account folder changes without daemon restart", () => {
	let harness: ProcessHarness | undefined;
	const evidence: unknown[] = [];
	const launches = () => {
		if (!harness) throw new Error("Missing process harness");
		const file = join(harness.root, "claude-options.jsonl");
		return existsSync(file)
			? readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Launch)
			: [];
	};
	afterEach(async ({ task }) => {
		if (!harness) return;
		const db = new Database(harness.projectStorePath(), { readonly: true });
		let persisted: {
			inputs: unknown[];
			commands: unknown[];
			events: unknown[];
			forkEvents: unknown[];
		};
		try {
			persisted = {
				inputs: db
					.prepare(
						"SELECT input_id, state FROM pending_inputs ORDER BY input_id",
					)
					.all(),
				commands: db
					.prepare(
						"SELECT command_id, status, json_extract(payload_json, '$.account.folder.path') AS folder FROM provider_command_outbox WHERE effect_type = 'send_turn' ORDER BY request_sequence",
					)
					.all(),
				events: db
					.prepare(
						"SELECT type, json_extract(data, '$.inputId') AS inputId, json_extract(data, '$.messageId') AS messageId, json_extract(data, '$.status') AS status FROM events WHERE type IN ('input.admitted', 'input.sent', 'input.started', 'turn.started', 'turn.end', 'turn.error', 'session.status') ORDER BY sequence",
					)
					.all(),
				forkEvents: db
					.prepare(
						"SELECT session_id, type, data FROM events WHERE type IN ('session.created', 'session.forked') ORDER BY sequence",
					)
					.all(),
			};
		} finally {
			db.close();
		}
		const proof = {
			name: task.name,
			result: task.result?.state,
			launches: launches(),
			marks: [...harness.marks],
			persisted,
		};
		await harness.dispose();
		harness.assertNoRunners();
		evidence.push({ ...proof, allChildrenTerminated: true });
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/g4zp-11-folder-changes.json",
			`${JSON.stringify(evidence, null, 2)}\n`,
		);
		harness = undefined;
	});
	async function start(queryInitializationDelayMs = 0, helloDelayMs = 0) {
		harness = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			foregroundCli: true,
			restartProof: true,
			queryInitializationDelayMs,
			...(helloDelayMs ? { runnerLifecycle: { helloDelayMs } } : {}),
		});
		return { daemon: harness, browser: await harness.connect() };
	}
	function login(daemon: ProcessHarness, name: string) {
		const folder = join(daemon.root, name);
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "conduit-test-record-forks"), "");
		writeFileSync(
			join(folder, "settings.json"),
			JSON.stringify({ env: { FOLDER_PROOF: name } }),
		);
		return folder;
	}

	it("forks bounded canonical history after a folder edit before the next parent turn", async () => {
		const { daemon, browser } = await start();
		const original = login(daemon, "original-fork");
		const edited = login(daemon, "edited-fork");
		const accountId = AccountIdSchema.make("claude");
		await daemon.requestRpc(
			new UpdateInstance({ instanceId: accountId, configDir: original }),
		);
		const parentId = await browser.createSession(
			"Fork after login edit",
			accountId,
		);
		const retained = "history-before-fork-boundary";
		expect((await browser.send(parentId, retained)).chunks.join("")).toBe(
			responseChunks(retained).join(""),
		);
		const boundary = (await browser.history(parentId)).find(
			(message) => message.role === "assistant",
		);
		if (!boundary) throw new Error("Missing completed assistant fork boundary");
		const excluded = "history-after-fork-boundary";
		await browser.send(parentId, excluded);
		const originalQuery = daemon.marks.find((mark) => mark.kind === "query");
		if (originalQuery?.kind !== "query")
			throw new Error("Missing original-folder query");
		expect(
			existsSync(
				join(
					original,
					`conduit-test-transcript-${originalQuery.sessionId}.ndjson`,
				),
			),
		).toBe(true);
		expect(
			existsSync(
				join(
					edited,
					`conduit-test-transcript-${originalQuery.sessionId}.ndjson`,
				),
			),
		).toBe(false);
		await daemon.requestRpc(
			new UpdateInstance({ instanceId: accountId, configDir: edited }),
		);
		const fork = await daemon.requestRpc(
			new ForkSessionForSession({
				originId: browser.originId,
				sessionId: parentId,
				messageId: boundary.id,
			}),
		);
		expect(fork.sessionId).not.toBe(parentId);
		expect(daemon.marks.filter((mark) => mark.kind === "native-fork")).toEqual(
			[],
		);
		const forkText = (await browser.history(fork.sessionId)).flatMap(
			(message) =>
				message.parts?.flatMap((part) =>
					part.type === "text" ? [part.text] : [],
				) ?? [],
		);
		expect(forkText).toContain(retained);
		expect(forkText).toContain(responseChunks(retained).join(""));
		expect(forkText).not.toContain(excluded);
		expect(forkText).not.toContain(responseChunks(excluded).join(""));
		const next = "first-turn-in-edited-fork";
		expect((await browser.send(fork.sessionId, next)).chunks.join("")).toBe(
			responseChunks(next).join(""),
		);
		expect(launches().at(-1)).toMatchObject({
			configDir: edited,
			resumeId: null,
		});
		expect(launches().at(-1)?.prompt).toContain("[Conduit context handoff]");
		expect(launches().at(-1)?.prompt).toContain(retained);
		expect(launches().at(-1)?.prompt).toContain(
			responseChunks(retained).join(""),
		);
		expect(launches().at(-1)?.prompt).not.toContain(excluded);
		expect(daemon.marks.filter((mark) => mark.kind === "native-fork")).toEqual(
			[],
		);
		expect(daemon.generations).toHaveLength(1);
	});

	it.each([
		false,
		true,
	])("uses the current folder across an edit and clear, preserving an in-flight turn, shared transcript=%s", async (sharedTranscript) => {
		const { daemon, browser } = await start();
		const original = login(daemon, "original");
		const edited = login(daemon, "edited");
		const launchLogin = login(daemon, "claude");
		const accountId = AccountIdSchema.make("claude");
		await daemon.requestRpc(
			new UpdateInstance({ instanceId: accountId, configDir: original }),
		);
		const sessionId = await browser.createSession(
			"Folder edits keep the conversation",
			accountId,
		);
		const initialPid = daemon.generations[0]?.pid;
		const first = "history-before-folder-edit";
		expect((await browser.send(sessionId, first)).chunks.join("")).toBe(
			responseChunks(first).join(""),
		);
		const initialQuery = daemon.marks.find((mark) => mark.kind === "query");
		if (initialQuery?.kind !== "query")
			throw new Error("Missing initial query");
		const active = browser.send(sessionId, "local-work-turn");
		await vi.waitFor(() =>
			expect(
				daemon.marks.some(
					(mark) =>
						mark.kind === "pre-assistant-held" &&
						mark.queryId === initialQuery.queryId,
				),
			).toBe(true),
		);
		await daemon.requestRpc(
			new UpdateInstance({ instanceId: accountId, configDir: edited }),
		);
		await browser.preWarmSession(sessionId);
		expect(daemon.marks.filter((mark) => mark.kind === "query")).toHaveLength(
			1,
		);
		expect(
			daemon.marks.some(
				(mark) =>
					mark.kind === "query-closed" && mark.queryId === initialQuery.queryId,
			),
		).toBe(false);
		expect(launches().map((launch) => launch.configDir)).toEqual([
			original,
			original,
		]);
		writeFileSync(join(daemon.root, "release-local-work"), "release");
		await active;

		const relocateOrReject = (nativeId: string, from: string, to: string) => {
			if (sharedTranscript) {
				const filename = `conduit-test-transcript-${nativeId}.ndjson`;
				copyFileSync(join(from, filename), join(to, filename));
				copyFileSync(
					join(from, `${filename}.directory`),
					join(to, `${filename}.directory`),
				);
			} else
				writeFileSync(
					join(daemon.root, "rejected-resume-session-id"),
					nativeId,
				);
		};
		relocateOrReject(initialQuery.sessionId, original, edited);
		const next = "turn-after-folder-edit";
		expect((await browser.send(sessionId, next)).chunks.join("")).toBe(
			responseChunks(next).join(""),
		);
		const afterEdit = launches().at(-1);
		expect(afterEdit?.configDir).toBe(edited);
		if (sharedTranscript)
			expect(afterEdit?.resumeId).toBe(initialQuery.sessionId);
		else {
			expect(afterEdit?.resumeId).toBeNull();
			expect(afterEdit?.prompt).toContain("[Conduit context handoff]");
			expect(afterEdit?.prompt).toContain(first);
			expect(afterEdit?.prompt).toContain(responseChunks(first).join(""));
		}
		const editedQuery = daemon.marks
			.filter((mark) => mark.kind === "query")
			.at(-1);
		if (editedQuery?.kind !== "query")
			throw new Error("Missing edited-folder query");
		relocateOrReject(editedQuery.sessionId, edited, launchLogin);
		await daemon.requestRpc(
			new UpdateInstance({ instanceId: accountId, configDir: "" }),
		);
		const cleared = "turn-after-folder-clear";
		expect((await browser.send(sessionId, cleared)).chunks.join("")).toBe(
			responseChunks(cleared).join(""),
		);
		const afterClear = launches().at(-1);
		expect(afterClear?.configDir).toBe(launchLogin);
		if (!sharedTranscript) {
			expect(afterClear?.resumeId).toBeNull();
			expect(afterClear?.prompt).toContain(first);
			expect(afterClear?.prompt).toContain(next);
		}
		const queries = daemon.marks.filter((mark) => mark.kind === "query");
		expect(queries.map((mark) => mark.env["CLAUDE_CONFIG_DIR"])).toEqual(
			sharedTranscript
				? [original, edited, launchLogin]
				: [original, edited, edited, launchLogin, launchLogin],
		);
		for (const query of queries) {
			const folderName = query.env["CLAUDE_CONFIG_DIR"]?.split("/").at(-1);
			expect(JSON.parse(query.effectiveSettingsJson)).toMatchObject({
				env: { FOLDER_PROOF: folderName },
			});
		}
		expect(daemon.generations.map((generation) => generation.pid)).toEqual([
			initialPid,
		]);
		expect(
			(await browser.history(sessionId))
				.filter((message) => message.role === "user")
				.map((message) => message.text),
		).toEqual([first, "local-work-turn", next, cleared]);
	});

	it.each([
		["send", false],
		["pre-warm", false],
		["send", true],
		["pre-warm", true],
	] as const)("replaces unused named-account queries after edit and clear before %s, initialization pending=%s", async (action, initializing) => {
		const { daemon, browser } = await start(initializing ? 800 : 0);
		const original = login(daemon, "original");
		const edited = login(daemon, "edited");
		const launchLogin = login(daemon, "claude");
		const added = await daemon.requestRpc(
			new AddInstance({
				name: "Personal",
				driver: "claude",
				managed: false,
				configDir: original,
			}),
		);
		if (!added.addedInstanceId) throw new Error("Missing named account");
		const accountId = AccountIdSchema.make(added.addedInstanceId);
		for (const [configDir, resolvedFolder] of [
			[edited, edited],
			["", launchLogin],
		] as const) {
			const sessionId = await browser.createSession(
				"Unused query folder",
				accountId,
			);
			const queriesBefore = daemon.marks.filter(
				(mark) => mark.kind === "query",
			).length;
			const warm = browser.preWarmSession(sessionId).then(
				() => "ready",
				() => "cancelled",
			);
			if (initializing) {
				await vi.waitFor(
					() =>
						expect(
							daemon.marks.filter((mark) => mark.kind === "query").length,
						).toBeGreaterThan(queriesBefore),
					{ timeout: 5000 },
				);
			} else await warm;
			const warmed = daemon.marks
				.filter((mark) => mark.kind === "query")
				.at(-1);
			if (warmed?.kind !== "query") throw new Error("Missing warmed query");
			await daemon.requestRpc(
				new UpdateInstance({ instanceId: accountId, configDir }),
			);
			if (action === "pre-warm") await browser.preWarmSession(sessionId);
			const text = `first-send-after-${configDir ? "edit" : "clear"}`;
			expect((await browser.send(sessionId, text)).chunks.join("")).toBe(
				responseChunks(text).join(""),
			);
			await warm;
			expect(launches().at(-1)?.configDir).toBe(resolvedFolder);
			const current = daemon.marks
				.filter((mark) => mark.kind === "query")
				.at(-1);
			expect(current?.queryId).not.toBe(warmed.queryId);
			expect(
				daemon.marks.some(
					(mark) =>
						mark.kind === "query-closed" && mark.queryId === warmed.queryId,
				),
			).toBe(true);
		}
		expect(daemon.generations).toHaveLength(1);
	});

	it("keeps steering the running turn on its original folder after an edit", async () => {
		const { daemon, browser } = await start();
		const original = login(daemon, "original");
		const edited = login(daemon, "edited");
		await daemon.requestRpc(
			new UpdateInstance({
				instanceId: AccountIdSchema.make("claude"),
				configDir: original,
			}),
		);
		const sessionId = await browser.createSession(
			"Folder edits preserve steering",
			"claude",
		);
		const active = browser.send(sessionId, "local-work-turn");
		try {
			await vi.waitFor(
				() =>
					expect(
						daemon.marks.some((mark) => mark.kind === "pre-assistant-held"),
					).toBe(true),
				{ timeout: 5000 },
			);
			await daemon.requestRpc(
				new UpdateInstance({
					instanceId: AccountIdSchema.make("claude"),
					configDir: edited,
				}),
			);
			const inputId = randomUUID();
			// The fixture emits the SDK's command-start boundary for corrections.
			const steerText = "correction-after-folder-edit";
			const submitted = await Effect.runPromise(
				browser.rpc.input.submit({
					sessionId,
					inputId,
					originId: browser.originId,
					delivery: "steer",
					text: steerText,
				}),
			);
			expect(submitted.ok).toBe(true);
			await vi.waitFor(() =>
				expect(
					daemon.marks.some(
						(mark) =>
							mark.kind === "runner-command" &&
							mark.commandId === inputId &&
							mark.type === "send-turn",
					),
				).toBe(true),
			);
			expect(daemon.marks.filter((mark) => mark.kind === "query")).toHaveLength(
				1,
			);
			writeFileSync(join(daemon.root, "release-local-work"), "release");
			await active;
			await vi.waitFor(() =>
				expect(
					daemon.marks.some(
						(mark) => mark.kind === "emit" && mark.prompt.endsWith(steerText),
					),
				).toBe(true),
			);
			expect(launches().at(-1)?.configDir).toBe(original);
			await browser.send(sessionId, "next-turn-after-steering");
			await vi.waitFor(
				() =>
					expect(
						launches().at(-1)?.prompt.endsWith("next-turn-after-steering"),
					).toBe(true),
				{ timeout: 5000 },
			);
			expect(launches().at(-1)?.configDir).toBe(edited);
		} finally {
			writeFileSync(join(daemon.root, "release-local-work"), "release");
			await active;
		}
	});

	it("retains the original account for a steer before the runner publishes its launch snapshot", async () => {
		const { daemon, browser } = await start(0, 4000);
		const original = login(daemon, "original");
		const edited = login(daemon, "edited");
		await daemon.requestRpc(
			new UpdateInstance({
				instanceId: AccountIdSchema.make("claude"),
				configDir: original,
			}),
		);
		const sessionId = await browser.createSession(
			"Steer during runner startup",
			"claude",
		);
		const first = "first-turn-before-startup-edit";
		const active = browser.send(sessionId, first, 20_000);
		try {
			await vi.waitFor(
				() =>
					expect(
						daemon.marks.some((mark) => mark.kind === "runner-hello-pending"),
					).toBe(true),
				{ timeout: 10_000 },
			);
			await daemon.requestRpc(
				new UpdateInstance({
					instanceId: AccountIdSchema.make("claude"),
					configDir: edited,
				}),
			);
			const steerText = "correction-during-runner-startup";
			expect(
				(
					await Effect.runPromise(
						browser.rpc.input.submit({
							sessionId,
							inputId: randomUUID(),
							originId: browser.originId,
							delivery: "steer",
							text: steerText,
						}),
					)
				).ok,
			).toBe(true);
			expect(daemon.marks.filter((mark) => mark.kind === "query")).toHaveLength(
				0,
			);
			const db = new Database(daemon.projectStorePath(), { readonly: true });
			try {
				expect(
					db
						.prepare(
							"SELECT json_extract(payload_json, '$.account.folder.path') AS folder FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
						)
						.all(sessionId),
				).toEqual([{ folder: original }, { folder: original }]);
			} finally {
				db.close();
			}
			await active;
			await vi.waitFor(
				async () =>
					expect(
						(await browser.history(sessionId)).some(
							(message) =>
								message.role === "assistant" &&
								message.text === responseChunks(steerText).join(""),
						),
					).toBe(true),
				{ timeout: 5000 },
			);
			expect(launches().map((launch) => launch.configDir)).toEqual([
				original,
				original,
			]);
			const native = daemon.marks.find((mark) => mark.kind === "query");
			if (native?.kind !== "query") throw new Error("Missing original query");
			writeFileSync(
				join(daemon.root, "rejected-resume-session-id"),
				native.sessionId,
			);
			const next = "next-turn-after-startup-edit";
			await browser.send(sessionId, next);
			await vi.waitFor(
				() => expect(launches().at(-1)?.prompt.endsWith(next)).toBe(true),
				{ timeout: 5000 },
			);
			expect(launches().at(-1)).toMatchObject({
				configDir: edited,
				resumeId: null,
			});
			expect(launches().at(-1)?.prompt).toContain(
				responseChunks(first).join(""),
			);
			expect(launches().at(-1)?.prompt).toContain(
				responseChunks(steerText).join(""),
			);
		} finally {
			await active;
		}
	});

	it.each([
		"edit",
		"clear",
	])("preserves history after a folder %s with a folderless legacy receipt", async (change) => {
		const { daemon, browser } = await start();
		const original = login(daemon, "original");
		const target = login(daemon, change === "edit" ? "edited" : "claude");
		const accountId = AccountIdSchema.make("claude");
		await daemon.requestRpc(
			new UpdateInstance({ instanceId: accountId, configDir: original }),
		);
		const sessionId = await browser.createSession(
			"Legacy receipt folder change",
			accountId,
		);
		const first = "history-with-legacy-receipt";
		await browser.send(sessionId, first);
		const native = daemon.marks.find((mark) => mark.kind === "query");
		if (native?.kind !== "query") throw new Error("Missing native receipt");
		const db = new Database(daemon.projectStorePath());
		try {
			await vi.waitFor(() =>
				expect(
					db
						.prepare(
							"SELECT value FROM provider_state WHERE session_id = ? AND key = 'nativeThread:claude'",
						)
						.get(sessionId),
				).toBeDefined(),
			);
			// Seed the persisted shape from builds that recorded only a resume id.
			db.transaction(() => {
				db.prepare(
					"DELETE FROM provider_state WHERE session_id = ? AND (key LIKE 'nativeThread:%' OR key = 'claudeConfigDir')",
				).run(sessionId);
				db.prepare(
					"INSERT INTO provider_state (session_id, key, value) VALUES (?, 'resumeSessionId', ?) ON CONFLICT (session_id, key) DO UPDATE SET value = excluded.value",
				).run(sessionId, native.sessionId);
			})();
		} finally {
			db.close();
		}
		await daemon.requestRpc(
			new UpdateInstance({
				instanceId: accountId,
				configDir: change === "edit" ? target : "",
			}),
		);
		writeFileSync(
			join(daemon.root, "rejected-resume-session-id"),
			native.sessionId,
		);
		const next = `turn-after-legacy-folder-${change}`;
		expect((await browser.send(sessionId, next)).chunks.join("")).toBe(
			responseChunks(next).join(""),
		);
		expect(launches().at(-1)).toMatchObject({
			configDir: target,
			resumeId: null,
		});
		expect(launches().at(-1)?.prompt).toContain(first);
		expect(launches().at(-1)?.prompt).toContain(responseChunks(first).join(""));
		expect(daemon.generations).toHaveLength(1);
	});

	it("uses the edited folder when returning to an account with a historical receipt", async () => {
		const { daemon, browser } = await start();
		const original = login(daemon, "original");
		const edited = login(daemon, "edited");
		const spare = login(daemon, "spare");
		await daemon.requestRpc(
			new UpdateInstance({
				instanceId: AccountIdSchema.make("claude"),
				configDir: original,
			}),
		);
		const added = await daemon.requestRpc(
			new AddInstance({
				name: "Spare",
				driver: "claude",
				managed: false,
				configDir: spare,
			}),
		);
		if (!added.addedInstanceId) throw new Error("Missing spare account");
		const sessionId = await browser.createSession(
			"Receipt folder is historical",
			"claude",
		);
		await browser.send(sessionId, "original-account-history");
		const native = daemon.marks.find((mark) => mark.kind === "query");
		if (native?.kind !== "query") throw new Error("Missing original receipt");
		const filename = `conduit-test-transcript-${native.sessionId}.ndjson`;
		copyFileSync(join(original, filename), join(edited, filename));
		copyFileSync(
			join(original, `${filename}.directory`),
			join(edited, `${filename}.directory`),
		);
		const switchTo = (instanceId: string, expectedInstanceId: string) =>
			Effect.runPromise(
				browser.rpc.ContinueSession({
					sessionId,
					instanceId,
					expectedInstanceId,
					originId: browser.originId,
				}),
			);
		await switchTo(added.addedInstanceId, "claude");
		await browser.send(sessionId, "spare-account-history");
		await daemon.requestRpc(
			new UpdateInstance({
				instanceId: AccountIdSchema.make("claude"),
				configDir: edited,
			}),
		);
		await switchTo("claude", added.addedInstanceId);
		await browser.send(sessionId, "return-to-edited-account");
		expect(launches().at(-1)).toMatchObject({
			configDir: edited,
			resumeId: native.sessionId,
		});
		expect(launches().at(-1)?.prompt).toContain("spare-account-history");
		expect(daemon.generations).toHaveLength(1);
	});
});
