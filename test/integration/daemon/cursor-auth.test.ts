// Failure modes: overlapping logins, callbacks after cancel/deadline, a login
// deadline displayed as key expiry, environment precedence, stale discovery,
// stale credentials in existing runners, recorded credentials authenticating
// an unconfigured login slot, and secrets escaping into RPC/captures.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_CONFIG_VERSION } from "../../../src/lib/daemon/config-persistence.js";

import { ProcessHarness } from "../../helpers/process-harness.js";

interface TraceRow {
	kind?: string;
	data?: unknown;
	[key: string]: unknown;
}

const TIMEOUT = 90_000;
const KEY_EXPIRY = 4_102_444_800_000;
const BASIC_TEXT =
	"Hi David — good to meet you. What would you like to work on today?";

function traceRows(path: string): TraceRow[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TraceRow);
}

function storedTurns(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return {
			states: db
				.prepare<[string], { state: string }>(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId)
				.map(({ state }) => state),
			errors: db
				.prepare<[string], { data: string }>(
					"SELECT data FROM events WHERE session_id = ? AND type = 'turn.error' ORDER BY sequence",
				)
				.all(sessionId)
				.map(({ data }) => JSON.parse(data) as Record<string, unknown>),
		};
	} finally {
		db.close();
	}
}

