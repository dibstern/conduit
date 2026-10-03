import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	defaultDaemonConfig,
	loadDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

// Failure cases: duplicate warm requests, premature readiness, a synthetic
// prompt, lost first-send/approval events, initialization failure, a send racing
// initialization, lifecycle changes during shell capture or discovery, stale
// launch options, cancellation poisoning another session's shared catalog,
// named-instance config routing, and an unused query surviving shutdown.
function durableCounts(harness: ProcessHarness, sessionId: string) {
	const db = new Database(join(harness.projectDir, ".conduit/events.db"), {
		readonly: true,
	});
	try {
		return {
			status: db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId) as { status: string } | undefined,
			events: db
				.prepare(
					"SELECT type, COUNT(*) AS count FROM events WHERE session_id = ? GROUP BY type ORDER BY type",
				)
				.all(sessionId) as Array<{ type: string; count: number }>,
			commands: db
				.prepare(
					"SELECT status, COUNT(*) AS count FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' GROUP BY status",
				)
				.all(sessionId) as Array<{ status: string; count: number }>,
			models: db
				.prepare(
					"SELECT requested_model, expected_model, actual_model FROM turns WHERE session_id = ? ORDER BY requested_at",
				)
				.all(sessionId) as Array<{
				requested_model: string | null;
				expected_model: string | null;
				actual_model: string | null;
			}>,
		};
	} finally {
		db.close();
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("Claude session pre-warm through daemon RPC", () => {
	const harnesses: ProcessHarness[] = [];
	const evidence: unknown[] = [];
	const captures: Array<{
		markerPath: string;
		pids: number[];
		noQueryBeforeRelease: boolean;
		released: boolean;
		lifecycleAction?: "delete" | "cancel";
		warmOutcome?: "ready" | "cancelled";
		noRunnerAfterRelease?: boolean;
		probeWorkspace?: string;
		sessionDeletedBeforeRelease?: boolean;
		sessionCancelledBeforeRelease?: boolean;
		sendJoinedBeforeLifecycle?: boolean;
		firstQueryModel?: string;
		persistedModels?: ReturnType<typeof durableCounts>["models"];
		sharedProbeAttempts?: number;
	}> = [];
	afterEach(async (context) => {
		const cleanup: Array<{ pid: number; alive: boolean }> = [];
		try {
			for (const harness of harnesses) {
				await harness.dispose();
				const pids = new Set([
					...harness.generations.map((generation) => generation.pid),
					...captures.flatMap((capture) => capture.pids),
					...harness.marks.flatMap((mark) =>
						mark.kind === "runner-started" ? [mark.pid] : [],
					),
				]);
				try {
					await vi.waitFor(() => expect([...pids].some(alive)).toBe(false), {
						timeout: 5000,
					});
				} finally {
					cleanup.push(...[...pids].map((pid) => ({ pid, alive: alive(pid) })));
				}
				expect(existsSync(harness.root)).toBe(false);
			}
		} finally {
			evidence.push({
				name: context.task.name,
				assertionErrors:
					context.task.result?.errors?.map((error) => error.message) ?? [],
				harnesses: harnesses.map((harness) => harness.proof()),
				cleanup,
				captures: [...captures],
				allChildrenTerminated: cleanup.every((child) => !child.alive),
			});
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				process.env["CONDUIT_PREWARM_E2E_EVIDENCE"] ??
					"test-results/85kb-14-harness.json",
				JSON.stringify({ tests: evidence }, null, 2),
			);
			harnesses.length = 0;
			captures.length = 0;
		}
	});

	async function start(
		options: Parameters<typeof ProcessHarness.start>[0] = {},
	) {
		const harness = await ProcessHarness.start({
			...(process.env["CONDUIT_PREWARM_E2E_DIST"]
				? { dist: process.env["CONDUIT_PREWARM_E2E_DIST"] }
				: {}),
			...options,
		});
		harnesses.push(harness);
		return { harness, browser: await harness.connect() };
	}

	it("coalesces concurrent warm requests, waits for readiness, and reuses the query for the first streamed approval turn", async () => {
		const { harness, browser } = await start({
			queryInitializationDelayMs: 400,
			shellEnvProof: true,
		});
		const sessionId = await browser.createSession("Pre-warm query reuse");
		const before = durableCounts(harness, sessionId);
		const cursor = browser.frames.length;
		await Promise.all(
			Array.from({ length: 6 }, () => browser.preWarmSession(sessionId)),
		);
		await vi.waitFor(() =>
			expect(
				harness.marks.filter((mark) => mark.kind === "initialization-ready"),
			).toHaveLength(1),
		);
		const queries = harness.marks.filter((mark) => mark.kind === "query");
		expect(queries).toHaveLength(1);
		const query = queries[0];
		if (!query) throw new Error("Missing warm query");
		expect(query.env["CONDUIT_ENV_PROOF"]).toBe("server-cache");
		expect(query.env["PATH"]).toMatch(/^\/tmp\/conduit-cached-env-bin:/);
		expect(query.env["ANTHROPIC_API_KEY"]).toBeUndefined();
		expect(query.env["ANTHROPIC_MODEL"]).toBeUndefined();
		expect(query.env["CLAUDE_AGENT_SDK_CLIENT_APP"]).toBe("conduit");
		expect(query.env["ENABLE_CLAUDEAI_MCP_SERVERS"]).toBe("false");
		const ready = harness.marks.find(
			(mark) => mark.kind === "initialization-ready",
		);
		if (ready?.kind !== "initialization-ready")
			throw new Error("Missing SDK initialization barrier");
		expect(ready.queryId).toBe(query.queryId);
		expect(
			Number(BigInt(ready.at) - BigInt(query.at)) / 1e6,
		).toBeGreaterThanOrEqual(390);
		expect(
			harness.marks.filter((mark) => mark.kind === "runner-started"),
		).toHaveLength(1);
		expect(
			harness.marks.filter((mark) => mark.kind === "enqueue"),
		).toHaveLength(0);
		expect(
			harness.marks.filter((mark) => mark.kind === "system-init"),
		).toHaveLength(0);
		expect(durableCounts(harness, sessionId)).toEqual(before);
		expect(
			browser.frames
				.slice(cursor)
				.some(({ message }) =>
					["delta", "done", "permission_request"].includes(
						String(message["type"]),
					),
				),
		).toBe(false);
		const repeated = performance.now();
		await browser.preWarmSession(sessionId);
		expect(performance.now() - repeated).toBeLessThan(200);
		const sendCursor = browser.frames.length;
		const pending = browser.send(sessionId, "approval-prewarmed-first-send");
		const request = await browser.waitFor(
			(message) => message["type"] === "permission_request",
			sendCursor,
		);
		await browser.answerApproval(request, "allow");
		const result = await pending;
		expect(result.chunks).toEqual(
			responseChunks("approval-prewarmed-first-send"),
		);
		expect(result.done["code"]).toBe(0);
		await browser.waitFor(
			(message) =>
				message["type"] === "tool_result" &&
				message["content"] === "harness-approved",
			sendCursor,
		);
		await vi.waitFor(() =>
			expect(harness.marks.filter((mark) => mark.kind === "enqueue")).toEqual([
				expect.objectContaining({ queryId: query.queryId, promptIndex: 1 }),
			]),
		);
		expect(harness.marks.filter((mark) => mark.kind === "query")).toHaveLength(
			1,
		);
	});

	it("runs a cold first send in the default runner without a warm hint", async () => {
		const { harness, browser } = await start();
		const sessionId = await browser.createSession("Cold default runner");
		expect(harness.marks.filter((mark) => mark.kind === "query")).toHaveLength(
			0,
		);
		expect(
			harness.marks.filter((mark) => mark.kind === "runner-started"),
		).toHaveLength(0);
		const turn = await browser.send(sessionId, "cold-first-send");
		expect(turn.chunks).toEqual(responseChunks("cold-first-send"));
		expect(turn.done["code"]).toBe(0);
		await vi.waitFor(() =>
			expect(
				harness.marks.filter((mark) => mark.kind === "query"),
			).toHaveLength(1),
		);
		const runners = harness.marks.filter(
			(mark) => mark.kind === "runner-started",
		);
		expect(runners).toHaveLength(1);
		const query = harness.marks.find((mark) => mark.kind === "query");
		expect(query?.kind === "query" && query.pid).toBe(runners[0]?.pid);
		expect(runners[0]?.pid).not.toBe(harness.generations[0]?.pid);
	});

	it("waits for pending shell environment capture before booting and reuses the resolved query", async () => {
		const { harness, browser } = await start({
			shellEnvProof: true,
		});
		const sessionId = await browser.createSession("Pending shell capture");
		const markerPath = join(harness.root, "home/environment-capture-started");
		const releasePath = join(harness.root, "home/environment-capture-release");
		const capture = {
			markerPath,
			pids: [] as number[],
			noQueryBeforeRelease: false,
			released: false,
		};
		captures.push(capture);
		let warm: Promise<{ error?: unknown }> | undefined;
		let ready = false;
		try {
			writeFileSync(
				join(harness.root, "home/.zprofile"),
				[
					'printf "%s\\n" "$$" >> "$HOME/environment-capture-started"',
					'while [ ! -f "$HOME/environment-capture-release" ]; do /bin/sleep 0.01; done',
					"export CONDUIT_ENV_PROOF=resolved-after-warm",
					"export ANTHROPIC_API_KEY=must-remove",
					"export ANTHROPIC_MODEL=must-remove",
					'export PATH="/tmp/conduit-cached-env-bin:$PATH"',
					"",
				].join("\n"),
			);
			await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true), {
				timeout: 3000,
			});
			warm = browser.preWarmSession(sessionId).then(
				() => {
					ready = true;
					return {};
				},
				(error: unknown) => ({ error }),
			);
			// The old path completes runner boot while the capture remains gated.
			// Observe completion/query marks, with a bound below capture's 5s timeout.
			const deadline = Date.now() + 2000;
			while (
				!ready &&
				!harness.marks.some((mark) => mark.kind === "query") &&
				Date.now() < deadline
			)
				await new Promise<void>((done) => setTimeout(done, 10));
			capture.noQueryBeforeRelease = !harness.marks.some(
				(mark) => mark.kind === "query",
			);
			expect(capture.noQueryBeforeRelease).toBe(true);
			expect(ready).toBe(false);
			writeFileSync(releasePath, "release");
			capture.released = true;
			expect((await warm).error).toBeUndefined();
			await vi.waitFor(() =>
				expect(
					harness.marks.filter((mark) => mark.kind === "query"),
				).toHaveLength(1),
			);
			const query = harness.marks.find((mark) => mark.kind === "query");
			if (query?.kind !== "query")
				throw new Error("Missing resolved-environment query");
			expect(query.env["CONDUIT_ENV_PROOF"]).toBe("resolved-after-warm");
			expect(query.env["ANTHROPIC_API_KEY"]).toBeUndefined();
			expect(query.env["ANTHROPIC_MODEL"]).toBeUndefined();
			expect(
				harness.marks.filter((mark) => mark.kind === "enqueue"),
			).toHaveLength(0);
			expect(
				(await browser.send(sessionId, "first-send-after-shell-ready")).chunks,
			).toEqual(responseChunks("first-send-after-shell-ready"));
			expect(
				harness.marks.filter((mark) => mark.kind === "query"),
			).toHaveLength(1);
			expect(
				harness.marks.find((mark) => mark.kind === "enqueue"),
			).toMatchObject({ queryId: query.queryId, promptIndex: 1 });
		} finally {
			writeFileSync(releasePath, "release");
			capture.released = true;
			await warm;
			if (existsSync(markerPath))
				capture.pids = readFileSync(markerPath, "utf8")
					.trim()
					.split("\n")
					.map(Number);
		}
	});

	it.each([
		"delete",
		"cancel",
	] as const)("discards a warm waiting for shell capture when the session receives %s", async (lifecycleAction) => {
		const { harness, browser } = await start({
			shellEnvProof: true,
		});
		const sessionId = await browser.createSession(
			`Shell capture ${lifecycleAction}`,
		);
		const markerPath = join(harness.root, "home/environment-capture-started");
		const releasePath = join(harness.root, "home/environment-capture-release");
		const capture: (typeof captures)[number] = {
			markerPath,
			pids: [],
			noQueryBeforeRelease: false,
			released: false,
			lifecycleAction,
		};
		captures.push(capture);
		let warm: Promise<void> | undefined;
		let warmSettled = false;
		try {
			writeFileSync(
				join(harness.root, "home/.zprofile"),
				[
					'printf "%s\\n" "$$" >> "$HOME/environment-capture-started"',
					'while [ ! -f "$HOME/environment-capture-release" ]; do /bin/sleep 0.01; done',
					"export CONDUIT_ENV_PROOF=resolved-after-cancel",
					"export ANTHROPIC_API_KEY=must-remove",
					"export ANTHROPIC_MODEL=must-remove",
					'export PATH="/tmp/conduit-cached-env-bin:$PATH"',
					"",
				].join("\n"),
			);
			await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true), {
				timeout: 3000,
			});
			capture.pids = readFileSync(markerPath, "utf8")
				.trim()
				.split("\n")
				.map(Number);
			warm = browser.preWarmSession(sessionId).then(
				() => {
					capture.warmOutcome = "ready";
					warmSettled = true;
				},
				(error: unknown) => {
					capture.warmOutcome = "cancelled";
					warmSettled = true;
					expect(String(error)).not.toMatch(/Timed out|timeout/i);
				},
			);
			await new Promise<void>((done) => setTimeout(done, 200));
			capture.noQueryBeforeRelease = !harness.marks.some(
				(mark) => mark.kind === "query",
			);
			expect(capture.noQueryBeforeRelease).toBe(true);
			expect(warmSettled).toBe(false);
			if (lifecycleAction === "delete") await browser.deleteSession(sessionId);
			else
				await Effect.runPromise(
					browser.rpc
						.CancelSession({
							projectSlug: "process-test",
							sessionId,
							commandId: randomUUID(),
						})
						.pipe(Effect.timeout("3 seconds")),
				);
			writeFileSync(releasePath, "release");
			capture.released = true;
			await vi.waitFor(
				() => {
					expect(warmSettled).toBe(true);
					expect(capture.pids.some(alive)).toBe(false);
				},
				{ timeout: 3000 },
			);
			await warm;
			capture.noRunnerAfterRelease = !harness.marks.some(
				(mark) => mark.kind === "runner-started" || mark.kind === "query",
			);
			expect(capture.noRunnerAfterRelease).toBe(true);
			expect(
				harness.marks.filter((mark) => mark.kind === "enqueue"),
			).toHaveLength(0);
			const counts = durableCounts(harness, sessionId);
			expect(counts.commands).toEqual([]);
			if (lifecycleAction === "delete") expect(counts.status).toBeUndefined();
			else {
				expect(counts.status).toMatchObject({ status: "idle" });
				expect(
					(await browser.send(sessionId, "send-after-capture-cancel")).chunks,
				).toEqual(responseChunks("send-after-capture-cancel"));
				expect(
					harness.marks.filter((mark) => mark.kind === "query"),
				).toHaveLength(1);
				const query = harness.marks.find((mark) => mark.kind === "query");
				if (query?.kind !== "query")
					throw new Error("Missing post-cancel query");
				expect(query.env["CONDUIT_ENV_PROOF"]).toBe("resolved-after-cancel");
				expect(query.env["ANTHROPIC_API_KEY"]).toBeUndefined();
				expect(query.env["ANTHROPIC_MODEL"]).toBeUndefined();
			}
		} finally {
			writeFileSync(releasePath, "release");
			capture.released = true;
			await warm;
			if (existsSync(markerPath))
				capture.pids = readFileSync(markerPath, "utf8")
					.trim()
					.split("\n")
					.map(Number);
		}
	});

	it.each([
		"delete",
		"cancel",
	] as const)("does not warm a session receiving %s during provider discovery", async (lifecycleAction) => {
		const { harness, browser } = await start({
			blockCapabilitiesProbe: true,
		});
		const markerPath = join(harness.root, "capabilities-probe-started");
		const releasePath = join(harness.root, "capabilities-probe-release");
		const capture: (typeof captures)[number] = {
			markerPath,
			pids: [],
			noQueryBeforeRelease: false,
			released: false,
			lifecycleAction,
		};
		captures.push(capture);
		let warm: Promise<{ error?: unknown }> | undefined;
		let warmSettled = false;
		try {
			const sessionId = await browser.createSession(
				`${lifecycleAction} during discovery`,
			);
			warm = browser.preWarmSession(sessionId).then(
				() => {
					capture.warmOutcome = "ready";
					warmSettled = true;
					return {};
				},
				(error: unknown) => {
					capture.warmOutcome = "cancelled";
					warmSettled = true;
					return { error };
				},
			);
			await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true), {
				timeout: 3000,
			});
			capture.probeWorkspace = readFileSync(markerPath, "utf8");
			expect(capture.probeWorkspace).toBe(harness.projectDir);
			expect(existsSync(releasePath)).toBe(false);
			await new Promise<void>((done) => setTimeout(done, 200));
			capture.noQueryBeforeRelease = !harness.marks.some(
				(mark) => mark.kind === "query",
			);
			expect(capture.noQueryBeforeRelease).toBe(true);
			expect(warmSettled).toBe(false);
			if (lifecycleAction === "delete") {
				await browser.deleteSession(sessionId);
				capture.sessionDeletedBeforeRelease =
					durableCounts(harness, sessionId).status === undefined;
				expect(capture.sessionDeletedBeforeRelease).toBe(true);
			} else {
				await Effect.runPromise(
					browser.rpc
						.CancelSession({
							projectSlug: "process-test",
							sessionId,
							commandId: randomUUID(),
						})
						.pipe(Effect.timeout("3 seconds")),
				);
				capture.sessionCancelledBeforeRelease =
					durableCounts(harness, sessionId).status?.status === "idle";
				expect(capture.sessionCancelledBeforeRelease).toBe(true);
				await Effect.runPromise(
					browser.rpc
						.SetClaudeSettings({
							projectSlug: "process-test",
							overrides: { disableAllHooks: true },
							originId: browser.originId,
						})
						.pipe(Effect.timeout("3 seconds")),
				);
			}
			expect(existsSync(releasePath)).toBe(false);
			writeFileSync(releasePath, "release");
			capture.released = true;
			const outcome = await warm;
			capture.noRunnerAfterRelease = !harness.marks.some(
				(mark) => mark.kind === "runner-started" || mark.kind === "query",
			);
			expect(capture.noRunnerAfterRelease).toBe(true);
			expect(capture.warmOutcome).toBe("cancelled");
			expect(String(outcome.error)).not.toMatch(/Timed out|timeout/i);
			expect(
				harness.marks.filter((mark) => mark.kind === "enqueue"),
			).toHaveLength(0);
			expect(durableCounts(harness, sessionId).commands).toEqual([]);
			if (lifecycleAction === "cancel") {
				expect(
					(await browser.send(sessionId, "send-after-discovery-cancel")).chunks,
				).toEqual(responseChunks("send-after-discovery-cancel"));
				expect(
					harness.marks.filter((mark) => mark.kind === "query"),
				).toHaveLength(1);
				const query = harness.marks.find((mark) => mark.kind === "query");
				if (query?.kind !== "query")
					throw new Error("Missing query after discovery cancellation");
				expect(query.options).toMatchObject({
					model: "opus",
					settings: { disableAllHooks: true },
				});
				expect(
					harness.marks.find((mark) => mark.kind === "enqueue"),
				).toMatchObject({ queryId: query.queryId, promptIndex: 1 });
			}
		} finally {
			writeFileSync(releasePath, "release");
			capture.released = true;
			await warm;
		}
	});

	it.each([
		"delete",
		"cancel",
	] as const)("preserves the live catalog for a first send when another session's pre-warm receives %s", async (lifecycleAction) => {
		const { harness, browser } = await start({
			blockCapabilitiesProbe: true,
			capabilityModels: [
				{
					id: "claude-opus-4",
					name: "Review Opus default",
					providerId: "claude",
				},
				{ id: "sonnet", name: "Review Sonnet", providerId: "claude" },
			],
		});
		const warmSessionId = await browser.createSession("Shared probe owner");
		const sendSessionId = await browser.createSession(
			"Shared probe first send",
		);
		const markerPath = join(harness.root, "capabilities-probe-started");
		const releasePath = join(harness.root, "capabilities-probe-release");
		const ownerPath = join(harness.root, "capabilities-consumer-1.json");
		const joinedPath = join(harness.root, "capabilities-consumer-2.json");
		const capture: (typeof captures)[number] = {
			markerPath,
			pids: [],
			noQueryBeforeRelease: false,
			released: false,
			lifecycleAction,
		};
		captures.push(capture);
		const warm = browser.preWarmSession(warmSessionId).then(
			() => {
				capture.warmOutcome = "ready";
			},
			() => {
				capture.warmOutcome = "cancelled";
			},
		);
		let pending: ReturnType<typeof browser.send> | undefined;
		try {
			await vi.waitFor(() => expect(existsSync(ownerPath)).toBe(true));
			expect(JSON.parse(readFileSync(ownerPath, "utf8"))).toEqual({
				workspaceRoot: harness.projectDir,
				status: "Suspended",
			});
			expect(existsSync(markerPath)).toBe(true);
			expect(existsSync(joinedPath)).toBe(false);
			pending = browser.send(sendSessionId, "first-send-sharing-warm-catalog");
			await vi.waitFor(() => expect(existsSync(joinedPath)).toBe(true));
			expect(JSON.parse(readFileSync(joinedPath, "utf8"))).toEqual({
				workspaceRoot: harness.projectDir,
				status: "Suspended",
			});
			capture.sendJoinedBeforeLifecycle = true;
			expect(
				JSON.parse(
					readFileSync(
						join(harness.root, "capabilities-probe-attempts.json"),
						"utf8",
					),
				),
			).toEqual({ count: 1, workspaceRoot: harness.projectDir });
			capture.noQueryBeforeRelease = !harness.marks.some(
				(mark) => mark.kind === "query",
			);
			expect(capture.noQueryBeforeRelease).toBe(true);
			expect(existsSync(releasePath)).toBe(false);
			if (lifecycleAction === "delete")
				await browser.deleteSession(warmSessionId);
			else
				await Effect.runPromise(
					browser.rpc
						.CancelSession({
							projectSlug: "process-test",
							sessionId: warmSessionId,
							commandId: randomUUID(),
						})
						.pipe(Effect.timeout("3 seconds")),
				);
			await warm;
			expect(capture.warmOutcome).toBe("cancelled");
			writeFileSync(releasePath, "release");
			capture.released = true;
			const result = await pending;
			expect(result.chunks).toEqual(
				responseChunks("first-send-sharing-warm-catalog"),
			);
			expect(result.done["code"]).toBe(0);
			await vi.waitFor(() =>
				expect(
					harness.marks.filter((mark) => mark.kind === "query"),
				).toHaveLength(1),
			);
			const query = harness.marks.find((mark) => mark.kind === "query");
			if (query?.kind !== "query") throw new Error("Missing first-send query");
			if (query.options.model !== undefined)
				capture.firstQueryModel = query.options.model;
			capture.persistedModels = durableCounts(harness, sendSessionId).models;
			capture.sharedProbeAttempts = JSON.parse(
				readFileSync(
					join(harness.root, "capabilities-probe-attempts.json"),
					"utf8",
				),
			).count;
			expect(query.options.model).toBe("claude-opus-4");
			expect(capture.sharedProbeAttempts).toBe(1);
			expect(capture.persistedModels).toEqual([
				expect.objectContaining({ requested_model: "claude-opus-4" }),
			]);
			expect(
				harness.marks.filter((mark) => mark.kind === "runner-started"),
			).toHaveLength(1);
			expect(harness.marks.filter((mark) => mark.kind === "enqueue")).toEqual([
				expect.objectContaining({ queryId: query.queryId, promptIndex: 1 }),
			]);
			const catalog = await Effect.runPromise(
				browser.rpc.GetModels({
					projectSlug: "process-test",
					sessionId: sendSessionId,
					instanceId: "claude",
				}),
			);
			expect(
				catalog.providers.find((provider) => provider.id === "claude")
					?.models[0],
			).toMatchObject({
				id: "claude-opus-4",
				name: "Review Opus default",
			});
		} finally {
			writeFileSync(releasePath, "release");
			capture.released = true;
			await warm;
			await pending?.catch(() => undefined);
		}
	});

	it("pre-warms a named Claude instance with its configured directory and reuses that query for the first send", async () => {
		const { harness, browser } = await start({});
		const configDir = join(harness.root, "work-claude");
		mkdirSync(configDir);
		const added = await Effect.runPromise(
			browser.rpc.AddInstance({
				projectSlug: "process-test",
				name: "work-claude",
				driver: "claude",
				managed: false,
				configDir,
			}),
		);
		if (!added.addedInstanceId)
			throw new Error("Missing named Claude instance");
		// The relay's instance facade does not persist foreground daemon config.
		// Seed only the harness's config file so routing resolves the named id.
		writeFileSync(
			join(harness.root, "config/daemon.json"),
			JSON.stringify({
				...(loadDaemonConfig(join(harness.root, "config")) ??
					defaultDaemonConfig()),
				port: harness.generations.at(-1)?.port ?? 0,
				instances: added.instances,
			}),
		);
		const sessionId = await browser.createSession(
			"Named instance pre-warm",
			added.addedInstanceId,
		);
		await browser.preWarmSession(sessionId);
		await vi.waitFor(() =>
			expect(
				harness.marks.filter((mark) => mark.kind === "query"),
			).toHaveLength(1),
		);
		const query = harness.marks.find((mark) => mark.kind === "query");
		if (query?.kind !== "query")
			throw new Error("Missing named-instance warm query");
		expect(query.env["CLAUDE_CONFIG_DIR"]).toBe(configDir);
		expect(
			harness.marks.filter((mark) => mark.kind === "runner-started"),
		).toHaveLength(1);
		expect(
			harness.marks.filter((mark) => mark.kind === "enqueue"),
		).toHaveLength(0);
		expect(
			(await browser.send(sessionId, "named-instance-first-send")).chunks,
		).toEqual(responseChunks("named-instance-first-send"));
		expect(harness.marks.filter((mark) => mark.kind === "query")).toHaveLength(
			1,
		);
		expect(harness.marks.filter((mark) => mark.kind === "enqueue")).toEqual([
			expect.objectContaining({ queryId: query.queryId, promptIndex: 1 }),
		]);
	});

	it("settles a first send interrupted while initialization is pending and allows the next send", async () => {
		const { harness, browser } = await start({
			queryInitializationDelayMs: 1000,
		});
		const sessionId = await browser.createSession("Cancel pending pre-warm");
		const warm = browser.preWarmSession(sessionId).then(
			() => "ready" as const,
			() => "cancelled" as const,
		);
		await vi.waitFor(
			() =>
				expect(
					harness.marks.filter((mark) => mark.kind === "query"),
				).toHaveLength(1),
			{ timeout: 5000 },
		);
		const pending = browser
			.send(sessionId, "cancel-before-initialization")
			.then(
				(response) => ({ response }),
				(error: unknown) => ({ error }),
			);
		await vi.waitFor(() =>
			expect(
				harness.marks.some(
					(mark) => mark.kind === "runner-command" && mark.type === "send-turn",
				),
			).toBe(true),
		);
		expect(
			harness.marks.filter((mark) => mark.kind === "initialization-ready"),
		).toHaveLength(0);
		await Effect.runPromise(
			browser.rpc.CancelSession({
				projectSlug: "process-test",
				sessionId,
				commandId: randomUUID(),
			}),
		);
		const outcome = await pending;
		if ("response" in outcome) expect(outcome.response.chunks).toEqual([]);
		else expect(String(outcome.error)).not.toMatch(/Timed out|timeout/i);
		expect(await warm).toBe("cancelled");
		await vi.waitFor(
			() => {
				expect(
					harness.marks.filter((mark) => mark.kind === "query-closed"),
				).toHaveLength(1);
				expect(
					harness.marks.filter((mark) => mark.kind === "enqueue"),
				).toHaveLength(0);
				const counts = durableCounts(harness, sessionId);
				expect(counts.status, JSON.stringify(counts)).toMatchObject({
					status: "idle",
				});
				expect(counts.commands).toEqual([{ status: "failed", count: 1 }]);
			},
			{ timeout: 5000 },
		);
		expect(
			(await browser.send(sessionId, "send-after-cancelled-warm")).chunks,
		).toEqual(responseChunks("send-after-cancelled-warm"));
		expect(harness.marks.filter((mark) => mark.kind === "query")).toHaveLength(
			2,
		);
	});

	it.each([
		0, 1,
	])("preserves a send racing slow initialization with %s initialization failures", async (queryInitializationFailures) => {
		const { harness, browser } = await start({
			queryInitializationDelayMs: 500,
			queryInitializationFailures,
		});
		const sessionId = await browser.createSession("Send racing initialization");
		const warm = browser.preWarmSession(sessionId).then(
			() => "ready" as const,
			() => "failed" as const,
		);
		await vi.waitFor(
			() =>
				expect(
					harness.marks.filter((mark) => mark.kind === "query"),
				).toHaveLength(1),
			{ timeout: 5000 },
		);
		expect(
			harness.marks.filter((mark) => mark.kind === "enqueue"),
		).toHaveLength(0);
		expect(
			harness.marks.filter((mark) => mark.kind === "initialization-ready"),
		).toHaveLength(0);
		const result = await browser.send(sessionId, "racing-first-send");
		expect(result.chunks).toEqual(responseChunks("racing-first-send"));
		expect(result.done["code"]).toBe(0);
		expect(await warm).toBe(
			queryInitializationFailures === 0 ? "ready" : "failed",
		);
		await vi.waitFor(() =>
			expect(
				harness.marks.filter((mark) => mark.kind === "query"),
			).toHaveLength(queryInitializationFailures + 1),
		);
		const enqueue = harness.marks.find((mark) => mark.kind === "enqueue");
		if (enqueue?.kind !== "enqueue")
			throw new Error("Missing first-send enqueue");
		expect(
			harness.marks.filter((mark) => mark.kind === "enqueue"),
		).toHaveLength(1);
		const ready = harness.marks.find(
			(mark) =>
				mark.kind === "initialization-ready" &&
				mark.queryId === enqueue.queryId,
		);
		if (ready?.kind !== "initialization-ready")
			throw new Error("Send used an uninitialized query");
		expect(BigInt(enqueue.at) >= BigInt(ready.at)).toBe(true);
		if (queryInitializationFailures > 0) {
			expect(
				harness.marks.filter((mark) => mark.kind === "initialization-failed"),
			).toHaveLength(1);
			expect(
				harness.marks.some(
					(mark) =>
						mark.kind === "query-closed" && mark.queryId !== enqueue.queryId,
				),
			).toBe(true);
		}
	});

	it.each([
		"model",
		"effort",
		"permission",
		"settings",
		"inherited settings",
	] as const)("starts a fresh query when %s changes before the first send", async (changed) => {
		const { harness, browser } = await start({});
		const sessionId = await browser.createSession(`Changed ${changed}`);
		await browser.preWarmSession(sessionId);
		await vi.waitFor(() =>
			expect(
				harness.marks.filter((mark) => mark.kind === "query"),
			).toHaveLength(1),
		);
		const warmed = harness.marks.find((mark) => mark.kind === "query");
		if (warmed?.kind !== "query") throw new Error("Missing warmed query");
		const payload = {
			projectSlug: "process-test",
			sessionId,
			originId: browser.originId,
		};
		if (changed === "model")
			await Effect.runPromise(
				browser.rpc.SwitchModel({
					...payload,
					providerId: "claude",
					modelId: "claude-opus-4",
				}),
			);
		else if (changed === "effort")
			await Effect.runPromise(
				browser.rpc.SwitchVariant({ ...payload, variant: "high" }),
			);
		else if (changed === "permission")
			await Effect.runPromise(
				browser.rpc.SwitchPermissionMode({ ...payload, mode: "full" }),
			);
		else if (changed === "inherited settings")
			writeFileSync(
				join(harness.root, "claude/settings.json"),
				JSON.stringify({ disableAllHooks: true }),
			);
		else
			await Effect.runPromise(
				browser.rpc.SetClaudeSettings({
					projectSlug: "process-test",
					overrides: { disableAllHooks: true },
					originId: browser.originId,
				}),
			);
		const prompt = `first-send-after-${changed}-change`;
		expect((await browser.send(sessionId, prompt)).chunks).toEqual(
			responseChunks(prompt),
		);
		await vi.waitFor(() =>
			expect(
				harness.marks.filter((mark) => mark.kind === "query"),
			).toHaveLength(2),
		);
		const fresh = harness.marks.filter((mark) => mark.kind === "query").at(-1);
		if (!fresh) throw new Error("Missing replacement query");
		expect(fresh.queryId).not.toBe(warmed.queryId);
		expect(
			harness.marks.some(
				(mark) =>
					mark.kind === "query-closed" && mark.queryId === warmed.queryId,
			),
		).toBe(true);
		const expected =
			changed === "model"
				? { model: "claude-opus-4" }
				: changed === "effort"
					? { effort: "high" }
					: changed === "permission"
						? { permissionMode: "bypassPermissions" }
						: { settings: { disableAllHooks: true } };
		if (changed !== "inherited settings")
			expect(fresh.options).toMatchObject(expected);
		expect(harness.marks.find((mark) => mark.kind === "enqueue")).toMatchObject(
			{ queryId: fresh.queryId },
		);
	});

	it("closes an unused initialized query and runner on server shutdown", async () => {
		const { harness, browser } = await start({});
		const sessionId = await browser.createSession("Unused pre-warm shutdown");
		await browser.preWarmSession(sessionId);
		await vi.waitFor(() =>
			expect(
				harness.marks.filter((mark) => mark.kind === "initialization-ready"),
			).toHaveLength(1),
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing unused runner");
		expect(
			harness.marks.filter((mark) => mark.kind === "enqueue"),
		).toHaveLength(0);
		await browser.shutdown();
		await vi.waitFor(
			() => {
				expect(alive(runner.pid)).toBe(false);
				expect(existsSync(runner.socketPath)).toBe(false);
				expect(
					harness.marks.filter((mark) => mark.kind === "query-closed"),
				).toHaveLength(1);
			},
			{ timeout: 15_000 },
		);
	});
});
