// Failure modes: lost native parameter ids, stale selections on the next send,
// refresh/concurrent cache misses, account or credential cache collisions,
// cached failures/empty catalogs, and displaying the requested rerouted model.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	AddInstance,
	SaveProject,
	SwitchVariant,
} from "../../../src/lib/contracts/ws-rpc.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import { cursorModelInfo } from "../../../src/lib/provider/cursor/cursor-runner-driver.js";
import type { CursorModel } from "../../../src/lib/provider/cursor/sdk-port.js";
import type {
	HistoryMessage,
	ProviderInfo,
} from "../../../src/lib/shared-types.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

interface TraceRow {
	kind?: string;
	data?: unknown;
	[key: string]: unknown;
}
const TIMEOUT = 90_000;
const rowsAt = (path: string): TraceRow[] =>
	readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as TraceRow);

describe("Cursor model parameters, instance catalog cache and reroute", () => {
	let harness: ProcessHarness | undefined;
	let tracePath = "";
	let capturePath = "";
	let evidence: Record<string, unknown> = {};
	let source = "basic";
	const results: Record<string, unknown>[] = [];

	function writeTrace(
		credential = "[REDACTED]",
		catalog: "captured" | "failed" | "empty" = "captured",
	) {
		const rows = rowsAt(
			resolve(`test/fixtures/cursor-sdk-traces/${source}.jsonl`),
		);
		rows.splice(1, 0, {
			kind: "credential.store",
			data: {
				apiKey: credential,
				backendUrl: "https://api2.cursor.sh",
				createdAtMs: 0,
			},
		});
		const modified = rows.flatMap((row) =>
			row.kind !== "models.list" || catalog === "captured"
				? [row]
				: [
						catalog === "failed"
							? {
									kind: "models.list.error",
									data: { message: "captured catalog failure" },
								}
							: { ...row, data: [] },
					],
		);
		writeFileSync(
			tracePath,
			`${modified.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	}

	function calls(kind: string) {
		return rowsAt(capturePath).filter((row) => row.kind === kind);
	}

	async function catalogModels(browser: ProcessBrowser, accountId: string) {
		const cursor = browser.frames.length;
		await browser.getModels(accountId);
		const catalog = await browser.waitFor(
			(message) =>
				message["type"] === "project_setting" &&
				message["_tag"] === "providerModels" &&
				message["accountId"] === accountId,
			cursor,
		);
		const providers = catalog["providers"] as ProviderInfo[];
		return providers.find(({ id }) => id === "cursor")?.models ?? [];
	}

	async function start(
		name: string,
		options: {
			ttlMs?: number;
			catalog?: "failed" | "empty";
			capture?: string;
		} = {},
	) {
		evidence = { scenario: name };
		source = options.capture ?? "basic";
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		tracePath = join(harness.root, "cursor-models.jsonl");
		capturePath = join(harness.root, "cursor-models-capture.jsonl");
		writeTrace("[REDACTED]", options.catalog);
		await harness.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CURSOR_SDK_TRACE: tracePath,
				CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
				...(options.ttlMs === undefined
					? {}
					: { CONDUIT_TEST_CURSOR_CATALOG_TTL_MS: String(options.ttlMs) }),
			},
		});
		const added = await harness.requestRpc(
			new AddInstance({ name: "Cursor parameters", driver: "cursor" }),
		);
		if (!added.addedInstanceId) throw new Error("Missing Cursor account");
		return {
			fixture: harness,
			accountId: added.addedInstanceId,
			browser: await harness.connect(),
		};
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			const proof = fixture.proof();
			results.push({
				...evidence,
				result: task.result?.state,
				failures: task.result?.errors?.map(({ message }) => message) ?? [],
				process: {
					buildIdentity: proof.buildIdentity,
					daemonPids: proof.generations.map(({ pid }) => pid),
					remainingRunnerPids: fixture.remainingRunnerPids(),
					rpcDecodeFailures: proof.rpcDecodeFailures,
					...(task.result?.errors?.length ? { logTail: proof.logTail } : {}),
				},
			});
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/conduit-test-xqsg.18.json",
				`${JSON.stringify({ ticket: "conduit-test-xqsg.18", scenarios: results }, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	it("preserves native parameter ids and applies a picker change on the next send", async () => {
		const { fixture, browser, accountId } = await start("parameter-change", {
			capture: "turn-model-parameters",
		});
		const models = await catalogModels(browser, accountId);
		expect(models.find(({ id }) => id === "composer-2.5")?.variants).toEqual([
			"Standard",
			"Fast",
		]);
		expect(models.find(({ id }) => id === "grok-4.7")?.variants).toContain(
			"500K · high · Fast",
		);
		const id = await browser.createSession(
			"Cursor model parameters",
			accountId,
			"cursor",
			{ modelId: "grok-4.7", variant: "256K · low", contextWindow: "" },
		);
		await browser.send(id, "Say hi.", TIMEOUT);
		await fixture.requestRpc(
			new SwitchVariant({
				sessionId: id,
				variant: "500K · high · Fast",
				originId: browser.originId,
			}),
		);
		await browser.send(id, "Say hi again.", TIMEOUT);
		const sends = calls("send.options").map(({ data }) => data);
		expect(sends).toEqual([
			expect.objectContaining({
				options: {
					model: {
						id: "grok-4.7",
						params: [
							{ id: "context", value: "256k" },
							{ id: "reasoning_effort", value: "low" },
							{ id: "fast", value: "false" },
						],
					},
					mode: "agent",
				},
			}),
			expect.objectContaining({
				options: {
					model: {
						id: "grok-4.7",
						params: [
							{ id: "context", value: "500k" },
							{ id: "reasoning_effort", value: "high" },
							{ id: "fast", value: "true" },
						],
					},
					mode: "agent",
				},
			}),
		]);
		expect(calls("create.options")).toHaveLength(1);
		expect(calls("resume.options")).toHaveLength(1);
		const { agentId, ...resumedOptions } = calls("resume.options")[0]
			?.data as Record<string, unknown>;
		expect(calls("created")[0]?.data).toEqual({ agentId });
		expect(resumedOptions).toEqual(calls("create.options")[0]?.data);
		expect(fixture.runnerPids()).toHaveLength(1);
		const capturedCatalog = rowsAt(tracePath).find(
			({ kind }) => kind === "models.list",
		)?.data as { models: CursorModel[] };
		const defaults = [
			{
				modelId: "composer-2.5",
				variant: "Standard",
				params: [{ id: "fast", value: "false" }],
			},
			{
				modelId: "grok-4.6",
				variant: "high",
				params: [
					{ id: "effort", value: "high" },
					{ id: "fast", value: "false" },
				],
			},
		];
		for (const { modelId, variant, params } of defaults) {
			const captured = capturedCatalog.models.find(({ id }) => id === modelId);
			if (!captured) throw new Error(`Missing captured model ${modelId}`);
			expect(
				Object.entries(cursorModelInfo(captured).variants ?? {}).filter(
					([, value]) => value["isDefault"] === true,
				),
			).toEqual([[variant, { params, isDefault: true }]]);
			const defaultId = await browser.createSession(
				`Cursor ${modelId} default`,
				accountId,
				"cursor",
				{ modelId, contextWindow: "" },
			);
			await browser.send(defaultId, "Say hi.", TIMEOUT);
			expect(calls("send.options").at(-1)?.data).toMatchObject({
				options: { model: { id: modelId, params } },
			});
		}
		evidence = {
			...evidence,
			sends,
			unchangedAgentOptions: true,
			pickerDefaultsAgreeWithSendParams: defaults,
		};
	}, 300_000);

	it("reuses a daemon-wide catalog across refreshes and projects and isolates account and credential keys", async () => {
		const { fixture, browser, accountId } = await start("cache-identity");
		await browser.getModels(accountId);
		await browser.instances();
		const before = calls("models.list.call").length;
		expect(before).toBe(1);
		await Promise.all([
			browser.getModels(accountId),
			browser.getModels(accountId),
			browser.instances(),
		]);
		const refreshed = await fixture.connect();
		await refreshed.getModels(accountId);
		expect(calls("models.list.call")).toHaveLength(before);
		const directory = join(fixture.root, "second-project");
		mkdirSync(directory);
		const addedProject = await fixture.requestRpc(
			new SaveProject({ folders: [directory] }),
		);
		const secondProject = await fixture.connect(
			undefined,
			undefined,
			addedProject.savedSlug,
		);
		expect(await catalogModels(secondProject, accountId)).toHaveLength(47);
		expect(calls("models.list.call")).toHaveLength(before);
		const second = await fixture.requestRpc(
			new AddInstance({ name: "Second Cursor", driver: "cursor" }),
		);
		if (!second.addedInstanceId)
			throw new Error("Missing second Cursor account");
		await browser.getModels(second.addedInstanceId);
		expect(calls("models.list.call").length).toBeGreaterThan(before);
		const beforeRotation = calls("models.list.call").length;
		writeTrace("[REDACTED:rotated]");
		await Promise.all([
			browser.getModels(accountId),
			browser.getModels(accountId),
			browser.getModels(accountId),
		]);
		expect(calls("models.list.call")).toHaveLength(beforeRotation + 1);
		evidence = {
			...evidence,
			cacheHitAcrossRefreshAndConcurrency: true,
			cacheHitAcrossProjects: true,
			accountIsolation: true,
			rotatedFingerprintMiss: true,
			concurrentMissShared: true,
			sdkCalls: calls("models.list.call").length,
		};
	}, 300_000);

	it("misses after the test-only catalog expiry", async () => {
		const { browser, accountId } = await start("cache-expiry", { ttlMs: 1 });
		await browser.getModels(accountId);
		const before = calls("models.list.call").length;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		await browser.getModels(accountId);
		expect(calls("models.list.call").length).toBeGreaterThan(before);
		evidence = { ...evidence, ttlMs: 1, missedAfterExpiry: true };
	}, 300_000);

	for (const catalog of ["failed", "empty"] as const) {
		it(`does not cache a ${catalog} catalog and reports why Cursor is unavailable`, async () => {
			const { browser, accountId } = await start(`cache-${catalog}`, {
				catalog,
			});
			await browser.getModels(accountId);
			const before = calls("models.list.call").length;
			const inventory = await browser.instances();
			expect(
				inventory.instances.find(({ id }) => id === accountId),
			).toMatchObject({
				available: false,
				unavailableReason:
					catalog === "failed"
						? "Cursor model list failed"
						: "Cursor model list is empty",
			});
			expect(calls("models.list.call").length).toBeGreaterThan(before);
			writeTrace();
			const recovered = await catalogModels(browser, accountId);
			expect(recovered).toHaveLength(47);
			evidence = {
				...evidence,
				failedListRetried: true,
				recoveredWithoutRestart: true,
			};
		}, 300_000);
	}

	it("preserves Claude user history and transcript rows after Cursor discovery", async () => {
		const { fixture, browser, accountId } = await start(
			"claude-history-unchanged",
		);
		await catalogModels(browser, accountId);
		const id = await browser.createSession("Claude history unchanged");
		await browser.send(id, "Say hi.", TIMEOUT);
		const history = await browser.history(id);
		const user = history.find(({ role }) => role === "user");
		expect(user).toBeDefined();
		expect(user).not.toHaveProperty("modelExecution");
		const refreshed = await fixture.connect(id);
		const liveUser = await refreshed.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["sessionId"] === id &&
				message["id"] === user?.id,
		);
		expect(liveUser).not.toHaveProperty("modelExecution");
		const db = new Database(fixture.projectStorePath(), { readonly: true });
		try {
			const turn = db
				.prepare<[string], { actual_model: string }>(
					"SELECT actual_model FROM turns WHERE session_id = ?",
				)
				.get(id);
			expect(turn?.actual_model).toEqual(expect.any(String));
			expect(
				db
					.prepare<[string], { turn_id: string | null }>(
						"SELECT turn_id FROM messages WHERE session_id = ? AND role = 'user'",
					)
					.get(id),
			).toEqual({ turn_id: null });
			evidence = {
				...evidence,
				resolvedTurnModel: turn?.actual_model,
				historyUserHasModelExecution: false,
				liveUserHasModelExecution: false,
				userTurnLinkUnchanged: true,
			};
		} finally {
			db.close();
		}
	}, 300_000);

	for (const requestedModel of ["composer-2", "default"] as const) {
		it(`persists ${requestedModel === "default" ? "Auto's resolved model without drift" : "a rerouted Composer model with drift"} in history and the live transcript`, async () => {
			const rerouted = requestedModel === "composer-2";
			const { fixture, browser, accountId } = await start(
				rerouted ? "model-reroute" : "auto-model-resolution",
				{ capture: rerouted ? "turn-model-reroute" : "basic" },
			);
			const id = await browser.createSession(
				rerouted ? "Retired Composer" : "Cursor Auto",
				accountId,
				"cursor",
				{ modelId: requestedModel, contextWindow: "" },
			);
			const before = browser.frames.length;
			await browser.send(id, "Say hi.", TIMEOUT);
			const history = await browser.history(id);
			const execution = {
				requestedModel,
				expectedModel: rerouted ? requestedModel : "composer-2.5",
				actualModel: "composer-2.5",
				drifted: rerouted,
			};
			const user = history.find(({ role }) => role === "user");
			const assistant = history.find(({ role }) => role === "assistant");
			expect(user?.modelExecution).toEqual(execution);
			expect(historyToChatMessages(history as HistoryMessage[])).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "user",
						messageId: user?.id,
						modelExecution: execution,
					}),
				]),
			);
			const liveUser = await browser.waitFor(
				(message) =>
					message["type"] === "transcript_message" &&
					message["sessionId"] === id &&
					message["id"] === user?.id &&
					typeof message["modelExecution"] === "object",
				before,
				TIMEOUT,
			);
			expect(liveUser["modelExecution"]).toEqual(execution);
			const db = new Database(fixture.projectStorePath(), { readonly: true });
			try {
				const events = db
					.prepare<[string], { data: string }>(
						"SELECT data FROM events WHERE session_id = ? AND type = 'turn.model_resolved'",
					)
					.all(id);
				const turns = db
					.prepare<
						[string],
						{
							id: string;
							state: string;
							user_message_id: string;
							assistant_message_id: string;
							requested_model: string;
							expected_model: string;
							actual_model: string;
						}
					>(
						"SELECT id, state, user_message_id, assistant_message_id, requested_model, expected_model, actual_model FROM turns WHERE session_id = ?",
					)
					.all(id);
				const messageOwners = db
					.prepare<[string], { id: string; role: string; turn_id: string }>(
						"SELECT id, role, turn_id FROM messages WHERE session_id = ?",
					)
					.all(id);
				expect(events).toHaveLength(1);
				expect(JSON.parse(events[0]?.data ?? "null")).toMatchObject({
					messageId: assistant?.id,
					requestedModel,
					expectedModel: execution.expectedModel,
					actualModel: execution.actualModel,
				});
				expect(turns).toEqual([
					{
						id: expect.any(String),
						state: "completed",
						user_message_id: user?.id,
						assistant_message_id: assistant?.id,
						requested_model: requestedModel,
						expected_model: execution.expectedModel,
						actual_model: execution.actualModel,
					},
				]);
				expect(messageOwners).toEqual(
					expect.arrayContaining([
						{ id: user?.id, role: "user", turn_id: turns[0]?.id },
						{ id: assistant?.id, role: "assistant", turn_id: turns[0]?.id },
					]),
				);
				evidence = {
					...evidence,
					modelEvents: events.map(({ data }) => JSON.parse(data) as unknown),
					turnRows: turns,
					messageOwners,
					sourceCapture: "basic.jsonl",
					...(rerouted ? { derivedFixture: "turn-model-reroute.jsonl" } : {}),
					historyModelExecution: user?.modelExecution,
					liveModelExecution: liveUser["modelExecution"],
					historyUserMessageDisplaysActualModel: true,
				};
			} finally {
				db.close();
			}
		}, 300_000);
	}
});
