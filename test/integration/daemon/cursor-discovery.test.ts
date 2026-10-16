// Failure modes: discovery leaks a credential, a failed probe breaks other
// drivers, a stale catalog survives refresh, or a selectable Cursor turn runs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	AddInstance,
	CreateSession,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { ProviderInfo } from "../../../src/lib/shared-types.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

const scenarios = [
	{ name: "available", reason: undefined },
	{ name: "model-list-failed", reason: "Cursor model list failed" },
	{
		name: "no-credential",
		reason:
			"Cursor has no credential; set CURSOR_API_KEY or log in with the Cursor SDK",
	},
	{ name: "sdk-load-failed", reason: "Cursor SDK could not load" },
	{ name: "node-old", reason: "Cursor requires Node.js 22.13 or newer" },
	{ name: "sqlite-missing", reason: "Cursor requires node:sqlite" },
	{
		name: "helper-missing",
		reason: `Cursor platform helper is missing: @cursor/sdk-${process.platform}-${process.arch}/bin/cursorsandbox${process.platform === "win32" ? ".exe" : ""}`,
	},
] as const;

describe("Cursor discovery through the built daemon and SDK trace port", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	const results: Record<string, unknown>[] = [];

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			await fixture.dispose();
		} finally {
			const proof = fixture.proof();
			results.push({
				...evidence,
				result: task.result?.state,
				failures: task.result?.errors?.map(({ message }) => message) ?? [],
				process: {
					buildIdentity: proof.buildIdentity,
					disposed: proof.disposed,
					generations: proof.generations.map(({ pid, exitCode, signal }) => ({
						pid,
						exitCode,
						signal,
					})),
					remainingRunnerPids: fixture.remainingRunnerPids(),
					remainingOpenCodePids: proof.remainingObservedOpenCodePids,
					rpcDecodeFailures: proof.rpcDecodeFailures,
					configReadErrors: proof.configReadErrors,
					...(task.result?.errors?.length ? { logTail: proof.logTail } : {}),
				},
			});
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/conduit-test-xqsg.22.json",
				`${JSON.stringify({ ticket: "conduit-test-xqsg.22", scenarios: results }, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	for (const scenario of scenarios) {
		it(scenario.name, async () => {
			evidence = { scenario: scenario.name };
			harness = ProcessHarness.create({
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
				opencodeRecording: "chat-simple",
			});
			const fixture = harness;
			const seedRows = readFileSync(
				resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"),
				"utf8",
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind?: string; data?: unknown });
			const capturedModels = seedRows.find(
				({ kind }) => kind === "models.list",
			);
			if (!capturedModels)
				throw new Error("Basic capture has no model catalog");
			const runtimeFailure = ![
				"available",
				"model-list-failed",
				"no-credential",
			].includes(scenario.name);
			const tracePath = join(fixture.root, "cursor-discovery.jsonl");
			const capturePath = join(fixture.root, "cursor-tee.jsonl");
			const rows = [
				{
					scenario: scenario.name,
					model: "composer-2.5",
					sdkVersion: "1.0.37",
					recordedAt: new Date().toISOString(),
				},
				{
					kind: "runtime.probe",
					data: runtimeFailure
						? { available: false, reason: scenario.reason }
						: { available: true },
				},
				{
					kind: "credential.store",
					data:
						scenario.name === "no-credential"
							? null
							: {
									apiKey: "[REDACTED]",
									backendUrl: "https://api2.cursor.sh",
									createdAtMs: 0,
								},
				},
				{ kind: "auth.status", data: { status: "logged-in" } },
				...(scenario.name === "model-list-failed"
					? [
							{
								kind: "models.list.error",
								data: { message: "captured catalog failure" },
							},
						]
					: [capturedModels]),
			];
			writeFileSync(
				tracePath,
				`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
			);
			await fixture.restart({
				startupTimeoutMs: 60_000,
				runnerStartupTimeoutMs: 60_000,
				serviceEnvironment: {
					CONDUIT_CURSOR_SDK_TRACE: tracePath,
					CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
				},
			});
			const added = await fixture.requestRpc(
				new AddInstance({ name: "Cursor", driver: "cursor" }),
			);
			const accountId = added.addedInstanceId;
			if (!accountId) throw new Error("Missing Cursor account");
			const browser = await fixture.connect();
			const discovery = await browser.instances();
			const cursor = discovery.instances.find(({ id }) => id === accountId);
			evidence["discovery"] = cursor;
			expect(cursor).toMatchObject({
				driver: "cursor",
				available: scenario.reason === undefined,
			});
			if (scenario.reason)
				expect(cursor?.unavailableReason).toBe(scenario.reason);

			const catalogCursor = browser.frames.length;
			await browser.getModels(accountId);
			let cursorModels: ProviderInfo["models"] = [];
			if (scenario.reason === undefined) {
				const catalog = await browser.waitFor(
					(message) =>
						message["type"] === "project_setting" &&
						message["_tag"] === "providerModels" &&
						message["accountId"] === accountId,
					catalogCursor,
				);
				const providers = catalog["providers"] as ProviderInfo[];
				cursorModels =
					providers.find(({ id }) => id === "cursor")?.models ?? [];
				expect(cursorModels).toHaveLength(47);
				expect(
					cursorModels.find(({ id }) => id === "composer-2.5"),
				).toMatchObject({ name: "Composer 2.5", provider: "cursor" });
				const sessionId = await browser.createSession(
					"Cursor selected",
					accountId,
					"cursor",
					{ modelId: "composer-2.5", contextWindow: "" },
				);
				const failed = await browser.send(
					sessionId,
					"not implemented yet",
					90_000,
				);
				expect(failed.done["status"]).toBe("idle");
				const db = new Database(fixture.projectStorePath(), { readonly: true });
				try {
					const turn = db
						.prepare<[string], { state: string }>(
							"SELECT state FROM turns WHERE session_id = ?",
						)
						.get(sessionId);
					expect(turn?.state).toBe("error");
					const errors = db
						.prepare<[string], { data: string }>(
							"SELECT data FROM events WHERE session_id = ? AND type = 'turn.error'",
						)
						.all(sessionId);
					expect(errors).toHaveLength(1);
					expect(errors[0]?.data).toContain(
						"Cursor turn preparation not installed",
					);
					evidence["cursorTurn"] = turn?.state;
				} finally {
					db.close();
				}
				// A fresh failed response must evict the old catalog and change the
				// rail's availability; restoring the trace must recover both.
				writeFileSync(
					tracePath,
					`${[...rows.slice(0, -1), { kind: "models.list.error", data: { message: "catalog refresh failed" } }].map((row) => JSON.stringify(row)).join("\n")}\n`,
				);
				const refreshCursor = browser.frames.length;
				await browser.getModels(accountId);
				const cleared = await browser.waitFor(
					(message) =>
						message["type"] === "project_setting" &&
						message["_tag"] === "providerModels" &&
						message["accountId"] === accountId &&
						(message["providers"] as ProviderInfo[]).length === 0,
					refreshCursor,
				);
				expect(cleared["providers"]).toEqual([]);
				expect(
					(await browser.instances()).instances.find(
						({ id }) => id === accountId,
					),
				).toMatchObject({
					available: false,
					unavailableReason: "Cursor model list failed",
				});
				writeFileSync(
					tracePath,
					`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
				);
				expect(
					(await browser.instances()).instances.find(
						({ id }) => id === accountId,
					),
				).toMatchObject({ available: true });
				evidence["refresh"] = { failedCatalogCount: 0, recovered: true };
			} else {
				await expect(
					browser.createSession("Unavailable Cursor", accountId, "cursor", {
						modelId: "composer-2.5",
						contextWindow: "",
					}),
				).rejects.toThrow("ModelNotInCatalog");
			}
			evidence["cursorModelCount"] = cursorModels.length;

			const claudeCatalogCursor = browser.frames.length;
			await browser.getModels("claude");
			const claudeCatalog = await browser.waitFor(
				(message) =>
					message["type"] === "project_setting" &&
					message["_tag"] === "providerModels" &&
					(message["providers"] as ProviderInfo[]).some(
						({ id }) => id === "claude",
					),
				claudeCatalogCursor,
			);
			const claudeModels = (
				claudeCatalog["providers"] as ProviderInfo[]
			).flatMap(({ models }) => models);
			expect(claudeModels.length).toBeGreaterThan(0);
			const claudeId = await browser.createSession("Claude unaffected");
			const claude = await browser.send(
				claudeId,
				"cursor-discovery-claude-proof",
				90_000,
			);
			expect(claude.chunks.join("")).toBe(
				responseChunks("cursor-discovery-claude-proof").join(""),
			);
			evidence["claude"] = {
				modelCount: claudeModels.length,
				status: claude.done["status"],
			};

			const release = await browser.borrowDraftModels("opencode");
			const opencodeCatalog = await browser
				.getModels("opencode")
				.finally(release);
			const opencodeModels = opencodeCatalog.providers
				.filter(({ configured }) => configured)
				.flatMap(({ models }) => models);
			const model = opencodeModels[0];
			if (!model) throw new Error("Missing OpenCode catalog");
			const { sessionId: opencodeId } = await fixture.requestRpc(
				new CreateSession({
					projectSlug: "process-test",
					title: "OpenCode unaffected",
					originId: browser.originId,
					providerId: "opencode",
					permissionMode: "ask",
					model: { providerId: model.provider, modelId: model.id },
				}),
			);
			const opencode = await browser.send(
				opencodeId,
				"Say hello in one sentence.",
				90_000,
			);
			expect(opencode.chunks.join("")).not.toBe("");
			expect(opencode.done["status"]).toBe("idle");
			evidence["opencode"] = {
				modelCount: opencodeModels.length,
				status: opencode.done["status"],
			};
			evidence["traceRows"] = readFileSync(capturePath, "utf8")
				.trim()
				.split("\n").length;
		}, 240_000);
	}
});
