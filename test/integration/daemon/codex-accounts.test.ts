// Failure modes: shared credentials, inherited API keys overriding named logins,
// stale authentication after login/logout or external auth-file changes, callbacks
// after cancellation, and account switches silently retaining the original home.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerTraceReport } from "../../../src/lib/provider/codex/app-server/trace-player.js";
import { readCodexSessionIdentity } from "../../../src/lib/provider/codex/codex-session-store.js";
import {
	codexModels,
	fixtureRows,
	rows,
	signedInCodexDiscoveryTrace,
	snapshot,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;
const MODEL = "gpt-6.1-sol";
const KEYS = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"];
interface TransportRecord {
	home: string;
	scenario: string;
	environmentKeys: string[];
}

describe("Codex accounts through the built daemon and detached runners", () => {
	let harness: ProcessHarness | undefined;
	let artifactRoot = "";
	let reportPath = "";
	let transportPath = "";
	let mapPath = "";
	let gatePath = "";
	let baseHome = "";
	let captures: Record<
		string,
		Record<string, { trace: string; capture: string }>
	>;
	const sessionIds: string[] = [];

	function trace(home: string, scenario: string, source: TraceRow[]) {
		const accountTraces = (captures[home] ??= {});
		const id = `${Object.keys(captures).indexOf(home)}-${scenario}`;
		const path = join(artifactRoot, `${id}-source.jsonl`);
		const capture = join(artifactRoot, `${id}-capture.jsonl`);
		writeFileSync(
			path,
			`${source.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		accountTraces[scenario] = { trace: path, capture };
		writeFileSync(mapPath, JSON.stringify(captures));
		return capture;
	}

	function readOnlyTrace(signedIn: boolean): TraceRow[] {
		const source = signedInCodexDiscoveryTrace();
		const end = source.findIndex(
			({ message }) => message?.method === "model/list",
		);
		const selected = source.slice(0, end);
		if (!signedIn) {
			const result = selected.find(
				({ message }) => message?.result?.["account"],
			)?.message?.result;
			if (!result) throw new Error("Missing account/read");
			result["account"] = null;
		}
		return selected;
	}

	async function start(name: string, signedIn = true) {
		artifactRoot = resolve(`test-results/codex-accounts/${name}`);
		mkdirSync(artifactRoot, { recursive: true });
		reportPath = join(artifactRoot, "trace-report.jsonl");
		transportPath = join(artifactRoot, "transports.jsonl");
		writeFileSync(reportPath, "");
		writeFileSync(transportPath, "");
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			logLevel: "warn",
		});
		const fixture = harness;
		mapPath = join(fixture.root, "codex-trace-map.json");
		gatePath = join(fixture.root, "codex-gate");
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		baseHome = join(fixture.root, "home", ".codex");
		mkdirSync(join(baseHome, "sessions"), { recursive: true });
		mkdirSync(join(baseHome, "skills"), { recursive: true });
		writeFileSync(join(baseHome, "config.toml"), "model = 'gpt-6.1-sol'\n");
		writeFileSync(join(baseHome, "AGENTS.md"), "Temporary account fixture.\n");
		// Synthetic content only. Never open or copy the user's Codex credentials.
		writeFileSync(
			join(baseHome, "auth.json"),
			JSON.stringify({ fixture: "base-only" }),
		);
		captures = {};
		const discovery = signedIn
			? signedInCodexDiscoveryTrace()
			: fixtureRows("model-list");
		trace("*", "codex-discovery", discovery);
		trace("*", "codex-discovery-auth", readOnlyTrace(signedIn));
		trace("*", "codex-auth", readOnlyTrace(signedIn));
		trace("*", "codex-usage", fixtureRows("usage-read"));
		const restartOptions = {
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			continuationSweepIntervalMs: 100,
			serviceEnvironment: {
				CONDUIT_TEST_CODEX_TRACE_MAP: mapPath,
				CONDUIT_TEST_CODEX_TRANSPORTS: transportPath,
				CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: reportPath,
				CONDUIT_CODEX_APP_SERVER_TRACE_GATE: gatePath,
				OPENAI_API_KEY: "fixture-openai",
				CODEX_API_KEY: "fixture-codex",
				CODEX_ACCESS_TOKEN: "fixture-access-token",
			},
		};
		await fixture.restart(restartOptions);
		return { fixture, browser: await fixture.connect(), restartOptions };
	}

	async function add(fixture: ProcessHarness, name: string, folder?: string) {
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			name,
			driver: "codex",
			...(folder ? { configDir: folder } : {}),
		});
		if (!added.addedInstanceId) throw new Error("Missing named Codex account");
		const id = added.addedInstanceId;
		return {
			id,
			home:
				folder ??
				join(fixture.configDir, "codex", "accounts", encodeURIComponent(id)),
		};
	}

	async function expectHandoff(
		fixture: ProcessHarness,
		sessionId: string,
		accountId: string,
		continuationKind: "native-thread" | "transcript-digest",
	) {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			const resume = db
				.prepare<[string, string], { at: number }>(
					"SELECT created_at AS at FROM events WHERE session_id = ? AND type = 'session.resumed' AND json_extract(data, '$.instanceId') = ? ORDER BY sequence DESC LIMIT 1",
				)
				.get(sessionId, accountId);
			if (!resume) throw new Error("Missing durable account continuation");
			const handoff = await vi.waitFor(
				async () => {
					const result = await fixture.requestRpc({
						_tag: "GetContinuationHandoff",
						sessionId,
						instanceId: accountId,
						at: resume.at,
					});
					expect(result.handoff).toMatchObject({
						continuationKind,
						instanceId: accountId,
					});
					return result.handoff;
				},
				{ timeout: TIMEOUT, interval: 100 },
			);
			const delivered = db
				.prepare<[string], { id: string; data: string }>(
					"SELECT event_id AS id, data FROM events WHERE session_id = ? AND type = 'session.handoff_delivered' ORDER BY sequence",
				)
				.all(sessionId);
			expect(delivered).toHaveLength(1);
			const commands = db
				.prepare<[string, string], { command_id: string }>(
					`SELECT DISTINCT o.command_id FROM provider_command_outbox o
					 JOIN events e ON e.session_id = o.session_id AND json_extract(e.metadata, '$.runId') = o.run_id
					 WHERE o.session_id = ? AND o.effect_type = 'send_turn' AND o.status = 'completed'
					 AND e.type = 'turn.completed' AND json_extract(e.data, '$.continuationKind') = ?
					 AND json_type(o.payload_json, '$.handoff') IS NULL`,
				)
				.all(sessionId, continuationKind);
			expect(commands).toHaveLength(1);
			expect(delivered[0]?.id).toBe(
				`evt_codex_handoff_delivered_${commands[0]?.command_id}`,
			);
			expect(delivered[0]?.id).toBe(handoff?.eventId);
			expect(JSON.parse(delivered[0]?.data ?? "null")).toMatchObject({
				continuationKind,
				instanceId: accountId,
				included: 0,
				omitted: 0,
				firstMessageIncluded: false,
				tokens: 0,
			});
			writeFileSync(
				join(artifactRoot, `${continuationKind}-handoff.json`),
				`${JSON.stringify({ resumeAt: resume.at, handoff, delivered: delivered.map(({ id, data }) => ({ id, data: JSON.parse(data) as unknown })) }, null, 2)}\n`,
			);
			const events = snapshot(fixture, sessionId).events;
			expect(events.filter(({ type }) => type === "message.snapshot")).toEqual(
				[],
			);
			expect(JSON.stringify(events)).not.toContain("Conduit notice:");
		} finally {
			db.close();
		}
	}

	function holdTurnCompletion(source: TraceRow[]) {
		const terminal = source.findIndex(
			({ message }) => message?.method === "turn/completed",
		);
		if (terminal < 0) throw new Error("Missing captured turn completion");
		const heldAt = 1_000_000_000;
		for (const [index, row] of source.entries())
			if (index >= terminal && row.dir) row["at"] = heldAt + index;
		writeFileSync(gatePath, String(heldAt - 1));
	}

	async function restartDuringContinuation(
		fixture: ProcessHarness,
		sessionId: string,
		capture: string,
		restartOptions: NonNullable<Parameters<ProcessHarness["restart"]>[0]>,
	) {
		await vi.waitFor(
			() =>
				expect(
					rows<TraceRow>(capture).some(
						({ dir, message }) =>
							dir === "out" && message?.method === "turn/start",
					),
				).toBe(true),
			{ timeout: TIMEOUT, interval: 100 },
		);
		expect(
			rows<TraceRow>(capture).some(
				({ dir, message }) =>
					dir === "in" && message?.method === "turn/completed",
			),
		).toBe(false);
		expect(
			snapshot(fixture, sessionId).events.filter(
				({ type }) => type === "session.handoff_delivered",
			),
		).toEqual([]);
		const identity = readCodexSessionIdentity(fixture.configDir, sessionId);
		if (!identity) throw new Error("Missing running continuation identity");
		const runnerPid = identity.controllerPid;
		expect(fixture.remainingRunnerPids()).toContain(runnerPid);
		await fixture.kill();
		expect(fixture.remainingRunnerPids()).toContain(runnerPid);
		await fixture.restart(restartOptions);
		expect(fixture.remainingRunnerPids()).toContain(runnerPid);
		expect(
			readCodexSessionIdentity(fixture.configDir, sessionId)?.controllerPid,
		).toBe(runnerPid);
		const browser = await fixture.connect(sessionId);
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		return browser;
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		const states = sessionIds.map((id) => ({ id, ...snapshot(fixture, id) }));
		try {
			await fixture.dispose();
			const reports = rows<AppServerTraceReport>(reportPath);
			expect(reports.length).toBeGreaterThan(0);
			for (const report of reports) {
				expect(report.consumed, report.scenario).toBe(report.total);
				expect(report.mismatches, report.scenario).toEqual([]);
				expect(report.unconsumed, report.scenario).toEqual([]);
			}
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			writeFileSync(
				join(artifactRoot, "evidence.json"),
				`${JSON.stringify(
					{
						result: task.result?.state,
						states,
						reports: rows<AppServerTraceReport>(reportPath),
						transports: rows<TransportRecord>(transportPath),
						process: fixture.proof(),
					},
					null,
					2,
				)}\n`,
			);
			harness = undefined;
			sessionIds.length = 0;
		}
	});

	it(
		"runs two named accounts in private homes sharing the base rollout directory",
		async () => {
			const { fixture, browser } = await start("independent-homes");
			const first = await add(fixture, "Work");
			const second = await add(fixture, "Personal");
			for (const account of [first, second]) {
				await codexModels(browser, account.id);
				for (const name of ["sessions", "config.toml", "skills", "AGENTS.md"]) {
					expect(lstatSync(join(account.home, name)).isSymbolicLink()).toBe(
						true,
					);
					expect(realpathSync(join(account.home, name))).toBe(
						realpathSync(join(baseHome, name)),
					);
				}
				expect(existsSync(join(account.home, "auth.json"))).toBe(false);
				writeFileSync(
					join(account.home, "auth.json"),
					JSON.stringify({ fixture: account.id }),
				);
				const source = fixtureRows("basic");
				const original = source.find(
					({ message }) => message?.method === "turn/start",
				)?.message?.params?.["threadId"];
				if (typeof original !== "string")
					throw new Error("Missing recorded thread");
				trace(
					account.home,
					"codex-turn",
					JSON.parse(
						JSON.stringify(source).replaceAll(original, randomUUID()),
					) as TraceRow[],
				);
				const id = await browser.createSession(
					account.id,
					account.id,
					"codex",
					{ modelId: MODEL, contextWindow: "", permissionMode: "ask" },
				);
				sessionIds.push(id);
				expect(
					(await browser.send(id, "Say hello", TIMEOUT)).chunks.join(""),
				).toBe("Hello from the mock model.");
			}
			expect(readFileSync(join(first.home, "auth.json"), "utf8")).not.toBe(
				readFileSync(join(second.home, "auth.json"), "utf8"),
			);
			expect(
				JSON.parse(readFileSync(join(baseHome, "auth.json"), "utf8")),
			).toEqual({ fixture: "base-only" });
			writeFileSync(join(first.home, "models_cache.json"), "{}\n");
			expect(existsSync(join(second.home, "models_cache.json"))).toBe(false);
			expect(existsSync(join(baseHome, "models_cache.json"))).toBe(false);
			const transports = rows<TransportRecord>(transportPath);
			for (const account of [first, second]) {
				const opened = transports.filter(({ home }) => home === account.home);
				expect(opened.some(({ scenario }) => scenario === "codex-turn")).toBe(
					true,
				);
				for (const child of opened)
					for (const key of KEYS)
						expect(child.environmentKeys).not.toContain(key);
			}
			const native = transports.find(({ home }) => home === baseHome);
			for (const key of KEYS) expect(native?.environmentKeys).toContain(key);
		},
		TIMEOUT,
	);

	it(
		"repairs shared links idempotently and preserves a real shared-path conflict with a diagnostic",
		async () => {
			const { fixture, browser } = await start("shadow-link-repair");
			const account = await add(fixture, "Repair links");
			await codexModels(browser, account.id);
			const unchanged = lstatSync(join(account.home, "config.toml")).ino;
			for (const name of ["sessions", "skills", "AGENTS.md"])
				unlinkSync(join(account.home, name));
			const wrong = join(fixture.root, "wrong-sessions");
			mkdirSync(wrong);
			symlinkSync(wrong, join(account.home, "sessions"));
			symlinkSync(
				join(fixture.root, "missing-skills"),
				join(account.home, "skills"),
			);
			writeFileSync(join(account.home, "AGENTS.md"), "Keep the user's file.\n");
			await browser.instances();
			await codexModels(browser, account.id);
			for (const name of ["sessions", "skills"])
				expect(realpathSync(join(account.home, name))).toBe(
					realpathSync(join(baseHome, name)),
				);
			expect(lstatSync(join(account.home, "config.toml")).ino).toBe(unchanged);
			expect(lstatSync(join(account.home, "AGENTS.md")).isSymbolicLink()).toBe(
				false,
			);
			expect(readFileSync(join(account.home, "AGENTS.md"), "utf8")).toBe(
				"Keep the user's file.\n",
			);
			expect(fixture.proof().logTail).toContain("codex.shared_path_conflict");
		},
		TIMEOUT,
	);

	it(
		"passes a named Codex home and no inherited API credentials to an actual terminal child",
		async () => {
			const { fixture, browser } = await start("terminal-credentials");
			const account = await add(fixture, "Terminal account");
			const pty = await browser.createPty(account.id);
			const path = join(artifactRoot, "terminal-environment.json");
			const shellQuote = (value: string) =>
				`'${value.replaceAll("'", "'\\''")}'`;
			const program = `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({home:process.env.CODEX_HOME,keys:Object.keys(process.env).filter(k=>${JSON.stringify(KEYS)}.includes(k))}))`;
			await browser.inputPty(
				pty.id,
				`${shellQuote(process.execPath)} -e ${shellQuote(program)} ${shellQuote(path)}\n`,
			);
			await vi.waitFor(
				() =>
					expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
						home: account.home,
						keys: [],
					}),
				{ timeout: TIMEOUT, interval: 100 },
			);
			await browser.closePty(pty.id);
		},
		TIMEOUT,
	);

	it(
		"uses a configured home as-is and still strips inherited OpenAI keys",
		async () => {
			const { fixture, browser } = await start("configured-home");
			const folder = join(fixture.root, "configured-codex");
			mkdirSync(folder);
			writeFileSync(join(folder, "AGENTS.md"), "Preserve this file.\n");
			const account = await add(fixture, "Existing", folder);
			await codexModels(browser, account.id);
			expect(lstatSync(join(folder, "AGENTS.md")).isSymbolicLink()).toBe(false);
			expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).toBe(
				"Preserve this file.\n",
			);
			expect(existsSync(join(folder, "sessions"))).toBe(false);
			const child = rows<TransportRecord>(transportPath).find(
				({ home }) => home === folder,
			);
			expect(child).toBeDefined();
			for (const key of KEYS) expect(child?.environmentKeys).not.toContain(key);
		},
		TIMEOUT,
	);

	it(
		"completes device-code login and refreshes a cached signed-out account immediately",
		async () => {
			const { fixture, browser } = await start("device-login", false);
			const account = await add(fixture, "Device login");
			expect(
				(await browser.instances()).instances.find(
					({ id }) => id === account.id,
				)?.available,
			).toBe(false);
			const loginTrace = fixtureRows("login-device-code");
			trace(account.home, "codex-login", loginTrace);
			const completion = loginTrace.find(
				({ message }) => message?.method === "account/login/completed",
			);
			writeFileSync(gatePath, String(Number(completion?.["at"]) - 1));
			const pending = await fixture.requestRpc({
				_tag: "StartCodexLogin",
				accountId: account.id,
				method: "device-code",
			});
			expect(pending.login).toMatchObject({
				state: "pending",
				method: "device-code",
				userCode: "ABCD-EFGH",
				verificationUrl: "https://auth.openai.com/codex/device",
			});
			trace(account.home, "codex-discovery", signedInCodexDiscoveryTrace());
			trace(account.home, "codex-discovery-auth", readOnlyTrace(true));
			trace(account.home, "codex-auth", readOnlyTrace(true));
			writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
			await vi.waitFor(
				async () =>
					expect(
						await fixture.requestRpc({
							_tag: "GetCodexAuth",
							accountId: account.id,
						}),
					).toMatchObject({
						status: "logged-in",
						login: { state: "complete" },
					}),
				{ timeout: TIMEOUT, interval: 100 },
			);
			await vi.waitFor(
				async () =>
					expect(
						(await browser.instances()).instances.find(
							({ id }) => id === account.id,
						)?.available,
					).toBe(true),
				{ timeout: TIMEOUT, interval: 100 },
			);
		},
		TIMEOUT,
	);

	it(
		"refreshes authentication when a named home's auth.json changes without fetching models again",
		async () => {
			const { fixture, browser } = await start("external-login-refresh", false);
			const account = await add(fixture, "External login");
			expect(
				(await browser.instances()).instances.find(
					({ id }) => id === account.id,
				)?.available,
			).toBe(false);
			const capture = trace(
				account.home,
				"codex-discovery-auth",
				readOnlyTrace(true),
			);
			writeFileSync(
				join(account.home, "auth.json"),
				JSON.stringify({ fixture: "external-login" }),
			);
			const future = new Date(Date.now() + 2_000);
			utimesSync(join(account.home, "auth.json"), future, future);
			await vi.waitFor(
				async () =>
					expect(
						(await browser.instances()).instances.find(
							({ id }) => id === account.id,
						)?.available,
					).toBe(true),
				{ timeout: TIMEOUT, interval: 100 },
			);
			expect(
				rows<TraceRow>(capture).filter(
					({ message }) => message?.method === "model/list",
				),
			).toEqual([]);
		},
		TIMEOUT,
	);

	it(
		"cancels browser login with its native login id and ends pending state",
		async () => {
			const { fixture } = await start("cancel-login", false);
			const account = await add(fixture, "Cancel login");
			const capture = trace(
				account.home,
				"codex-login",
				fixtureRows("login-cancel"),
			);
			const pending = await fixture.requestRpc({
				_tag: "StartCodexLogin",
				accountId: account.id,
				method: "browser",
			});
			expect(pending.login.state).toBe("pending");
			expect(pending.login.url).toMatch(/^https:\/\/auth\.openai\.com\//);
			expect(
				await fixture.requestRpc({
					_tag: "CancelCodexLogin",
					accountId: account.id,
				}),
			).toMatchObject({ login: { state: "cancelled" } });
			const cancel = rows<TraceRow>(capture).find(
				({ message }) => message?.method === "account/login/cancel",
			);
			expect(cancel?.message?.params).toEqual({
				loginId: pending.login.loginId,
			});
		},
		TIMEOUT,
	);

	it(
		"logs out only the selected account and invalidates its cached authentication",
		async () => {
			const { fixture, browser } = await start("logout");
			const first = await add(fixture, "Sign out");
			const second = await add(fixture, "Stay signed in");
			await codexModels(browser, first.id);
			await codexModels(browser, second.id);
			trace(first.home, "codex-logout", fixtureRows("logout"));
			trace(first.home, "codex-discovery-auth", readOnlyTrace(false));
			trace(first.home, "codex-auth", readOnlyTrace(false));
			const out = await fixture.requestRpc({
				_tag: "LogoutCodex",
				accountId: first.id,
			});
			expect(out.status).toBe("logged-out");
			await vi.waitFor(
				async () => {
					const accounts = (await browser.instances()).instances;
					expect(accounts.find(({ id }) => id === first.id)?.available).toBe(
						false,
					);
					expect(accounts.find(({ id }) => id === second.id)?.available).toBe(
						true,
					);
				},
				{ timeout: TIMEOUT, interval: 100 },
			);
		},
		TIMEOUT,
	);

	it(
		"invalidates the daemon's cached authentication after a detached runner reports auth_required",
		async () => {
			const { fixture, browser } = await start("turn-auth-failure");
			const account = await add(fixture, "Expired login");
			await codexModels(browser, account.id);
			trace(account.home, "codex-turn", fixtureRows("error-auth_required"));
			const refreshed = trace(
				account.home,
				"codex-discovery-auth",
				readOnlyTrace(false),
			);
			const id = await browser.createSession(
				"Expired login",
				account.id,
				"codex",
				{ modelId: MODEL, contextWindow: "", permissionMode: "ask" },
			);
			sessionIds.push(id);
			await browser.send(id, "Say hello", TIMEOUT);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({
							type: "turn.error",
							data: expect.objectContaining({ code: "auth_required" }),
						}),
					),
				{ timeout: TIMEOUT },
			);
			await vi.waitFor(
				async () =>
					expect(
						(await browser.instances()).instances.find(
							({ id: accountId }) => accountId === account.id,
						)?.available,
					).toBe(false),
				{ timeout: TIMEOUT, interval: 100 },
			);
			expect(
				rows<TraceRow>(refreshed).filter(
					({ message }) => message?.method === "account/read",
				),
			).toHaveLength(1);
		},
		TIMEOUT,
	);

	it.each([
		{ restart: false, lifecycle: "ordinary" },
		{ restart: true, lifecycle: "daemon restart" },
	])(
		"records a transcript-digest handoff when a configured home cannot see the original rollout ($lifecycle)",
		async ({ restart }) => {
			const {
				fixture,
				browser: initialBrowser,
				restartOptions,
			} = await start(
				`configured-home-digest-fallback${restart ? "-restart" : ""}`,
			);
			let browser = initialBrowser;
			const firstHome = join(fixture.root, "codex-first");
			const secondHome = join(fixture.root, "codex-second");
			mkdirSync(firstHome);
			mkdirSync(secondHome);
			const first = await add(fixture, "Original", firstHome);
			const second = await add(fixture, "Separate rollout", secondHome);
			await codexModels(browser, first.id);
			await codexModels(browser, second.id);
			await fixture.requestRpc({
				_tag: "SetUsageLimitsSetting",
				usageLimits: {
					autoResume: false,
					autoSwitch: false,
					order: [],
					warnAt: 80,
				},
			});
			const initial = trace(
				first.home,
				"codex-turn",
				fixtureRows("usage-limit"),
			);
			const id = await browser.createSession(
				"Separate rollout",
				first.id,
				"codex",
				{ modelId: MODEL, contextWindow: "", permissionMode: "ask" },
			);
			sessionIds.push(id);
			await browser.send(id, "Say hello", TIMEOUT);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({ type: "session.usage_limited" }),
					),
				{ timeout: TIMEOUT },
			);
			const native = rows<TraceRow>(initial).find(
				({ message }) => message?.method === "turn/start",
			)?.message?.params?.["threadId"];
			if (typeof native !== "string")
				throw new Error("Missing original native id");
			const missing = fixtureRows("resume-missing");
			const missingId = missing.find(
				({ message }) => message?.method === "thread/resume",
			)?.message?.params?.["threadId"];
			if (typeof missingId !== "string")
				throw new Error("Missing captured missing id");
			const resume = (
				JSON.parse(
					JSON.stringify(missing).replaceAll(missingId, native),
				) as TraceRow[]
			).filter(({ dir }) => dir !== "exit");
			const basic = fixtureRows("basic");
			const created = basic.find(
				({ message }) => message?.method === "turn/start",
			)?.message?.params?.["threadId"];
			if (typeof created !== "string")
				throw new Error("Missing captured new thread");
			const next = randomUUID();
			const newThread = JSON.parse(
				JSON.stringify(basic).replaceAll(created, next),
			) as TraceRow[];
			const begin = newThread.findIndex(
				({ message }) => message?.method === "thread/start",
			);
			const fallback = [...resume, ...newThread.slice(begin)];
			if (restart) holdTurnCompletion(fallback);
			const capture = trace(second.home, "codex-turn", fallback);
			if (restart) writeFileSync(capture, "");
			await fixture.requestRpc({
				_tag: "ContinueSession",
				sessionId: id,
				instanceId: second.id,
				expectedInstanceId: first.id,
			});
			if (restart)
				browser = await restartDuringContinuation(
					fixture,
					id,
					capture,
					restartOptions,
				);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns.map(({ state }) => state)).toEqual(
						["completed"],
					),
				{ timeout: TIMEOUT, interval: 100 },
			);
			const outgoing = rows<TraceRow>(capture).filter(
				({ dir }) => dir === "out",
			);
			expect(
				outgoing
					.filter(({ message }) => message?.method === "thread/resume")
					.map(({ message }) => message?.params?.["threadId"]),
			).toEqual([native, native]);
			expect(
				outgoing.filter(({ message }) => message?.method === "thread/start"),
			).toHaveLength(1);
			const input = outgoing.find(
				({ message }) => message?.method === "turn/start",
			)?.message?.params?.["input"];
			expect(JSON.stringify(input)).toContain("[Conduit fork context]");
			expect(JSON.stringify(input)).toContain("Say hello");
			await expectHandoff(fixture, id, second.id, "transcript-digest");
			const history = await browser.history(id);
			expect(JSON.stringify(history)).not.toContain("Conduit notice:");
		},
		TIMEOUT,
	);

	it.each([
		{ restart: false, lifecycle: "ordinary" },
		{ restart: true, lifecycle: "daemon restart" },
	])(
		"continues a usage-limited native thread on the second account and moves its home pin ($lifecycle)",
		async ({ restart }) => {
			const {
				fixture,
				browser: initialBrowser,
				restartOptions,
			} = await start(`account-switch-resume${restart ? "-restart" : ""}`);
			let browser = initialBrowser;
			const first = await add(fixture, "Limited");
			const second = await add(fixture, "Available");
			await codexModels(browser, first.id);
			await codexModels(browser, second.id);
			await fixture.requestRpc({
				_tag: "SetUsageLimitsSetting",
				usageLimits: {
					autoResume: false,
					autoSwitch: false,
					order: [],
					warnAt: 80,
				},
			});
			const initial = trace(
				first.home,
				"codex-turn",
				fixtureRows("usage-limit"),
			);
			const id = await browser.createSession(
				"Switch account",
				first.id,
				"codex",
				{ modelId: MODEL, contextWindow: "", permissionMode: "ask" },
			);
			sessionIds.push(id);
			await browser.send(id, "Say hello", TIMEOUT);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({ type: "session.usage_limited" }),
					),
				{ timeout: TIMEOUT },
			);
			const native = rows<TraceRow>(initial).find(
				({ message }) => message?.method === "turn/start",
			)?.message?.params?.["threadId"];
			if (typeof native !== "string")
				throw new Error("Missing original thread id");
			const resumed = fixtureRows("account-switch-resume");
			const previous = resumed.find(
				({ message }) => message?.method === "thread/resume",
			)?.message?.params?.["threadId"];
			if (typeof previous !== "string")
				throw new Error("Missing captured resume");
			const resumedTrace = JSON.parse(
				JSON.stringify(resumed).replaceAll(previous, native),
			) as TraceRow[];
			if (restart) holdTurnCompletion(resumedTrace);
			const continued = trace(second.home, "codex-turn", resumedTrace);
			if (restart) writeFileSync(continued, "");
			await fixture.requestRpc({
				_tag: "ContinueSession",
				sessionId: id,
				instanceId: second.id,
				expectedInstanceId: first.id,
			});
			if (restart)
				browser = await restartDuringContinuation(
					fixture,
					id,
					continued,
					restartOptions,
				);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).events).toContainEqual(
						expect.objectContaining({
							type: "session.resumed",
							data: expect.objectContaining({ instanceId: second.id }),
						}),
					),
				{ timeout: TIMEOUT, interval: 100 },
			);
			await vi.waitFor(
				() =>
					expect(snapshot(fixture, id).turns.map(({ state }) => state)).toEqual(
						["completed"],
					),
				{ timeout: TIMEOUT, interval: 100 },
			);
			const outgoing = rows<TraceRow>(continued).filter(
				({ dir }) => dir === "out",
			);
			expect(
				outgoing
					.filter(({ message }) => message?.method === "thread/resume")
					.map(({ message }) => message?.params?.["threadId"]),
			).toEqual([native]);
			expect(
				outgoing.filter(({ message }) => message?.method === "thread/start"),
			).toEqual([]);
			expect(
				outgoing.find(({ message }) => message?.method === "turn/start")
					?.message?.params?.["input"],
			).toEqual([expect.objectContaining({ type: "text", text: "Say hello" })]);
			expect(rows<TransportRecord>(transportPath)).toContainEqual(
				expect.objectContaining({ home: second.home, scenario: "codex-turn" }),
			);
			expect(readCodexSessionIdentity(fixture.configDir, id)).toMatchObject({
				threadId: native,
				codexHome: second.home,
			});
			await expectHandoff(fixture, id, second.id, "native-thread");
			expect(JSON.stringify(await browser.history(id))).not.toContain(
				"Conduit notice:",
			);
		},
		TIMEOUT,
	);
});