describe("Cursor authentication through the built daemon and detached runners", () => {
	let harness: ProcessHarness | undefined;
	let tracePath = "";
	let capturePath = "";
	let authStatePath = "";
	let commandLogPath = "";
	let scenario = "setup";
	let invariants: Record<string, boolean> = {};
	const scenarios: Record<string, unknown>[] = [];

	async function start(
		name: string,
		options: {
			loginDelayMs?: number;
			loginUrlDelayMs?: number;
			loginTimeoutMs?: number;
			catalogTtlMs?: number;
			environmentKey?: boolean;
			initialCredential?: boolean;
			traceAuthOnly?: boolean;
			backendUrl?: string;
			storedBackendUrl?: string;
			recordCommands?: boolean;
			compatibilityAccount?: boolean;
		} = {},
	) {
		scenario = name;
		invariants = {};
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		const fixture = harness;
		if (options.compatibilityAccount) {
			const path = join(fixture.configDir, "daemon.json");
			const config = JSON.parse(readFileSync(path, "utf8")) as Record<
				string,
				unknown
			>;
			writeFileSync(
				path,
				JSON.stringify({
					...config,
					configVersion: CURRENT_CONFIG_VERSION,
					instances: [
						{
							id: "cursor-command-account",
							name: "Cursor compatibility",
							driver: "cursor",
							port: 0,
							managed: false,
						},
					],
					accountDefaults: { cursor: "cursor-command-account" },
				}),
			);
		}
		tracePath = join(fixture.root, "cursor-auth-replay.jsonl");
		capturePath = join(fixture.root, "cursor-auth-capture.jsonl");
		authStatePath = join(fixture.root, "cursor-replay-auth.json");
		commandLogPath = join(fixture.root, "runner-commands.jsonl");
		const commandRecorder = join(fixture.root, "record-runner-commands.mjs");
		if (options.recordCommands) {
			writeFileSync(
				commandRecorder,
				`
import { appendFileSync } from "node:fs";
import { RunnerSocket } from ${JSON.stringify(pathToFileURL(resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist", "src/lib/provider/runner/runner-protocol.js")).href)};
const write = RunnerSocket.prototype.write;
RunnerSocket.prototype.write = function(message) {
  if (message.type === "command" && message.command.type === "send-turn")
    appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify(message) + "\\n");
  return write.call(this, message);
};
`,
			);
		}
		const auth = traceRows(
			resolve("test/fixtures/cursor-sdk-traces/auth-login.jsonl"),
		);
		writeFileSync(
			tracePath,
			`${auth.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		writeFileSync(
			authStatePath,
			JSON.stringify(
				options.initialCredential
					? {
							status: auth.find(({ kind }) => kind === "auth.status")?.data,
							credential: {
								...(auth.find(({ kind }) => kind === "credential.store")
									?.data as Record<string, unknown>),
								apiKey: "[REDACTED:before-login]",
								...(options.storedBackendUrl
									? { backendUrl: options.storedBackendUrl }
									: {}),
							},
						}
					: { status: { status: "logged-out" }, credential: null },
			),
		);
		await fixture.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CURSOR_BACKEND_URL: options.backendUrl ?? "https://api2.cursor.sh",
				...(options.recordCommands
					? { NODE_OPTIONS: `--import=${pathToFileURL(commandRecorder).href}` }
					: {}),
				CONDUIT_CURSOR_SDK_TRACE: tracePath,
				CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
				...(options.traceAuthOnly
					? {}
					: { CONDUIT_TEST_CURSOR_AUTH_STATE: authStatePath }),
				CONDUIT_TEST_CURSOR_LOGIN_DELAY_MS: String(
					options.loginDelayMs ?? 5_000,
				),
				CONDUIT_TEST_CURSOR_LOGIN_URL_DELAY_MS: String(
					options.loginUrlDelayMs ?? 0,
				),
				CONDUIT_TEST_CURSOR_LOGIN_TIMEOUT_MS: String(
					options.loginTimeoutMs ?? TIMEOUT,
				),
				...(options.catalogTtlMs === undefined
					? {}
					: {
							CONDUIT_TEST_CURSOR_CATALOG_TTL_MS: String(options.catalogTtlMs),
						}),
				...(options.environmentKey
					? { CURSOR_API_KEY: "[REDACTED:environment]" }
					: {}),
			},
		});
		return fixture;
	}

	async function completeLogin(fixture: ProcessHarness) {
		await fixture.requestRpc({ _tag: "StartCursorLogin" });
		await vi.waitFor(
			async () =>
				expect(
					(await fixture.requestRpc({ _tag: "GetCursorAuth" })).login.state,
				).toBe("complete"),
			{ timeout: TIMEOUT, interval: 100 },
		);
		return fixture.requestRpc({ _tag: "GetCursorAuth" });
	}

	async function expectOperation(kind: string) {
		await vi.waitFor(
			() =>
				expect(traceRows(capturePath).some((row) => row.kind === kind)).toBe(
					true,
				),
			{ timeout: TIMEOUT, interval: 100 },
		);
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const operations = traceRows(capturePath)
			.filter(
				({ kind }) =>
					kind !== undefined &&
					/^(auth\.|models\.list\.call|create\.options|resume\.options|sandbox\.prime|send\.error|wait\.result)/.test(
						kind,
					),
			)
			.map(({ kind, data }) => ({ kind, data }));
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			const proof = fixture.proof();
			scenarios.push({
				scenario,
				result: task.result?.state,
				failures: task.result?.errors?.map(({ message }) => message) ?? [],
				sourceCaptures: ["auth-login-declared-types", "basic"],
				operations,
				invariants: {
					...invariants,
					isolatedCredentialState: authStatePath.startsWith(fixture.root),
					realDaemon: proof.generations.every(({ pid }) => pid > 0),
					noRemainingRunner: fixture.remainingRunnerPids().length === 0,
					noRpcDecodeFailure: proof.rpcDecodeFailures.length === 0,
				},
				process: {
					buildIdentity: proof.buildIdentity,
					generations: proof.generations.map(({ pid, exitCode, signal }) => ({
						pid,
						exitCode,
						signal,
					})),
					runnerPids: fixture.runnerPids(),
					remainingRunnerPids: fixture.remainingRunnerPids(),
					...(task.result?.errors?.length ? { logTail: proof.logTail } : {}),
				},
			});
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/conduit-test-xqsg.11.json",
				`${JSON.stringify({ ticket: "conduit-test-xqsg.11", scenarios }, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	it("C1 B: refuses another backend's stored login but accepts trailing slashes", async () => {
		const fixture = await start("backend-credential", {
			initialCredential: true,
			backendUrl: "https://cursor-backend.example.test/",
			storedBackendUrl: "https://cursor-backend.example.test///",
		});
		const { addedInstanceId: accountId } = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Cursor backend",
			driver: "cursor",
		});
		if (!accountId) throw new Error("Missing Cursor account");
		const browser = await fixture.connect();
		const id = await browser.createSession(
			"Backend credential",
			accountId,
			"cursor",
			{
				modelId: "composer-2.5",
				contextWindow: "",
			},
		);
		expect(
			(await browser.send(id, "Matching backend", TIMEOUT)).chunks.join(""),
		).toBe(BASIC_TEXT);
		const state = JSON.parse(readFileSync(authStatePath, "utf8")) as {
			status: Record<string, unknown>;
			credential: Record<string, unknown>;
		};
		writeFileSync(
			authStatePath,
			JSON.stringify({
				...state,
				credential: {
					...state.credential,
					backendUrl: "https://other-backend.example.test",
				},
			}),
		);
		await browser.send(id, "Do not send this key to another backend", TIMEOUT);
		expect(storedTurns(fixture, id).states).toEqual(["completed", "error"]);
		expect(storedTurns(fixture, id).errors).toEqual([
			expect.objectContaining({
				code: "auth_required",
				error: expect.stringMatching(
					/logging in replaces the stored login for.*other-backend/i,
				),
			}),
		]);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "send.options"),
		).toHaveLength(1);
		invariants = {
			matchingBackendNormalised: true,
			otherBackendNeverSentToSdk: true,
		};
	}, 240_000);

	it.each([
		"stored",
		"account-env",
		"launch-env",
	] as const)("C1 C: logging the prepared runner send command does not expose the API key (%s)", async (source) => {
		const fixture = await start("redacted-runner-command", {
			initialCredential: true,
			recordCommands: true,
			environmentKey: source !== "stored",
			compatibilityAccount: source === "launch-env",
		});
		const accountId =
			source === "launch-env"
				? "cursor-command-account"
				: (
						await fixture.requestRpc({
							_tag: "AddInstance",
							name: "Cursor redacted",
							driver: "cursor",
							...(source === "account-env"
								? { env: { CURSOR_API_KEY: "[REDACTED:environment]" } }
								: {}),
						})
					).addedInstanceId;
		if (!accountId) throw new Error("Missing Cursor account");
		const browser = await fixture.connect();
		const id = await browser.createSession(
			"Redacted command",
			accountId,
			"cursor",
			{
				modelId: "composer-2.5",
				contextWindow: "",
			},
		);
		expect(
			(
				await browser.send(id, "Use the prepared credential", TIMEOUT)
			).chunks.join(""),
		).toBe(BASIC_TEXT);
		const logged = readFileSync(commandLogPath, "utf8");
		expect(logged).toContain('"type":"send-turn"');
		expect(logged).not.toContain("[REDACTED:before-login]");
		expect(logged).not.toContain("[REDACTED:environment]");
		invariants = {
			commandLoggedBeforeWireEncoding: true,
			secretAbsentFromCommandLog: true,
			runnerReceivedCredential: true,
		};
	}, 240_000);

	it("C1 D: auth status reports a stored login for another backend as an error", async () => {
		const fixture = await start("backend-auth-status", {
			initialCredential: true,
			backendUrl: "https://cursor-backend.example.test",
		});
		expect(await fixture.requestRpc({ _tag: "GetCursorAuth" })).toMatchObject({
			source: "sdk-login",
			status: "error",
			error: expect.stringMatching(
				/logging in replaces the stored login for.*api2\.cursor\.sh/i,
			),
		});
		invariants = { otherBackendNotLoggedIn: true };
	}, 240_000);

	it("C1: reports an expired stored login consistently in auth status and turns", async () => {
		const fixture = await start("expired-credential", {
			initialCredential: true,
		});
		const { addedInstanceId: accountId } = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Cursor expiry",
			driver: "cursor",
		});
		if (!accountId) throw new Error("Missing Cursor account");
		const browser = await fixture.connect();
		const id = await browser.createSession(
			"Expired credential",
			accountId,
			"cursor",
			{ modelId: "composer-2.5", contextWindow: "" },
		);
		const state = JSON.parse(readFileSync(authStatePath, "utf8")) as {
			status: Record<string, unknown>;
			credential: Record<string, unknown>;
		};
		writeFileSync(
			authStatePath,
			JSON.stringify({
				...state,
				credential: { ...state.credential, apiKeyExpiresAtMs: Date.now() - 1 },
			}),
		);
		expect(
			await fixture.requestRpc({ _tag: "GetCursorAuth", accountId }),
		).toMatchObject({
			source: "sdk-login",
			status: "error",
			error: expect.stringMatching(/expired.*log in/i),
		});
		await browser.send(id, "Do not use an expired key", TIMEOUT);
		expect(storedTurns(fixture, id).errors).toEqual([
			expect.objectContaining({
				code: "auth_required",
				error: expect.stringMatching(/expired.*log in/i),
			}),
		]);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "send.options"),
		).toEqual([]);
	}, 240_000);

	it("C1: rejects an account-level backend override", async () => {
		const fixture = await start("account-backend-rejection");
		await expect(
			fixture.requestRpc({
				_tag: "AddInstance",
				name: "Invalid Cursor backend",
				driver: "cursor",
				env: { CURSOR_BACKEND_URL: "https://other-backend.example.test" },
			}),
		).rejects.toThrow(/CURSOR_BACKEND_URL.*daemon/i);
	}, 240_000);

	it("C1: retires a detached runner when the daemon changes backend", async () => {
		const fixture = await start("runner-backend-upgrade", {
			environmentKey: true,
		});
		const { addedInstanceId: accountId } = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Cursor backend upgrade",
			driver: "cursor",
			env: { CURSOR_API_KEY: "[REDACTED:environment]" },
		});
		if (!accountId) throw new Error("Missing Cursor account");
		const browser = await fixture.connect();
		const id = await browser.createSession(
			"Runner backend upgrade",
			accountId,
			"cursor",
			{ modelId: "composer-2.5", contextWindow: "" },
		);
		expect(
			(await browser.send(id, "Before backend change", TIMEOUT)).chunks.join(
				"",
			),
		).toBe(BASIC_TEXT);
		const before = fixture.remainingRunnerPids();
		expect(before).toHaveLength(1);
		await fixture.terminate();
		await fixture.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CURSOR_BACKEND_URL: "https://other-backend.example.test///",
				CURSOR_API_KEY: "[REDACTED:environment]",
				CONDUIT_CURSOR_SDK_TRACE: tracePath,
				CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
				CONDUIT_TEST_CURSOR_AUTH_STATE: authStatePath,
			},
		});
		const recovered = await fixture.connect();
		expect(
			(await recovered.send(id, "After backend change", TIMEOUT)).chunks.join(
				"",
			),
		).toBe(BASIC_TEXT);
		const after = fixture.remainingRunnerPids();
		expect(after).toHaveLength(1);
		expect(after[0]).not.toBe(before[0]);
		const opens = traceRows(capturePath)
			.filter(
				({ kind }) => kind === "create.options" || kind === "resume.options",
			)
			.map(({ data }) => data as Record<string, unknown>);
		expect(opens).toHaveLength(2);
		expect(opens[1]?.["credentialFingerprint"]).not.toBe(
			opens[0]?.["credentialFingerprint"],
		);
		invariants = {
			otherBackendRunnerRetired: true,
			freshBackendCredential: true,
		};
	}, 240_000);

	it("does not authenticate an unconfigured login slot from recorded credentials", async () => {
		const fixture = await start("unconfigured-recorded-login", {
			traceAuthOnly: true,
		});
		expect(
			(await fixture.requestRpc({ _tag: "GetInstances" })).instances.filter(
				({ driver }) => driver === "cursor",
			),
		).toEqual([]);
		expect(await fixture.requestRpc({ _tag: "GetCursorAuth" })).toMatchObject({
			source: "none",
			status: "logged-out",
			login: { state: "idle" },
		});
		const { addedInstanceId } = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Recorded account",
			driver: "cursor",
		});
		if (!addedInstanceId) throw new Error("Missing Cursor account");
		expect(
			await fixture.requestRpc({
				_tag: "GetCursorAuth",
				accountId: addedInstanceId,
			}),
		).toMatchObject({ source: "sdk-login", status: "logged-in" });
		invariants = {
			unconfiguredSlotLoggedOut: true,
			configuredAccountRetainsReplayCredential: true,
		};
	}, 180_000);

	it("shows one login link, completes once, reports the key expiry, and refreshes one routable account", async () => {
		const fixture = await start("login-status-directory");
		expect(await fixture.requestRpc({ _tag: "GetCursorAuth" })).toMatchObject({
			source: "none",
			status: "logged-out",
			expiresSoon: false,
			login: { state: "idle" },
		});
		const startedAt = Date.now();
		const starts = await Promise.all([
			fixture.requestRpc({ _tag: "StartCursorLogin" }),
			fixture.requestRpc({ _tag: "StartCursorLogin" }),
		]);
		for (const state of starts) expect(state.login.state).toBe("pending");
		await vi.waitFor(
			async () => {
				const state = await fixture.requestRpc({ _tag: "GetCursorAuth" });
				expect(state.login.state).toBe("pending");
				expect(state.login.url).toMatch(
					/^https:\/\/cursor\.com\/loginDeepControl\?/,
				);
				expect(state.login.deadlineAtMs).toBeGreaterThan(startedAt);
				expect(state.apiKeyExpiresAtMs).toBeUndefined();
			},
			{ timeout: TIMEOUT, interval: 100 },
		);
		await vi.waitFor(
			async () =>
				expect(
					(await fixture.requestRpc({ _tag: "GetCursorAuth" })).login.state,
				).toBe("complete"),
			{ timeout: TIMEOUT, interval: 100 },
		);
		const authenticated = await fixture.requestRpc({ _tag: "GetCursorAuth" });
		expect(authenticated).toMatchObject({
			source: "sdk-login",
			status: "logged-in",
			email: "cursor-user@example.test",
			apiKeyExpiresAtMs: KEY_EXPIRY,
			expiresSoon: false,
			login: { state: "complete" },
		});
		expect(authenticated.login.deadlineAtMs).toBeUndefined();
		expect(JSON.stringify(authenticated)).not.toContain("REDACTED");
		const calls = traceRows(capturePath).filter(
			({ kind }) => kind === "auth.login.call",
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.data).toEqual({
			openBrowser: false,
			apiKeyName: "conduit",
		});
		const instances = (
			await fixture.requestRpc({ _tag: "GetInstances" })
		).instances.filter(({ driver }) => driver === "cursor");
		expect(instances).toHaveLength(1);
		expect(instances[0]).toMatchObject({ available: true });
		const accountId = instances[0]?.id;
		if (!accountId) throw new Error("Login did not register a Cursor account");
		const browser = await fixture.connect();
		await browser.getModels(accountId);
		const models = await browser.waitFor(
			(message) => {
				const providers = message["providers"];
				return (
					message["type"] === "project_setting" &&
					message["_tag"] === "providerModels" &&
					message["accountId"] === accountId &&
					Array.isArray(providers) &&
					providers.length > 0
				);
			},
			0,
			TIMEOUT,
		);
		expect(models["providers"]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "cursor",
					configured: true,
					models: expect.arrayContaining([
						expect.objectContaining({ id: "composer-2.5" }),
					]),
				}),
			]),
		);
		const state = JSON.parse(readFileSync(authStatePath, "utf8")) as {
			status: Record<string, unknown>;
			credential: Record<string, unknown>;
		};
		const expiresSoonAt = Date.now() + 24 * 60 * 60 * 1_000;
		writeFileSync(
			authStatePath,
			JSON.stringify({
				status: { ...state.status, apiKeyExpiresAtMs: expiresSoonAt },
				credential: { ...state.credential, apiKeyExpiresAtMs: expiresSoonAt },
			}),
		);
		expect(await fixture.requestRpc({ _tag: "GetCursorAuth" })).toMatchObject({
			apiKeyExpiresAtMs: expiresSoonAt,
			expiresSoon: true,
		});
		expect(await fixture.requestRpc({ _tag: "LogoutCursor" })).toMatchObject({
			source: "none",
			status: "logged-out",
			login: { state: "idle" },
		});
		const loggedOut = (
			await fixture.requestRpc({ _tag: "GetInstances" })
		).instances.filter(({ driver }) => driver === "cursor");
		expect(loggedOut).toHaveLength(1);
		expect(loggedOut[0]).toMatchObject({
			id: accountId,
			available: false,
			unavailableReason: expect.stringMatching(/log\s*in/i),
			unavailableCode: "auth_required",
		});
		await completeLogin(fixture);
		const loggedIn = (
			await fixture.requestRpc({ _tag: "GetInstances" })
		).instances.filter(({ driver }) => driver === "cursor");
		expect(loggedIn).toHaveLength(1);
		expect(loggedIn[0]).toMatchObject({ id: accountId, available: true });
		invariants = {
			singleConcurrentLogin: calls.length === 1,
			browserNotOpened: true,
			keyNamedConduit: true,
			keyExpirySeparateFromLoginDeadline: true,
			expiryWarning: true,
			discoveryRefreshedWithoutRestart: true,
			oneRoutableAccount: loggedIn.length === 1,
		};
	}, 240_000);

	it("aborts cancellation and ignores a login URL that arrives afterwards", async () => {
		const fixture = await start("cancel-late-callback", {
			loginDelayMs: 60_000,
			loginUrlDelayMs: 8_000,
		});
		expect(
			(await fixture.requestRpc({ _tag: "StartCursorLogin" })).login.state,
		).toBe("pending");
		expect(
			await fixture.requestRpc({ _tag: "CancelCursorLogin" }),
		).toMatchObject({
			status: "logged-out",
			login: { state: "cancelled" },
		});
		await expectOperation("auth.login.abort");
		await expectOperation("auth.loginUrl");
		const state = await fixture.requestRpc({ _tag: "GetCursorAuth" });
		expect(state.login).toEqual({ state: "cancelled" });
		expect(state.status).toBe("logged-out");
		const captured = traceRows(capturePath);
		expect(
			captured.findIndex(({ kind }) => kind === "auth.login.abort"),
		).toBeLessThan(captured.findIndex(({ kind }) => kind === "auth.loginUrl"));
		expect(
			traceRows(capturePath).find(({ kind }) => kind === "auth.login.abort")
				?.data,
		).toEqual({ aborted: true });
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "auth.login"),
		).toEqual([]);
		invariants = {
			signalAborted: true,
			lateCallbackObserved: true,
			lateUrlIgnored: true,
			noCredentialCreated: true,
		};
	}, 240_000);

	it("times out the flow and ignores its late callback without inventing a key expiry", async () => {
		const fixture = await start("timeout-late-callback", {
			loginDelayMs: 60_000,
			loginUrlDelayMs: 3_000,
			loginTimeoutMs: 500,
		});
		await fixture.requestRpc({ _tag: "StartCursorLogin" });
		await expectOperation("auth.login.abort");
		await expectOperation("auth.loginUrl");
		const state = await fixture.requestRpc({ _tag: "GetCursorAuth" });
		expect(state).toMatchObject({
			status: "logged-out",
			login: { state: "timed-out", error: expect.stringMatching(/timed out/i) },
		});
		expect(state.login.url).toBeUndefined();
		expect(state.login.deadlineAtMs).toBeUndefined();
		expect(state.apiKeyExpiresAtMs).toBeUndefined();
		const captured = traceRows(capturePath);
		expect(
			captured.findIndex(({ kind }) => kind === "auth.login.abort"),
		).toBeLessThan(captured.findIndex(({ kind }) => kind === "auth.loginUrl"));
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "auth.login"),
		).toEqual([]);
		invariants = {
			deadlineAbortedSignal: true,
			lateCallbackObserved: true,
			lateUrlIgnored: true,
			deadlineNotKeyExpiry: true,
		};
	}, 240_000);

	it("validates environment credentials with models and never reads or mutates the SDK login", async () => {
		const fixture = await start("environment-precedence", {
			environmentKey: true,
		});
		for (const request of [
			{ _tag: "GetCursorAuth" },
			{ _tag: "StartCursorLogin" },
			{ _tag: "LogoutCursor" },
		] as const) {
			const state = await fixture.requestRpc(request);
			expect(state).toMatchObject({
				source: "environment",
				status: "logged-in",
				expiresSoon: false,
				login: { state: "idle" },
			});
			expect(JSON.stringify(state)).not.toContain("REDACTED");
		}
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Cursor environment",
			driver: "cursor",
			env: { CURSOR_API_KEY: "[REDACTED:environment]" },
		});
		expect(added.instances.filter(({ driver }) => driver === "cursor")).toEqual(
			[expect.objectContaining({ available: true })],
		);
		const captured = traceRows(capturePath);
		expect(
			captured.filter(({ kind }) => kind === "models.list.call").length,
		).toBeGreaterThan(0);
		expect(
			captured.filter(({ kind }) =>
				["auth.status.call", "auth.login.call", "auth.logout.call"].includes(
					kind ?? "",
				),
			),
		).toEqual([]);
		expect(JSON.parse(readFileSync(authStatePath, "utf8"))).toEqual({
			status: { status: "logged-out" },
			credential: null,
		});
		invariants = {
			environmentKeyValidatedByCatalog: true,
			noStoredLoginStatus: true,
			noLoginOrLogout: true,
			sdkStoreUntouched: true,
		};
	}, 240_000);

	it("refreshes an existing runner and a new runner after logout and a fresh login", async () => {
		const fixture = await start("runner-credential-refresh", {
			initialCredential: true,
		});
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Cursor runner auth",
			driver: "cursor",
		});
		const accountId = added.addedInstanceId;
		if (!accountId) throw new Error("Missing Cursor account");
		const browser = await fixture.connect();
		const id = await browser.createSession(
			"Existing Cursor runner",
			accountId,
			"cursor",
			{ modelId: "composer-2.5", contextWindow: "" },
		);
		expect(
			(await browser.send(id, "Say hi before logout.", TIMEOUT)).chunks.join(
				"",
			),
		).toBe(BASIC_TEXT);
		const firstRunnerPids = fixture.runnerPids();
		expect(firstRunnerPids).toHaveLength(1);
		const initialCreate = traceRows(capturePath).find(
			({ kind }) => kind === "create.options",
		)?.data as Record<string, unknown>;
		expect(initialCreate["credentialFingerprint"]).toEqual(expect.any(String));
		await fixture.requestRpc({ _tag: "LogoutCursor" });
		await browser.send(id, "Try while logged out.", TIMEOUT);
		await vi.waitFor(
			() =>
				expect(storedTurns(fixture, id).states).toEqual(["completed", "error"]),
			{ timeout: TIMEOUT },
		);
		const failed = storedTurns(fixture, id).errors;
		expect(failed).toHaveLength(1);
		expect(failed[0]?.["code"]).toMatch(/AUTH/i);
		expect(JSON.stringify(failed[0])).toMatch(/log\s*in/i);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "send.options"),
		).toHaveLength(1);
		await completeLogin(fixture);
		expect(
			(await browser.send(id, "Say hi after login.", TIMEOUT)).chunks.join(""),
		).toBe(BASIC_TEXT);
		await vi.waitFor(
			() =>
				expect(storedTurns(fixture, id).states).toEqual([
					"completed",
					"error",
					"completed",
				]),
			{ timeout: TIMEOUT },
		);
		expect(fixture.runnerPids()).toEqual(firstRunnerPids);
		const resumed = traceRows(capturePath)
			.filter(({ kind }) => kind === "resume.options")
			.at(-1)?.data as Record<string, unknown>;
		expect(resumed["credentialFingerprint"]).toEqual(expect.any(String));
		expect(resumed["credentialFingerprint"]).not.toBe(
			initialCreate["credentialFingerprint"],
		);
		const freshId = await browser.createSession(
			"New Cursor runner",
			accountId,
			"cursor",
			{ modelId: "composer-2.5", contextWindow: "" },
		);
		expect(
			(
				await browser.send(freshId, "Say hi with the new login.", TIMEOUT)
			).chunks.join(""),
		).toBe(BASIC_TEXT);
		expect(fixture.runnerPids()).toHaveLength(2);
		const freshCreate = traceRows(capturePath)
			.filter(({ kind }) => kind === "create.options")
			.at(-1)?.data as Record<string, unknown>;
		expect(freshCreate["credentialFingerprint"]).toBe(
			resumed["credentialFingerprint"],
		);
		expect(
			(await fixture.requestRpc({ _tag: "GetInstances" })).instances.filter(
				({ driver }) => driver === "cursor",
			),
		).toEqual([expect.objectContaining({ id: accountId, available: true })]);
		invariants = {
			loggedOutTurnOffersLogin: true,
			loggedOutTurnNeverSentToSdk: true,
			existingRunnerReused: true,
			agentReopenedForCredentialFingerprint: true,
			newRunnerUsesFreshCredential: true,
			oneCursorAccountAfterLogin: true,
		};
	}, 240_000);

	it("offers login when a stored credential is rejected by a turn or discovery", async () => {
		const fixture = await start("rejected-credential", {
			initialCredential: true,
			catalogTtlMs: 1,
		});
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Cursor rejected credential",
			driver: "cursor",
		});
		const accountId = added.addedInstanceId;
		if (!accountId) throw new Error("Missing Cursor account");
		const browser = await fixture.connect();
		const id = await browser.createSession(
			"Rejected Cursor credential",
			accountId,
			"cursor",
			{ modelId: "composer-2.5", contextWindow: "" },
		);
		const replay = traceRows(tracePath);
		const sendIndex = replay.findIndex(({ kind }) => kind === "send.options");
		if (sendIndex < 0) throw new Error("Auth replay has no captured send");
		// This is the port's error envelope, not an invented SDK stream variant.
		replay.splice(sendIndex + 1, 0, {
			kind: "send.error",
			data: { authRequired: true },
		});
		writeFileSync(
			tracePath,
			`${replay.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		await browser.send(id, "Try a rejected credential.", TIMEOUT);
		await vi.waitFor(
			() => expect(storedTurns(fixture, id).states).toEqual(["error"]),
			{ timeout: TIMEOUT },
		);
		const errors = storedTurns(fixture, id).errors;
		expect(errors).toHaveLength(1);
		expect(errors[0]?.["code"]).toMatch(/AUTH/i);
		expect(JSON.stringify(errors[0])).toMatch(/log\s*in/i);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "send.error"),
		).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({ authRequired: true }),
			}),
		]);
		const terminalRejection = replay
			.filter(({ kind }) => kind !== "send.error")
			.map((row) =>
				row.kind === "wait.result"
					? {
							...row,
							data: {
								...(row.data as Record<string, unknown>),
								status: "error",
								error: {
									code: "unauthenticated",
									message: "Cursor credentials were rejected",
								},
							},
						}
					: row,
			);
		writeFileSync(
			tracePath,
			`${terminalRejection.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		await browser.send(id, "Try a terminal authentication failure.", TIMEOUT);
		await vi.waitFor(
			() => expect(storedTurns(fixture, id).states).toEqual(["error", "error"]),
			{ timeout: TIMEOUT },
		);
		const terminalErrors = storedTurns(fixture, id).errors;
		expect(terminalErrors).toHaveLength(2);
		expect(terminalErrors[1]?.["code"]).toBe("auth_required");
		expect(JSON.stringify(terminalErrors[1])).toMatch(/log\s*in/i);
		const rejectedCatalog = terminalRejection.map((row) =>
			row.kind === "models.list"
				? { ...row, kind: "models.list.error", data: { authRequired: true } }
				: row,
		);
		writeFileSync(
			tracePath,
			`${rejectedCatalog.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		expect(
			(await fixture.requestRpc({ _tag: "GetInstances" })).instances.filter(
				({ driver }) => driver === "cursor",
			),
		).toEqual([
			expect.objectContaining({
				id: accountId,
				available: false,
				unavailableReason: expect.stringMatching(
					/authentication failed.*log\s*in/i,
				),
				unavailableCode: "auth_required",
			}),
		]);
		invariants = {
			rejectedTurnIsAuthError: true,
			rejectedTurnOffersLogin: true,
			unauthenticatedRunResultOffersLogin: true,
			rejectedDiscoveryOffersLogin: true,
			errorClassPreservedAcrossPort: true,
		};
	}, 240_000);

	it("recovers a runner after sandbox priming rejects its old credential", async () => {
		const fixture = await start("sandbox-auth-recovery", {
			initialCredential: true,
		});
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Cursor sandbox auth",
			driver: "cursor",
		});
		const accountId = added.addedInstanceId;
		if (!accountId) throw new Error("Missing Cursor account");
		const browser = await fixture.connect();
		const id = await browser.createSession(
			"Cursor sandbox auth recovery",
			accountId,
			"cursor",
			{ modelId: "composer-2.5", contextWindow: "" },
		);
		const replay = traceRows(tracePath);
		replay.splice(1, 0, {
			kind: "sandbox.prime.error",
			data: { authRequired: true },
		});
		writeFileSync(
			tracePath,
			`${replay.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		await browser.send(id, "Try sandbox priming with the old key.", TIMEOUT);
		await vi.waitFor(
			() => expect(storedTurns(fixture, id).states).toEqual(["error"]),
			{ timeout: TIMEOUT },
		);
		const errors = storedTurns(fixture, id).errors;
		expect(errors).toHaveLength(1);
		expect(errors[0]?.["code"]).toMatch(/^auth_required$/i);
		expect(JSON.stringify(errors[0])).toMatch(/log\s*in/i);
		const pids = fixture.runnerPids();
		expect(pids).toHaveLength(1);
		expect(fixture.remainingRunnerPids()).toEqual(pids);
		expect(
			traceRows(capturePath).filter(({ kind }) => kind === "send.options"),
		).toEqual([]);
		writeFileSync(
			tracePath,
			`${replay
				.filter(({ kind }) => kind !== "sandbox.prime.error")
				.map((row) => JSON.stringify(row))
				.join("\n")}\n`,
		);
		await completeLogin(fixture);
		expect(
			(
				await browser.send(id, "Say hi after the new login.", TIMEOUT)
			).chunks.join(""),
		).toBe(BASIC_TEXT);
		await vi.waitFor(
			() =>
				expect(storedTurns(fixture, id).states).toEqual(["error", "completed"]),
			{ timeout: TIMEOUT },
		);
		expect(fixture.runnerPids()).toEqual(pids);
		expect(
			traceRows(capturePath).filter(
				({ kind }) => kind === "sandbox.prime.options",
			),
		).toHaveLength(2);
		invariants = {
			primingAuthErrorNotSandboxUnavailable: true,
			failedAuthNeverSentToSdk: true,
			runnerSurvivedAuthenticationFailure: true,
			loginRecoveredSameRunner: true,
			sandboxPrimingRetriedWithFreshCredential: true,
		};
	}, 240_000);
});
