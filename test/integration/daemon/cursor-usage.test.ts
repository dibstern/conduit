// Failure modes: borrowing another account's token, prompting before Enable,
// duplicate prompts, usage deadlines cancelling a prompt, stale CLI identities,
// auth renewal borrowing another subject, Disable losing to a pending Enable,
// tokens leaking into persisted/browser state, dashboard errors failing turns,
// monthly windows acquiring Claude forecasts, and cross-harness auto-switches.
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageReading } from "../../../src/lib/contracts/limit-recovery.js";
import {
	AddInstance,
	GetInstances,
	ListDaemonSessions,
	QuotaForAccounts,
	SetCursorUsageKeychain,
	SetUsageLimitsSetting,
	SubmitInput,
	UpdateInstance,
} from "../../../src/lib/contracts/ws-rpc.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;
const RESET_AT = 1_800_000_000_000;
const BASIC_TEXT =
	"Hi David — good to meet you. What would you like to work on today?";

interface FakeKeychain {
	token?: string;
	outcome?: "missing" | "denied";
	delayMs?: number;
	reads?: number;
}

interface DashboardCall {
	credential: string;
	method: string | undefined;
	path: string | undefined;
	body: string;
	connectVersion: string | undefined;
	clientType: string | undefined;
	responseStatus: number;
}

