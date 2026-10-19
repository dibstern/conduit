import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RpcTest } from "@effect/rpc";
import Database from "better-sqlite3";
import { Effect, Either, HashMap, Ref, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/provider-instance.js";
import {
	type OpenCodeInstance,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	type DaemonConfig,
	loadDaemonConfigResult,
} from "../../../src/lib/daemon/config-persistence.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import {
	addInstance,
	InstanceManagerStateTag,
	scheduleRestart,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure cases: quiet SSE loss leaves cached relay health connected, restart
// exhaustion leaves Settings unhealthy, and managed stop strands busy rows or
// keeps a viewed session's fallback poller warning against a stopped client.
describe("managed OpenCode connection health reaches daemon clients", () => {
	const instanceId = MANAGED_OPENCODE_ACCOUNT_ID;
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(
		name: string,
		managedOpenCode = false,
		primaryId: string = instanceId,
	) {
		scenario = name;
		evidence = { ticket: "conduit-test-rqbc.4", at: new Date().toISOString() };
		harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
			managedOpenCode,
			logLevel: "warn",
			...(managedOpenCode ? { holdRunnerOutput: "send-turn" as const } : {}),
		});
		if (managedOpenCode) {
			const config = Either.getOrThrowWith(
				loadDaemonConfigResult(harness.configDir),
				(error) => error,
			);
			if (!config) throw new Error("Missing initial harness config");
			// The default session id aliases the project's selected instance.
			// Select an explicit default so managed-test really is a second server.
			writeFileSync(
				join(harness.configDir, "daemon.json"),
				JSON.stringify({
					...config,
					projects: config.projects.map((project) => ({
						...project,
						instanceId: primaryId,
					})),
					instances: [
						{
							id: primaryId,
							name: "Default test",
							port: 0,
							managed: true,
							driver: "opencode",
						},
						...(config.instances ?? []).map((instance) => ({
							...instance,
							env: {
								...instance.env,
								CONDUIT_TEST_OPENCODE_STATE_PREFIX: instance.id,
							},
						})),
					],
				} satisfies DaemonConfig),
			);
		}
		await harness.restart({ opencodeIdleTimeoutMs: 120_000 });
		return harness;
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["logTail"] = fixture.logTail;
			evidence["requests"] = fixture.opencodeRequests();
			evidence["streamConnections"] = fixture.opencodeStreamConnections();
			evidence["failures"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
			await fixture.terminate();
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				const result = { ...evidence, process: fixture.proof() };
				writeFileSync(
					`test-results/rqbc-4-${scenario}.json`,
					JSON.stringify(result, null, 2),
				);
				harness = undefined;
			}
		}
	});

	it("reports quiet managed stream loss as disconnected before any replacement frame", async () => {
		const fixture = await start("quiet-stream-loss");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Quiet transport",
			instanceId,
			"opencode",
		);
		await browser.view(sessionId);
		const relayHealth = async () =>
			(await browser.daemonStatus()).projects.find(
				({ slug }) => slug === "process-test",
			)?.sse;
		await vi.waitFor(async () => {
			expect((await relayHealth())?.connected).toBe(true);
		});
		const cursor = browser.frames.length;
		const lostAt = Date.now();
		await fixture.closeOpenCodeStreams({ silenceReconnect: true });

		// Main emits no message during a quiet managed outage, so SSEStreamLive
		// keeps its last delivered connected=true health even after transport EOF.
		await vi.waitFor(
			async () => expect((await relayHealth())?.connected).toBe(false),
			{ timeout: 3_000, interval: 25 },
		);
		evidence["disconnectedLatencyMs"] = Date.now() - lostAt;
		evidence["relayHealth"] = await relayHealth();
		await vi.waitFor(
			() => {
				expect(
					fixture
						.opencodeStreamConnections()
						.filter(({ action }) => action === "open"),
				).toHaveLength(2);
			},
			{ timeout: 3_000, interval: 25 },
		);
		const lifecycle = browser.frames
			.slice(cursor)
			.map(({ message }) => message)
			.filter(
				(message) =>
					message["type"] === "project_setting" &&
					message["_tag"] === "opencodeConnection" &&
					message["instanceId"] === instanceId,
			);
		evidence["lifecycleAfterLoss"] = lifecycle;
		expect(lifecycle).toEqual([]);
		expect((await browser.instanceStatus(instanceId)).instance?.status).toBe(
			"healthy",
		);
		expect((await relayHealth())?.connected).toBe(false);
	}, 120_000);

	it("clears a retry-only shell indicator on managed stop while its persisted status stays idle", async () => {
		const fixture = await start("retry-only-stop");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Retry without busy",
			instanceId,
			"opencode",
		);
		await browser.followSessions();
		const persistedStatus = () => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return (
					db
						.prepare("SELECT status FROM sessions WHERE id = ?")
						.get(sessionId) as { status: string } | undefined
				)?.status;
			} finally {
				db.close();
			}
		};
		expect(persistedStatus()).toBe("idle");
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
			type: "retry",
			message: "Rate limit, waiting to retry",
			attempt: 1,
		});
		const retrying = await browser.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				message["retrying"] === "Rate limit, waiting to retry (attempt 1)",
		);
		evidence["beforeStop"] = retrying;
		evidence["persistedBeforeStop"] = persistedStatus();
		// No busy event was sent: retry lives in SessionRetries and the shell
		// decoration, while ingestion deliberately keeps it out of SQLite.
		expect(persistedStatus()).toBe("idle");
		expect(retrying["status"]).toBe("idle");
		const cursor = browser.frames.length;
		await browser.stopInstance(instanceId);
		expect((await browser.instanceStatus(instanceId)).instance.status).toBe(
			"stopped",
		);
		// Main never clears retry. A stop fix that scans only persisted busy or
		// retry rows also misses this session, leaving the live retry notice.
		await vi.waitFor(
			() => {
				const settled = browser.frames
					.slice(cursor)
					.map(({ message }) => message)
					.filter(
						(message) =>
							message["type"] === "session_row" && message["id"] === sessionId,
					)
					.at(-1);
				evidence["afterStop"] = settled;
				expect(settled).toEqual(
					expect.objectContaining({ id: sessionId, status: "idle" }),
				);
				expect(settled?.["retrying"]).toBeUndefined();
			},
			{ timeout: 3_000, interval: 25 },
		);
		evidence["persistedAfterStop"] = persistedStatus();
		expect(persistedStatus()).toBe("idle");
	}, 120_000);

	it("preserves a new busy turn after an immediate managed stop and start", async () => {
		const fixture = await start("stop-start-new-turn");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Restarted turn",
			instanceId,
			"opencode",
		);
		await browser.followSessions();
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
			type: "busy",
		});
		await browser.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				message["status"] === "busy",
		);
		// This fixture normally ends prompts immediately. Keep the new turn's
		// idle frame absent and serve busy so reconcile also sees active work.
		await fixture.dropOpenCodeEvents([
			{ type: "session.status", status: "idle" },
		]);
		// Fake REST statuses survive restarts. End the old provider turn without
		// delivering idle, leaving Conduit's busy row for stop settlement to clear.
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
			type: "idle",
		});
		const beforeStopDb = new Database(fixture.daemonStorePath(), {
			readonly: true,
		});
		try {
			const beforeStop = beforeStopDb
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId);
			evidence["beforeStop"] = beforeStop;
			expect(beforeStop).toEqual({ status: "busy" });
		} finally {
			beforeStopDb.close();
		}
		evidence["stopAt"] = Date.now();
		await browser.stopInstance(instanceId);
		// Do not wait for a settled shell row: old stop settlement must not
		// outlive the immediate restart and overwrite its next busy turn.
		await browser.startInstance(instanceId);
		evidence["startAt"] = Date.now();
		const cursor = browser.frames.length;
		const requestCursor = fixture.opencodeRequests().length;
		const inputId = randomUUID();
		evidence["newInputId"] = inputId;
		const admitted = await Effect.runPromise(
			browser.rpc.input.submit({
				sessionId,
				originId: browser.originId,
				inputId,
				delivery: "queue",
				text: "Keep the restarted OpenCode turn busy",
			}),
		);
		expect(admitted.ok).toBe(true);
		await vi.waitFor(
			() =>
				expect(
					fixture
						.opencodeRequests()
						.slice(requestCursor)
						.some(
							({ method, url }) =>
								method === "POST" &&
								url.split("?")[0] === `/session/${sessionId}/prompt_async`,
						),
				).toBe(true),
			{ timeout: 15_000, interval: 25 },
		);
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
			type: "busy",
		});
		const newBusy = await browser.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				message["status"] === "busy",
			cursor,
		);
		const newBusyCursor = browser.frames.findIndex(
			({ message }, index) => index >= cursor && message === newBusy,
		);
		evidence["newBusy"] = newBusy;
		// Cross the existing 7s status reconciliation interval so both delayed
		// stop work and the normal provider status read have time to publish.
		await new Promise<void>((done) => setTimeout(done, 7_500));
		const subsequentRows = browser.frames
			.slice(newBusyCursor + 1)
			.map(({ message }) => message)
			.filter(
				(message) =>
					message["type"] === "session_row" && message["id"] === sessionId,
			);
		evidence["rowsAfterNewBusy"] = subsequentRows;
		expect(subsequentRows.filter((row) => row["status"] !== "busy")).toEqual(
			[],
		);
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			const persisted = db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId) as { status: string } | undefined;
			evidence["persistedAfterNewBusy"] = persisted;
			expect(persisted?.status).toBe("busy");
		} finally {
			db.close();
		}
		expect((await browser.instanceStatus(instanceId)).instance.status).toBe(
			"healthy",
		);
	}, 120_000);

	it("settles stopped-instance busy rows, preserves user waits and unrelated sessions, and stops fallback warnings", async () => {
		const instanceId = "primary-test";
		const fixture = await start("managed-stop", true, instanceId);
		const browser = await fixture.connect();
		const busyId = await browser.createSession(
			"Viewed busy",
			instanceId,
			"opencode",
		);
		const permissionBrowser = await fixture.connect();
		const permissionId = await permissionBrowser.createSession(
			"Awaiting permission",
			instanceId,
			"opencode",
		);
		const questionBrowser = await fixture.connect();
		const questionId = await questionBrowser.createSession(
			"Awaiting question",
			instanceId,
			"opencode",
		);
		const retryBrowser = await fixture.connect();
		const retryId = await retryBrowser.createSession(
			"Retrying busy turn",
			instanceId,
			"opencode",
		);
		const unrelated = await fixture.connect();
		const otherInstanceId = await unrelated.createSession(
			"Other OpenCode instance",
			"managed-test",
			"opencode",
		);
		const claudeId = await unrelated.createSession(
			"Other driver",
			"claude",
			"claude",
		);
		const instances = Either.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		)?.instances?.map(({ id, port, pid, managed, driver }) => ({
			id,
			port,
			pid,
			managed,
			driver,
		}));
		evidence["instances"] = instances;
		const primary = instances?.find(({ id }) => id === instanceId);
		const secondary = instances?.find(({ id }) => id === "managed-test");
		expect(primary?.managed).toBe(true);
		expect(secondary?.managed).toBe(true);
		expect(primary?.port).toBeGreaterThan(0);
		expect(secondary?.port).toBeGreaterThan(0);
		expect(primary?.pid).toBeGreaterThan(0);
		expect(secondary?.pid).toBeGreaterThan(0);
		expect(primary?.port).not.toBe(secondary?.port);
		expect(primary?.pid).not.toBe(secondary?.pid);
		await browser.followSessions();
		await Effect.runPromise(
			unrelated.rpc.input.submit({
				sessionId: claudeId,
				originId: unrelated.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: "Hold this other driver's active turn",
			}),
		);
		for (const id of [busyId, retryId, permissionId, questionId]) {
			await fixture.setOpenCodeStatus(
				fixture.projectDir,
				id,
				{ type: "busy" },
				instanceId,
			);
		}
		await fixture.setOpenCodeStatus(
			fixture.projectDir,
			retryId,
			{
				type: "retry",
				message: "Waiting to retry stopped work",
				attempt: 1,
			},
			instanceId,
		);
		await retryBrowser.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === retryId &&
				message["retrying"] === "Waiting to retry stopped work (attempt 1)",
		);
		await fixture.setOpenCodeStatus(
			fixture.projectDir,
			otherInstanceId,
			{ type: "busy" },
			"managed-test",
		);
		await fixture.addOpenCodePrompt(
			"permission",
			fixture.projectDir,
			{
				id: "rqbc-4-permission",
				sessionID: permissionId,
				permission: "bash",
				patterns: ["echo stop"],
				metadata: {},
				always: [],
			},
			instanceId,
		);
		await permissionBrowser.waitFor(
			(message) =>
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
				"rqbc-4-permission",
		);
		await fixture.addOpenCodePrompt(
			"question",
			fixture.projectDir,
			{
				id: "rqbc-4-question",
				sessionID: questionId,
				questions: [
					{
						question: "Proceed?",
						header: "Proceed",
						options: [{ label: "Yes" }],
					},
				],
			},
			instanceId,
		);
		await questionBrowser.waitFor(
			(message) =>
				fixture.providerRequestIdForPrompt(String(message["toolId"])) ===
				"rqbc-4-question",
		);
		const ids = [
			busyId,
			retryId,
			permissionId,
			questionId,
			otherInstanceId,
			claudeId,
		];
		const sessionState = () => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return {
					statuses: Object.fromEntries(
						ids.map((id) => [
							id,
							(
								db
									.prepare("SELECT status FROM sessions WHERE id = ?")
									.get(id) as { status: string } | undefined
							)?.status,
						]),
					),
					approvals: db
						.prepare(
							"SELECT id, session_id, type, status FROM pending_approvals WHERE session_id IN (SELECT id FROM sessions WHERE project_id = 'process-test') ORDER BY id",
						)
						.all(),
				};
			} finally {
				db.close();
			}
		};
		await vi.waitFor(
			() => {
				expect(sessionState().statuses).toEqual(
					Object.fromEntries(ids.map((id) => [id, "busy"])),
				);
			},
			{ timeout: 15_000 },
		);
		const beforeStop = sessionState();
		expect(beforeStop.approvals).toHaveLength(2);
		expect(beforeStop.approvals).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					session_id: permissionId,
					type: "permission",
					status: "pending",
				}),
				expect.objectContaining({
					session_id: questionId,
					type: "question",
					status: "pending",
				}),
			]),
		);
		evidence["beforeStop"] = beforeStop;
		evidence["sessions"] = {
			busyId,
			retryId,
			permissionId,
			questionId,
			otherInstanceId,
			claudeId,
		};
		// Wait for an actual fallback timer, rather than confusing one failed
		// seed request with the repeating poll that causes the audit symptom.
		const pollCursor = fixture.opencodeRequests().length;
		await vi.waitFor(
			() => {
				const requests = fixture.opencodeRequests().slice(pollCursor);
				for (const id of [busyId, permissionId, questionId]) {
					expect(
						requests.filter(
							({ url }) => url.split("?")[0] === `/session/${id}/message`,
						).length,
					).toBeGreaterThanOrEqual(3);
				}
			},
			{ timeout: 30_000, interval: 100 },
		);
		const stopCursor = browser.frames.length;
		const pollerWarnings = () =>
			fixture.logTail
				.split("\n")
				.filter(
					(line) =>
						line.includes("poll failed:") ||
						line.includes("Failed to seed poller"),
				);
		expect(pollerWarnings()).toEqual([]);
		evidence["stopAt"] = Date.now();
		await browser.stopInstance(instanceId);
		expect((await browser.instanceStatus(instanceId)).instance.status).toBe(
			"stopped",
		);
		// Four 750ms fallback intervals expose repeated non-starting-client
		// warnings, including the sessions still awaiting user answers.
		await new Promise<void>((done) => setTimeout(done, 3_000));
		const afterStop = sessionState();
		const warnings = pollerWarnings();
		evidence["afterStop"] = afterStop;
		evidence["pollerWarningsAfterStop"] = warnings;
		evidence["rowsAfterStop"] = browser.frames
			.slice(stopCursor)
			.map(({ message }) => message)
			.filter(
				(message) =>
					message["type"] === "session_row" &&
					ids.includes(String(message["id"])),
			);
		// Stopping settles runtime status; pending prompts still hold user waits.
		expect.soft(afterStop.statuses).toEqual({
			[busyId]: "idle",
			[retryId]: "idle",
			[permissionId]: "idle",
			[questionId]: "idle",
			[otherInstanceId]: "busy",
			[claudeId]: "busy",
		});
		expect.soft(afterStop.approvals).toEqual(beforeStop.approvals);
		expect.soft(warnings).toEqual([]);
		expect
			.soft(browser.frames.slice(stopCursor).map(({ message }) => message))
			.toContainEqual(
				expect.objectContaining({
					type: "session_row",
					id: busyId,
					status: "idle",
				}),
			);
		const retryAfterStop = browser.frames
			.slice(stopCursor)
			.map(({ message }) => message)
			.filter(
				(message) =>
					message["type"] === "session_row" && message["id"] === retryId,
			)
			.at(-1);
		expect(retryAfterStop).toEqual(expect.objectContaining({ status: "idle" }));
		expect(retryAfterStop?.["retrying"]).toBeUndefined();
		expect(
			(await unrelated.instanceStatus("managed-test")).instance.status,
		).toBe("healthy");
	}, 120_000);

	it("refreshes the Settings instance subscription to stopped when restart allowance is exhausted", async () => {
		const snapshots: (readonly OpenCodeInstance[])[] = [];
		const result: Record<string, unknown> = {
			ticket: "conduit-test-rqbc.4",
			at: new Date().toISOString(),
		};
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* addInstance({
							id: "exhausted-opencode",
							name: "Exhausted OpenCode",
							port: 0,
							managed: true,
						});
						const state = yield* InstanceManagerStateTag;
						yield* Ref.update(state, (current) => ({
							...current,
							config: { ...current.config, maxRestartsPerWindow: 1 },
							instances: HashMap.modify(
								current.instances,
								"exhausted-opencode",
								(instance) => ({ ...instance, status: "unhealthy" as const }),
							),
						}));
						const handlers = yield* DaemonWsRpcHandlersTag;
						const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
							Effect.provide(
								makeRoutedWsRpcServerLayer(
									() => Effect.die("Unexpected project routing"),
									handlers,
								),
							),
						);
						yield* Effect.forkScoped(
							Stream.runForEach(
								client.SubscribeInstances({}),
								({ instances }) => Effect.sync(() => snapshots.push(instances)),
							),
						);
						yield* Effect.tryPromise(() =>
							vi.waitFor(() =>
								expect(snapshots.at(-1)).toContainEqual(
									expect.objectContaining({
										id: "exhausted-opencode",
										status: "unhealthy",
									}),
								),
							),
						);
						// The first scheduled attempt uses the injected allowance; the
						// second gives up before its existing 1s backoff can restart.
						expect(yield* scheduleRestart("exhausted-opencode")).toBeDefined();
						expect(
							yield* scheduleRestart("exhausted-opencode"),
						).toBeUndefined();
						const fresh = yield* client.GetInstances({});
						result["freshInstances"] = fresh.instances;
						expect(fresh.instances).toContainEqual(
							expect.objectContaining({
								id: "exhausted-opencode",
								status: "stopped",
							}),
						);
						// Main's give-up publishes only InstanceError, which does not
						// refresh SubscribeInstances: Settings retains unhealthy.
						yield* Effect.tryPromise(() =>
							vi.waitFor(
								() =>
									expect(snapshots.at(-1)).toContainEqual(
										expect.objectContaining({
											id: "exhausted-opencode",
											status: "stopped",
										}),
									),
								{ timeout: 3_000, interval: 25 },
							),
						);
					}),
				).pipe(Effect.provide(makeDaemonRpcTestLayer())),
			);
		} catch (error) {
			result["failure"] =
				error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/rqbc-4-restart-exhaustion.json",
				JSON.stringify(
					{ ...result, subscriptionSnapshots: snapshots },
					null,
					2,
				),
			);
		}
	});
});
