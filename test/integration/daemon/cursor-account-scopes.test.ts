// Failure modes: shared SDK login state, account env ignored by auth, stale
// catalogs, discovery/run credential mismatch, and removal clearing another login.
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { CURRENT_CONFIG_VERSION } from "../../../src/lib/daemon/config-persistence.js";
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
			CURSOR_API_KEY: "[REDACTED:environment]",
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
				: name === "Cursor A"
					? { env: { CURSOR_API_KEY: "" } }
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
	expect(
		(await fixture.requestRpc({ _tag: "GetInstances" })).instances.find(
			({ id }) => id === b,
		),
	).toMatchObject({ available: false, unavailableCode: "auth_required" });
	const browser = await fixture.connect();
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
	const unauthenticated = sessions.get(b);
	if (!unauthenticated) throw new Error("Missing B session");
	await fixture.requestRpc({ _tag: "LogoutCursor", accountId: b });
	await browser.send(unauthenticated, "Do not borrow the daemon key", 90_000);
	const unauthenticatedDb = new Database(fixture.daemonStorePath(), {
		readonly: true,
	});
	try {
		const errors = unauthenticatedDb
			.prepare<[string], { data: string }>(
				"SELECT data FROM events WHERE session_id = ? AND type = 'turn.error'",
			)
			.all(unauthenticated);
		expect(errors.map(({ data }) => JSON.parse(data))).toContainEqual(
			expect.objectContaining({ code: "auth_required" }),
		);
	} finally {
		unauthenticatedDb.close();
	}
	writeFileSync(
		trace,
		original
			.replaceAll("[REDACTED]", "[REDACTED:account-b]")
			.replaceAll("Account A catalog", "Account B catalog"),
	);
	await login(b);
	writeFileSync(trace, original);
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
		const start = rows(capture).length;
		expect(
			(await browser.send(sessionId, "Still usable", 90_000)).chunks.join(""),
		).not.toBe("");
		for (const { data } of rows(capture)
			.slice(start)
			.filter(({ kind }) => kind === "create.options"))
			expect(data["credentialFingerprint"]).toBe(
				fingerprints[ids.indexOf(accountId)],
			);
	}
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const turns = db
			.prepare<[], { state: string }>("SELECT state FROM turns")
			.all();
		expect(turns.filter(({ state }) => state === "completed")).toHaveLength(5);
		expect(turns.filter(({ state }) => state === "error")).toHaveLength(1);
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
			completedTurns: 5,
			emptyAccountAuthRequiredDespiteAmbientKey: true,
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

it("aborts a removed account's pending login without saving a late credential", async () => {
	evidence = {};
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
	});
	const fixture = harness;
	const auth = join(fixture.root, "auth.json");
	const capture = join(fixture.root, "capture.jsonl");
	writeFileSync(auth, JSON.stringify({ accounts: {} }));
	await fixture.restart({
		startupTimeoutMs: 90_000,
		serviceEnvironment: {
			CONDUIT_CURSOR_SDK_TRACE: resolve(
				"test/fixtures/cursor-sdk-traces/auth-login.jsonl",
			),
			CONDUIT_CURSOR_SDK_CAPTURE: capture,
			CONDUIT_TEST_CURSOR_AUTH_STATE: auth,
			CONDUIT_TEST_CURSOR_LOGIN_DELAY_MS: "1200",
		},
	});
	const { addedInstanceId: accountId } = await fixture.requestRpc({
		_tag: "AddInstance",
		name: "Pending",
		driver: "cursor",
	});
	if (!accountId) throw new Error("Missing account");
	expect(
		(await fixture.requestRpc({ _tag: "StartCursorLogin", accountId })).login
			.state,
	).toBe("pending");
	await fixture.requestRpc({ _tag: "RemoveInstance", instanceId: accountId });
	await vi.waitFor(() =>
		expect(rows(capture).some(({ kind }) => kind === "auth.login.abort")).toBe(
			true,
		),
	);
	await setTimeout(1400);
	expect(
		(
			JSON.parse(readFileSync(auth, "utf8")) as {
				accounts: Record<string, unknown>;
			}
		).accounts[accountId],
	).toBeUndefined();
	await expect(
		fixture.requestRpc({ _tag: "GetCursorAuth", accountId }),
	).rejects.toThrow(/unavailable/);
	evidence = { loginAborted: true, noLateCredential: true };
}, 90_000);