function jwt(subject: string): string {
	return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
		JSON.stringify({ sub: subject }),
	).toString("base64url")}.test`;
}

function storedState(fixture: ProcessHarness, sessionId?: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare<[], { type: string; data: string; metadata: string }>(
					"SELECT type, data, metadata FROM events ORDER BY sequence",
				)
				.all(),
			turns: sessionId
				? db
						.prepare<[string], { state: string }>(
							"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
						)
						.all(sessionId)
						.map(({ state }) => state)
				: [],
		};
	} finally {
		db.close();
	}
}

describe("Cursor monthly usage through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let dashboard: Server | undefined;
	let scenario = "setup";
	let keychainPath = "";
	let endpoint = "";
	let tracePath = "";
	let mode: "available" | "500" | "slow" | "bad-json" | "missing-plan" =
		"available";
	let totalPercentUsed = 37;
	let billingCycleEnd: number | string = String(RESET_AT);
	let dashboardCalls: DashboardCall[] = [];
	let credentials = new Map<string, string>();
	let rejectedCredentials = new Map<string, 401 | 403>();
	let diagnostics: Record<string, unknown> = {};
	const scenarios: Record<string, unknown>[] = [];

	function keychain(): FakeKeychain {
		return JSON.parse(readFileSync(keychainPath, "utf8")) as FakeKeychain;
	}

	function setKeychain(next: Omit<FakeKeychain, "reads">) {
		const reads = existsSync(keychainPath) ? (keychain().reads ?? 0) : 0;
		writeFileSync(keychainPath, JSON.stringify({ ...next, reads }));
	}

	async function restart(daemonToken?: string) {
		if (!harness) throw new Error("No process fixture");
		await harness.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CURSOR_SDK_TRACE: tracePath,
				CONDUIT_TEST_CURSOR_DASHBOARD_URL: endpoint,
				CONDUIT_TEST_CURSOR_KEYCHAIN: keychainPath,
				...(daemonToken ? { CURSOR_AUTH_TOKEN: daemonToken } : {}),
			},
		});
	}

	async function start(
		name: string,
		options: { accountToken?: string; daemonToken?: string } = {},
	) {
		scenario = name;
		diagnostics = {};
		dashboardCalls = [];
		credentials = new Map<string, string>();
		rejectedCredentials = new Map<string, 401 | 403>();
		if (options.accountToken) credentials.set(options.accountToken, "account");
		if (options.daemonToken) credentials.set(options.daemonToken, "daemon");
		mode = "available";
		totalPercentUsed = 37;
		billingCycleEnd = String(RESET_AT);
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		tracePath = join(harness.root, "cursor-replay.jsonl");
		keychainPath = join(harness.root, "fake-cursor-keychain.json");
		const rows = readFileSync(
			resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		rows.splice(1, 0, {
			kind: "credential.store",
			data: {
				apiKey: "[REDACTED]",
				backendUrl: "https://api2.cursor.sh",
				createdAtMs: 0,
			},
		});
		writeFileSync(
			tracePath,
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		const token = jwt("keychain-account");
		credentials.set(token, "keychain");
		setKeychain({ token });
		dashboard = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += String(chunk);
			const bearer = request.headers.authorization?.replace(/^Bearer /, "");
			const rejection = bearer ? rejectedCredentials.get(bearer) : undefined;
			dashboardCalls.push({
				credential: (bearer && credentials.get(bearer)) || "unexpected",
				method: request.method,
				path: request.url,
				body,
				connectVersion: request.headers["connect-protocol-version"]?.toString(),
				clientType: request.headers["x-cursor-client-type"]?.toString(),
				responseStatus: rejection ?? (mode === "500" ? 500 : 200),
			});
			if (rejection !== undefined) {
				response.writeHead(rejection, { "content-type": "application/json" });
				response.end("{}");
				return;
			}
			if (mode === "slow")
				await new Promise<void>((done) => setTimeout(done, 8_000));
			response.writeHead(mode === "500" ? 500 : 200, {
				"content-type": "application/json",
			});
			response.end(
				mode === "bad-json"
					? "{broken"
					: JSON.stringify(
							mode === "missing-plan"
								? { billingCycleEnd: "invalid" }
								: {
										planUsage: { totalPercentUsed },
										billingCycleEnd,
									},
						),
			);
		});
		await new Promise<void>((done, fail) => {
			dashboard?.once("error", fail);
			dashboard?.listen(0, "127.0.0.1", done);
		});
		const address = dashboard.address();
		if (!address || typeof address === "string")
			throw new Error("No isolated dashboard port");
		endpoint = `http://127.0.0.1:${address.port}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;
		await restart(options.daemonToken);
		const added = await harness.requestRpc(
			new AddInstance({
				name: "Cursor monthly usage",
				driver: "cursor",
				...(options.accountToken
					? { env: { CURSOR_AUTH_TOKEN: options.accountToken } }
					: {}),
			}),
		);
		if (!added.addedInstanceId) throw new Error("Missing Cursor account");
		return { fixture: harness, accountId: added.addedInstanceId, token };
	}

	async function refresh(fixture: ProcessHarness, accountId: string) {
		const readings = await fixture.requestRpc(
			new QuotaForAccounts({ projectSlug: "process-test" }),
		);
		return readings.find((reading) => reading.accountId === accountId);
	}

	async function instance(fixture: ProcessHarness, accountId: string) {
		return (await fixture.requestRpc(new GetInstances({}))).instances.find(
			(account) => account.id === accountId,
		);
	}

	function record(name: string, reading?: UsageReading) {
		scenarios.push({
			scenario: name,
			keychainReads: keychain().reads ?? 0,
			dashboardRequests: dashboardCalls.length,
			dashboardCredentials: dashboardCalls.map(({ credential }) => credential),
			dashboardStatuses: dashboardCalls.map(
				({ responseStatus }) => responseStatus,
			),
			...(reading
				? {
						status: reading.status,
						windows: reading.windows,
						reason: reading.reason,
					}
				: {}),
			...diagnostics,
		});
	}

	afterEach(async ({ task }) => {
		try {
			if (harness) {
				const fixture = harness;
				await fixture.dispose();
				expect(fixture.remainingRunnerPids()).toEqual([]);
				expect(fixture.proof().rpcDecodeFailures).toEqual([]);
				scenarios.push({
					scenario: `${scenario}:process-cleanup`,
					result: task.result?.state,
					remainingRunnerPids: fixture.remainingRunnerPids(),
					rpcDecodeFailures: fixture.proof().rpcDecodeFailures.length,
					generations: fixture.generations.map(({ pid, exitCode, signal }) => ({
						pid,
						exitCode,
						signal,
					})),
				});
			}
		} finally {
			if (dashboard) {
				dashboard.closeAllConnections();
				await new Promise<void>((done) => dashboard?.close(() => done()));
			}
			harness = undefined;
			dashboard = undefined;
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/conduit-test-xqsg.15.json",
				`${JSON.stringify({ ticket: "conduit-test-xqsg.15", sourceCapture: "test/fixtures/cursor-sdk-traces/basic.jsonl", scenarios }, null, 2)}\n`,
			);
		}
	});

	it(
		"prefers the account session token and keeps monthly windows out of Claude history",
		async () => {
			const accountToken = jwt("explicit-account");
			const daemonToken = jwt("daemon-account");
			const { fixture, accountId } = await start("explicit-account-token", {
				accountToken,
				daemonToken,
			});
			const account = await instance(fixture, accountId);
			expect(account?.usageEligible).toBe(true);
			expect(account?.cursorUsageSource).toBe("token");
			expect(JSON.stringify(account).includes(accountToken)).toBe(false);
			expect(JSON.stringify(account).includes(daemonToken)).toBe(false);
			const reading = await refresh(fixture, accountId);
			expect(reading).toMatchObject({
				status: "available",
				harness: "cursor",
				windows: [
					{
						kind: "month",
						utilization: 37,
						resetsAt: new Date(RESET_AT).toISOString(),
					},
				],
			});
			expect(reading?.windows[0]).not.toHaveProperty("history");
			expect(reading?.windows[0]).not.toHaveProperty("forecast");
			expect(dashboardCalls).toEqual([
				{
					credential: "account",
					method: "POST",
					path: "/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
					body: "{}",
					connectVersion: "1",
					clientType: "cli",
					responseStatus: 200,
				},
			]);
			expect(keychain().reads).toBe(0);
			await Promise.all([
				refresh(fixture, accountId),
				refresh(fixture, accountId),
			]);
			expect(dashboardCalls).toHaveLength(1);
			record("a:explicit-account-token", reading);
		},
		TIMEOUT,
	);

	it.each([
		{ percent: 125, utilization: 100, state: "limited", reset: -1 },
		{ percent: -25, utilization: 0, state: "available", reset: "invalid" },
	] as const)(
		"clamps $percent percent and omits invalid billing resets",
		async ({ percent, utilization, state, reset }) => {
			const { fixture, accountId } = await start(`clamp-${percent}`, {
				accountToken: jwt("explicit-account"),
			});
			totalPercentUsed = percent;
			billingCycleEnd = reset;
			const reading = await refresh(fixture, accountId);
			expect(reading).toMatchObject({
				status: state,
				windows: [{ kind: "month", utilization }],
			});
			expect(reading?.windows[0]).not.toHaveProperty("resetsAt");
			record(`clamp-${percent}`, reading);
		},
		TIMEOUT,
	);

	it(
		"uses the daemon token without borrowing a Keychain login",
		async () => {
			const { fixture, accountId } = await start("daemon-token", {
				daemonToken: jwt("daemon-account"),
			});
			const reading = await refresh(fixture, accountId);
			expect(reading?.status).toBe("available");
			expect(dashboardCalls.map(({ credential }) => credential)).toEqual([
				"daemon",
			]);
			expect(keychain().reads).toBe(0);
			record("daemon-token", reading);
		},
		TIMEOUT,
	);

	it(
		"does not read the Keychain or enroll accounts before Enable",
		async () => {
			const { fixture, accountId } = await start("not-enabled");
			const account = await instance(fixture, accountId);
			expect(account).toMatchObject({
				usageEligible: false,
				cursorUsageSource: "can_enable",
			});
			expect(await refresh(fixture, accountId)).toBeUndefined();
			expect(keychain().reads).toBe(0);
			expect(dashboardCalls).toHaveLength(0);
			diagnostics = {
				usageEligible: account?.usageEligible,
				cursorUsageSource: account?.cursorUsageSource,
			};
			record("b:not-enabled");
		},
		TIMEOUT,
	);

	it(
		"joins Enable reads, keeps only the subject hash, reuses memory and disables cleanly",
		async () => {
			const { fixture, accountId, token } = await start("enable-and-cache");
			setKeychain({ token, delayMs: 750 });
			const enabled = await Promise.all([
				fixture.requestRpc(
					new SetCursorUsageKeychain({ accountId, enabled: true }),
				),
				fixture.requestRpc(
					new SetCursorUsageKeychain({ accountId, enabled: true }),
				),
			]);
			expect(enabled).toEqual([{ enabled: true }, { enabled: true }]);
			expect(keychain().reads).toBe(1);
			const reading = await refresh(fixture, accountId);
			expect(reading?.status).toBe("available");
			await Promise.all([
				refresh(fixture, accountId),
				refresh(fixture, accountId),
			]);
			expect(keychain().reads).toBe(1);
			expect(dashboardCalls).toHaveLength(1);
			const account = await instance(fixture, accountId);
			expect(account).toMatchObject({
				usageEligible: true,
				cursorUsageSource: "keychain",
			});
			const configPath = join(fixture.configDir, "daemon.json");
			const config = readFileSync(configPath, "utf8");
			const subjectHash = createHash("sha256")
				.update("keychain-account")
				.digest("hex");
			expect(
				(JSON.parse(config) as Record<string, unknown>)["cursorUsageBinding"],
			).toEqual({ accountId, subjectHash });
			expect(config.includes(subjectHash)).toBe(true);
			expect(config.includes("keychain-account")).toBe(false);
			expect(config.includes(token)).toBe(false);
			expect(statSync(configPath).mode & 0o777).toBe(0o600);
			const browser = await fixture.connect();
			const sessionId = await browser.createSession(
				"No credential in events",
				accountId,
				"cursor",
				{
					modelId: "composer-2.5",
					contextWindow: "",
				},
			);
			expect(
				(await browser.send(sessionId, "Say hi.", TIMEOUT)).chunks.join(""),
			).toBe(BASIC_TEXT);
			const serialized = JSON.stringify({
				instances: await fixture.requestRpc(new GetInstances({})),
				state: storedState(fixture, sessionId),
				frames: fixture.proof().frames,
				logs: fixture.logTail,
			});
			expect(serialized.includes(token)).toBe(false);
			expect(serialized.includes(subjectHash)).toBe(false);
			diagnostics = {
				tokenAbsentFromConfigEventsBrowserLogs: true,
				configMode: "0600",
				usageEligible: account?.usageEligible,
				cursorUsageSource: account?.cursorUsageSource,
			};
			record("c:enable-and-cache", reading);
			expect(
				await fixture.requestRpc(
					new SetCursorUsageKeychain({ accountId, enabled: false }),
				),
			).toEqual({ enabled: false });
			const disabledAccount = await instance(fixture, accountId);
			expect(disabledAccount).toMatchObject({
				usageEligible: false,
				cursorUsageSource: "can_enable",
			});
			expect(await refresh(fixture, accountId)).toBeUndefined();
			expect(keychain().reads).toBe(1);
			expect(readFileSync(configPath, "utf8").includes(subjectHash)).toBe(
				false,
			);
			diagnostics = {
				...diagnostics,
				usageEligible: disabledAccount?.usageEligible,
				cursorUsageSource: disabledAccount?.cursorUsageSource,
			};
			record("disable");
		},
		TIMEOUT,
	);

	it(
		"leaves a background Keychain read alive after a brief unavailable reading",
		async () => {
			const { fixture, accountId, token } = await start("background-prompt");
			await fixture.requestRpc(
				new SetCursorUsageKeychain({ accountId, enabled: true }),
			);
			await fixture.kill();
			setKeychain({ token, delayMs: 2_000 });
			await restart();
			const pending = await refresh(fixture, accountId);
			expect(pending).toMatchObject({
				status: "unknown",
				reason: "Waiting for Keychain access on this Mac",
			});
			expect(keychain().reads).toBe(2);
			await refresh(fixture, accountId);
			expect(keychain().reads).toBe(2);
			let reading: UsageReading | undefined;
			await vi.waitFor(
				async () => {
					reading = await refresh(fixture, accountId);
					expect(reading?.status).toBe("available");
				},
				{ timeout: 15_000, interval: 300 },
			);
			expect(keychain().reads).toBe(2);
			diagnostics = {
				waitingReason: pending?.reason,
				waitingStatus: pending?.status,
			};
			record("detached-background-read", reading);
		},
		TIMEOUT,
	);

	it(
		"rejects a changed CLI subject after restart without sending its token to the dashboard",
		async () => {
			const { fixture, accountId } = await start("subject-mismatch");
			await fixture.requestRpc(
				new SetCursorUsageKeychain({ accountId, enabled: true }),
			);
			expect((await refresh(fixture, accountId))?.status).toBe("available");
			expect(dashboardCalls).toHaveLength(1);
			await fixture.kill();
			const changed = jwt("different-cli-account");
			credentials.set(changed, "changed-keychain");
			setKeychain({ token: changed });
			await restart();
			const reading = await refresh(fixture, accountId);
			expect(reading).toMatchObject({
				status: "unavailable",
				reason:
					"The Cursor CLI is now signed in to a different account. Enable again to use it.",
			});
			expect(keychain().reads).toBe(2);
			expect(dashboardCalls).toHaveLength(1);
			expect(
				dashboardCalls.some(
					({ credential }) => credential === "changed-keychain",
				),
			).toBe(false);
			record("d:subject-mismatch", reading);
		},
		TIMEOUT,
	);

	it.each([401, 403] as const)(
		"rereads the Keychain once after dashboard %s and accepts a renewed token for the same subject",
		async (httpStatus) => {
			const { fixture, accountId, token } = await start(
				`auth-renewal-${httpStatus}`,
			);
			await fixture.requestRpc(
				new SetCursorUsageKeychain({ accountId, enabled: true }),
			);
			expect(keychain().reads).toBe(1);
			const renewed = `${token}-renewed`;
			credentials.set(renewed, "renewed-keychain");
			setKeychain({ token: renewed });
			rejectedCredentials.set(token, httpStatus);
			const reading = await refresh(fixture, accountId);
			expect(reading).toMatchObject({
				status: "available",
				windows: [{ kind: "month", utilization: 37 }],
			});
			expect(keychain().reads).toBe(2);
			expect(dashboardCalls.map(({ credential }) => credential)).toEqual([
				"keychain",
				"renewed-keychain",
			]);
			expect(dashboardCalls[0]?.responseStatus).toBe(httpStatus);
			await refresh(fixture, accountId);
			expect(keychain().reads).toBe(2);
			expect(dashboardCalls).toHaveLength(2);
			record(`auth-renewal-${httpStatus}`, reading);
		},
		TIMEOUT,
	);

	it.each([401, 403] as const)(
		"rejects another CLI subject on dashboard %s renewal before sending its token",
		async (httpStatus) => {
			const { fixture, accountId, token } = await start(
				`auth-mismatch-${httpStatus}`,
			);
			await fixture.requestRpc(
				new SetCursorUsageKeychain({ accountId, enabled: true }),
			);
			const changed = jwt("different-cli-account");
			credentials.set(changed, "changed-keychain");
			setKeychain({ token: changed });
			rejectedCredentials.set(token, httpStatus);
			const reading = await refresh(fixture, accountId);
			expect(reading).toMatchObject({
				status: "unavailable",
				reason:
					"The Cursor CLI is now signed in to a different account. Enable again to use it.",
			});
			expect(keychain().reads).toBe(2);
			expect(dashboardCalls.map(({ credential }) => credential)).toEqual([
				"keychain",
			]);
			expect(dashboardCalls[0]?.responseStatus).toBe(httpStatus);
			expect(
				dashboardCalls.some(
					({ credential }) => credential === "changed-keychain",
				),
			).toBe(false);
			record(`auth-mismatch-${httpStatus}`, reading);
		},
		TIMEOUT,
	);

	it(
		"keeps usage disabled when Disable arrives while Enable is waiting for the Keychain",
		async () => {
			const { fixture, accountId, token } = await start(
				"disable-pending-enable",
			);
			setKeychain({ token, delayMs: 2_000 });
			const enabling = fixture.requestRpc(
				new SetCursorUsageKeychain({ accountId, enabled: true }),
			);
			await vi.waitFor(() => expect(keychain().reads).toBe(1), {
				timeout: 10_000,
				interval: 50,
			});
			expect(
				await fixture.requestRpc(
					new SetCursorUsageKeychain({ accountId, enabled: false }),
				),
			).toEqual({ enabled: false });
			const result = await enabling;
			expect(result).toMatchObject({ enabled: false });
			expect(result.reason).toEqual(expect.stringMatching(/settings changed/i));
			expect(await instance(fixture, accountId)).toMatchObject({
				usageEligible: false,
				cursorUsageSource: "can_enable",
			});
			expect(await refresh(fixture, accountId)).toBeUndefined();
			expect(
				(
					JSON.parse(
						readFileSync(join(fixture.configDir, "daemon.json"), "utf8"),
					) as Record<string, unknown>
				)["cursorUsageBinding"],
			).toBeUndefined();
			expect(keychain().reads).toBe(1);
			expect(dashboardCalls).toHaveLength(0);
			diagnostics = {
				enabled: result.enabled,
				reason: result.reason,
				usageEligible: false,
			};
			record("disable-pending-enable");
		},
		TIMEOUT,
	);

	it.each(["500", "slow", "bad-json", "missing-plan"] as const)(
		"fails soft for dashboard %s while a Cursor turn completes",
		async (failure) => {
			const { fixture, accountId } = await start(`dashboard-${failure}`, {
				accountToken: jwt("explicit-account"),
			});
			mode = failure;
			const browser = await fixture.connect();
			const sessionId = await browser.createSession(
				`Dashboard ${failure} is not a turn failure`,
				accountId,
				"cursor",
				{ modelId: "composer-2.5", contextWindow: "" },
			);
			const [reading, turn] = await Promise.all([
				refresh(fixture, accountId),
				browser.send(sessionId, "Say hi despite unavailable usage.", TIMEOUT),
			]);
			expect(["unavailable", "unknown"]).toContain(reading?.status);
			expect(reading?.reason).toEqual(expect.stringMatching(/.+/));
			expect(reading?.windows).toEqual([]);
			expect(turn.chunks.join("")).toBe(BASIC_TEXT);
			await vi.waitFor(
				() =>
					expect(storedState(fixture, sessionId).turns).toEqual(["completed"]),
				{ timeout: TIMEOUT, interval: 100 },
			);
			expect(keychain().reads).toBe(0);
			diagnostics = { turnStatuses: storedState(fixture, sessionId).turns };
			record(`e:dashboard-${failure}`, reading);
		},
		TIMEOUT,
	);

	it(
		"returns short Enable failures without changing eligibility",
		async () => {
			const { fixture, accountId } = await start("enable-failures");
			for (const outcome of ["missing", "denied"] as const) {
				setKeychain({ outcome });
				const result = await fixture.requestRpc(
					new SetCursorUsageKeychain({ accountId, enabled: true }),
				);
				expect(result.enabled).toBe(false);
				expect(result.reason).toEqual(
					expect.stringMatching(
						outcome === "missing"
							? /isn't signed in.*cursor-agent login/
							: /denied/i,
					),
				);
				expect((await instance(fixture, accountId))?.usageEligible).toBe(false);
				expect(dashboardCalls).toHaveLength(0);
				diagnostics = {
					outcome,
					enabled: result.enabled,
					reason: result.reason,
				};
				record(`enable-${outcome}`);
			}
			expect(keychain().reads).toBe(2);
		},
		TIMEOUT,
	);

	it(
		"auto-switches a limited Claude session only to another Claude account",
		async () => {
			const { fixture, accountId } = await start("same-harness-failover", {
				accountToken: jwt("explicit-account"),
			});
			await fixture.requestRpc(
				new UpdateInstance({
					instanceId: "claude",
					env: { ANTHROPIC_API_KEY: "fake-api-key" },
				}),
			);
			expect((await instance(fixture, "claude"))?.usageEligible).toBe(false);
			const fallbackFolder = join(fixture.root, "claude-fallback");
			mkdirSync(fallbackFolder);
			const fallback = await fixture.requestRpc(
				new AddInstance({
					name: "Claude fallback",
					driver: "claude",
					configDir: fallbackFolder,
				}),
			);
			if (!fallback.addedInstanceId) throw new Error("Missing Claude fallback");
			await fixture.requestRpc(
				new SetUsageLimitsSetting({
					usageLimits: {
						autoSwitch: true,
						autoResume: false,
						order: [accountId, fallback.addedInstanceId],
						warnAt: 80,
					},
				}),
			);
			const reading = await refresh(fixture, accountId);
			expect(reading?.status).toBe("available");
			const browser = await fixture.connect();
			const sessionId = await browser.createSession(
				"Claude must stay on Claude",
				"claude",
			);
			await fixture.requestRpc(
				new SubmitInput({
					sessionId,
					inputId: randomUUID(),
					delivery: "queue",
					text: "usage-limit-account-1-no-reset",
				}),
			);
			await vi.waitFor(
				async () => {
					const sessions = await fixture.requestRpc(
						new ListDaemonSessions({ projectSlug: "process-test" }),
					);
					const session = sessions.sessions.find(({ id }) => id === sessionId);
					expect(session?.resumes?.at(-1)).toMatchObject({
						instanceId: fallback.addedInstanceId,
						reason: "auto-switch",
					});
				},
				{ timeout: TIMEOUT, interval: 200 },
			);
			const resumed = storedState(fixture, sessionId)
				.events.filter(({ type }) => type === "session.resumed")
				.map(({ data }) => JSON.parse(data) as Record<string, unknown>);
			expect(resumed).toHaveLength(1);
			expect(resumed[0]).toMatchObject({
				instanceId: fallback.addedInstanceId,
				reason: "auto-switch",
			});
			expect(resumed.some((event) => event["instanceId"] === accountId)).toBe(
				false,
			);
			diagnostics = {
				sourceUsageEligible: false,
				eligibleCursorFirst: true,
				resumedHarness: "claude",
				autoSwitches: resumed.length,
			};
			record("f:same-harness-failover", reading);
		},
		TIMEOUT,
	);
});
