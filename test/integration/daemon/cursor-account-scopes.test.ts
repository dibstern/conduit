// Failure modes: shared SDK login state, account env ignored by auth, stale
// catalogs, discovery/run credential mismatch, and removal clearing another login.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderInfo } from "../../../src/lib/shared-types.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
const artifact = "/tmp/conduit-82tn9-5-cursor-accounts.json";
let evidence: Record<string, unknown> = {};
const scenarios: Record<string, unknown>[] = [];

function rows(path: string): { kind: string; data: Record<string, unknown> }[] {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
}

afterEach(async ({ task }) => {
	if (!harness) return;
	const fixture = harness;
	await fixture.dispose();
	scenarios.push({
		scenario: task.name,
		result: task.result?.state,
		failures: task.result?.errors?.map(({ message }) => message),
		proof: fixture.proof(),
		remainingRunners: fixture.remainingRunnerPids(),
		evidence,
	});
	writeFileSync(
		artifact,
		JSON.stringify({ bead: "conduit-test-82tn.9.5", scenarios }, null, 2),
	);
	harness = undefined;
});

it("isolates two SDK logins and an environment account through discovery, runs and removal", async () => {
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
	});
	const fixture = harness;
	const trace = join(fixture.root, "cursor.jsonl");
	const capture = join(fixture.root, "capture.jsonl");
	const auth = join(fixture.root, "auth.json");
	const original = readFileSync(
		resolve("test/fixtures/cursor-sdk-traces/auth-login.jsonl"),
		"utf8",
	).replaceAll("Composer 2.5", "Account A catalog");
	writeFileSync(trace, original);
	writeFileSync(
		auth,
		JSON.stringify({
			status: { status: "logged-out" },
			credential: null,
			accounts: {},
		}),
	);
	await fixture.restart({
		startupTimeoutMs: 90_000,
		runnerStartupTimeoutMs: 90_000,
		serviceEnvironment: {
			CONDUIT_CURSOR_SDK_TRACE: trace,
			CONDUIT_CURSOR_SDK_CAPTURE: capture,
			CONDUIT_TEST_CURSOR_AUTH_STATE: auth,
		},
	});
	const ids: string[] = [];
	for (const name of ["Cursor A", "Cursor B", "Cursor token"]) {
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			name,
			driver: "cursor",
			...(name === "Cursor token"
				? { env: { CURSOR_API_KEY: "[REDACTED:environment]" } }
				: {}),
		});
		if (!added.addedInstanceId) throw new Error("No account allocated");
		ids.push(added.addedInstanceId);
	}
	const [a, b, token] = ids as [string, string, string];
	const login = async (accountId: string) => {
		const request = { _tag: "StartCursorLogin" as const, accountId };
		await fixture.requestRpc(request);
		await vi.waitFor(
			async () => {
				const request = { _tag: "GetCursorAuth" as const, accountId };
				expect((await fixture.requestRpc(request)).login.state).toBe(
					"complete",
				);
			},
			{ timeout: 30_000 },
		);
	};
	await login(a);
	await fixture.requestRpc({ _tag: "GetInstances" });
	const readB = { _tag: "GetCursorAuth" as const, accountId: b };
	expect(await fixture.requestRpc(readB)).toMatchObject({
		status: "logged-out",
		login: { state: "idle" },
	});
	// A second recorded login mints a different synthetic key.
	writeFileSync(
		trace,
		original
			.replaceAll("[REDACTED]", "[REDACTED:account-b]")
			.replaceAll("Account A catalog", "Account B catalog"),
	);
	await login(b);
	await fixture.requestRpc({ _tag: "GetInstances" });
	const readToken = { _tag: "GetCursorAuth" as const, accountId: token };
	expect(await fixture.requestRpc(readToken)).toMatchObject({
		source: "environment",
		status: "logged-in",
	});
	const logoutA = { _tag: "LogoutCursor" as const, accountId: a };
	expect(await fixture.requestRpc(logoutA)).toMatchObject({
		status: "logged-out",
	});
	expect(await fixture.requestRpc(readB)).toMatchObject({
		source: "sdk-login",
		status: "logged-in",
	});
	writeFileSync(trace, original);
	await login(a);
	const browser = await fixture.connect();
	const sessions = new Map<string, string>();
	for (const accountId of ids) {
		const instance = (
			await fixture.requestRpc({ _tag: "GetInstances" })
		).instances.find(({ id }) => id === accountId);
		expect(instance).toMatchObject({ available: true });
		const sessionId = await browser.createSession(
			accountId,
			accountId,
			"cursor",
			{ modelId: "composer-2.5", contextWindow: "" },
		);
		sessions.set(accountId, sessionId);
		const catalogCursor = browser.frames.length;
		await browser.getModels(accountId);
		const catalog = await browser.waitFor(
			(message) =>
				message["type"] === "project_setting" &&
				message["_tag"] === "providerModels" &&
				message["accountId"] === accountId,
			catalogCursor,
		);
		expect(
			(catalog["providers"] as ProviderInfo[])
				.find(({ id }) => id === "cursor")
				?.models.find(({ id }) => id === "composer-2.5")?.name,
		).toBe(accountId === b ? "Account B catalog" : "Account A catalog");
		const start = rows(capture).length;
		await browser.send(sessionId, "Say hello", 90_000);
		const operations = rows(capture).slice(start);
		const created = operations.find(
			({ kind }) => kind === "create.options",
		)?.data;
		expect(created?.["credentialFingerprint"]).toEqual(expect.any(String));
		const catalogs = rows(capture).filter(
			({ kind }) => kind === "models.list.call",
		);
		expect(
			catalogs.some(({ data }) => {
				const credential = data["credential"] as
					| Record<string, unknown>
					| undefined;
				return (
					credential?.["fingerprint"] === created?.["credentialFingerprint"]
				);
			}),
		).toBe(true);
	}
	const fingerprints = rows(capture)
		.filter(({ kind }) => kind === "create.options")
		.map(({ data }) => data["credentialFingerprint"]);
	expect(new Set(fingerprints).size).toBe(3);
	evidence = {
		accounts: ids,
		fingerprints,
		separateCatalogs: true,
		discoveryMatchesRuns: true,
	};
	await fixture.requestRpc({ _tag: "RemoveInstance", instanceId: a });
	await expect(
		fixture.requestRpc({ _tag: "GetCursorAuth", accountId: a }),
	).rejects.toThrow(/unavailable/);
	expect(await fixture.requestRpc(readB)).toMatchObject({
		status: "logged-in",
	});
	expect(await fixture.requestRpc(readToken)).toMatchObject({
		status: "logged-in",
	});
	for (const accountId of [b, token]) {
		const sessionId = sessions.get(accountId);
		if (!sessionId) throw new Error("Missing session");
		expect(
			(await browser.send(sessionId, "Still usable", 90_000)).chunks.join(""),
		).not.toBe("");
	}
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const turns = db
			.prepare<[], { state: string }>("SELECT state FROM turns")
			.all();
		expect(turns.map(({ state }) => state)).toEqual(Array(5).fill("completed"));
		const payloads = db
			.prepare<[], { payload_json: string }>(
				"SELECT payload_json FROM provider_command_outbox",
			)
			.all();
		expect(JSON.stringify(payloads)).not.toMatch(
			/cursorCredential|apiKey|REDACTED/,
		);
		evidence = {
			...evidence,
			completedTurns: turns.length,
			secretsExcludedFromOutbox: true,
			survivorsUsableAfterRemoval: true,
		};
	} finally {
		db.close();
	}
}, 240_000);