it("cancels and cleans up an account's title generation when the account is removed", async () => {
	evidence = {};
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
	});
	const fixture = harness;
	const capture = join(fixture.root, "capture.jsonl");
	const gate = join(fixture.root, "title.gate");
	writeFileSync(gate, "hold");
	await fixture.restart({
		startupTimeoutMs: 90_000,
		runnerStartupTimeoutMs: 90_000,
		opencodeIdleTimeoutMs: 100,
		serviceEnvironment: {
			CONDUIT_CURSOR_SDK_TRACE: resolve(
				"test/fixtures/cursor-sdk-traces/title-generation.jsonl",
			),
			CONDUIT_CURSOR_SDK_CAPTURE: capture,
			CONDUIT_TEST_CURSOR_STREAM_GATE: gate,
		},
	});
	const { addedInstanceId: accountId } = await fixture.requestRpc({
		_tag: "AddInstance",
		name: "Titles",
		driver: "cursor",
		env: { CURSOR_API_KEY: "[REDACTED:environment]" },
	});
	if (!accountId) throw new Error("Missing title account");
	await fixture.requestRpc({
		_tag: "SetTitleGeneration",
		projectSlug: "process-test",
		selection: {
			account: { _tag: "Id", id: accountId },
			providerId: "cursor",
			modelId: "composer-2.5",
			effort: "",
		},
	});
	const browser = await fixture.connect();
	const sessionId = await browser.createSession();
	await browser.send(sessionId, "Fix login redirect loop", 90_000);
	await vi.waitFor(
		() =>
			expect(rows(capture).some(({ kind }) => kind === "send.options")).toBe(
				true,
			),
		{ timeout: 30_000 },
	);
	await setTimeout(350);
	expect(rows(capture).some(({ kind }) => kind === "cancel.call")).toBe(false);
	await fixture.requestRpc({ _tag: "RemoveInstance", instanceId: accountId });
	await vi.waitFor(() =>
		expect(rows(capture).map(({ kind }) => kind)).toEqual(
			expect.arrayContaining([
				"cancel.call",
				"agent.disposed",
				"store.disposed",
				"agent.delete.call",
			]),
		),
	);
	expect(readdirSync(join(fixture.configDir, "text-generation"))).toEqual([]);
	rmSync(gate);
	evidence = {
		titleCancelled: true,
		scratchRemoved: true,
		accountIdleGraceMs: 100,
		heldMs: 350,
	};
}, 120_000);

it("keeps the ambient key bound to the original compatibility account across default changes and restart", async () => {
	evidence = {};
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
	});
	const fixture = harness;
	const configPath = join(fixture.configDir, "daemon.json");
	const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
		string,
		unknown
	>;
	writeFileSync(
		configPath,
		JSON.stringify({
			...config,
			configVersion: CURRENT_CONFIG_VERSION,
			instances: ["cursor-a", "cursor-b"].map((id) => ({
				id,
				name: id,
				driver: "cursor",
				port: 0,
				managed: false,
			})),
			accountDefaults: { cursor: "cursor-a" },
		}),
	);
	const auth = join(fixture.root, "auth.json");
	writeFileSync(
		auth,
		JSON.stringify({
			accounts: Object.fromEntries(
				["cursor-a", "cursor-b"].map((id) => [
					id,
					{
						status: {
							status: "logged-in",
							backendUrl: "https://api2.cursor.sh",
							email: `${id}@example.test`,
						},
						credential: {
							apiKey: `[REDACTED:${id}]`,
							backendUrl: "https://api2.cursor.sh",
							email: `${id}@example.test`,
							createdAtMs: 0,
						},
					},
				]),
			),
		}),
	);
	const restart = () =>
		fixture.restart({
			startupTimeoutMs: 90_000,
			serviceEnvironment: {
				CURSOR_API_KEY: "[REDACTED:environment]",
				CONDUIT_CURSOR_SDK_TRACE: resolve(
					"test/fixtures/cursor-sdk-traces/auth-login.jsonl",
				),
				CONDUIT_TEST_CURSOR_AUTH_STATE: auth,
			},
		});
	await restart();
	expect(
		await fixture.requestRpc({ _tag: "GetCursorAuth", accountId: "cursor-a" }),
	).toMatchObject({ source: "environment", status: "logged-in" });
	const assertB = async () =>
		expect(
			await fixture.requestRpc({
				_tag: "GetCursorAuth",
				accountId: "cursor-b",
			}),
		).toMatchObject({ source: "sdk-login", email: "cursor-b@example.test" });
	await assertB();
	await fixture.requestRpc({ _tag: "SetDefault", instanceId: "cursor-b" });
	await assertB();
	await fixture.requestRpc({ _tag: "RemoveInstance", instanceId: "cursor-a" });
	await assertB();
	await fixture.kill();
	await restart();
	await assertB();
	evidence = {
		originalDefaultUsesAmbientKey: true,
		namedSurvivorKeepsSdkLogin: true,
		persistedAcrossRestart: true,
	};
}, 120_000);