it("keeps a pending SDK login alive without polling beyond account idle grace", async () => {
	evidence = {};
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
	});
	const fixture = harness;
	const auth = join(fixture.root, "auth.json");
	writeFileSync(
		auth,
		JSON.stringify({
			status: { status: "logged-out" },
			credential: null,
			accounts: {},
		}),
	);
	await fixture.restart({
		startupTimeoutMs: 90_000,
		opencodeIdleTimeoutMs: 100,
		serviceEnvironment: {
			CONDUIT_CURSOR_SDK_TRACE: resolve(
				"test/fixtures/cursor-sdk-traces/auth-login.jsonl",
			),
			CONDUIT_TEST_CURSOR_AUTH_STATE: auth,
			CONDUIT_TEST_CURSOR_LOGIN_DELAY_MS: "1200",
		},
	});
	const account = await fixture.requestRpc({
		_tag: "AddInstance",
		name: "Cursor pending",
		driver: "cursor",
	});
	const accountId = account.addedInstanceId;
	if (!accountId) throw new Error("No account allocated");
	expect(
		(await fixture.requestRpc({ _tag: "StartCursorLogin", accountId })).login
			.state,
	).toBe("pending");
	await setTimeout(400);
	expect(
		(await fixture.requestRpc({ _tag: "GetCursorAuth", accountId })).login
			.state,
	).toBe("pending");
	await vi.waitFor(
		async () =>
			expect(
				await fixture.requestRpc({ _tag: "GetCursorAuth", accountId }),
			).toMatchObject({ status: "logged-in", login: { state: "complete" } }),
		{ timeout: 10_000 },
	);
	evidence = {
		accountIdleGraceMs: 100,
		noPollingMs: 400,
		loginCompleted: true,
	};
}, 90_000);
