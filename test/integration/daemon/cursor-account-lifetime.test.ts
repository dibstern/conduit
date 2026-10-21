// Failure modes: intake releases demand before native completion, invalidation
// cancels another account, retained native turns lose demand on restart, and
// released historical bindings resurrect demand or reopen removed accounts.
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { CURRENT_CONFIG_VERSION } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
const scenarios: Record<string, unknown>[] = [];
let evidence: Record<string, unknown> = {};

function captureRows(path: string): { kind: string; data: unknown }[] {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
}

afterEach(async ({ task }) => {
	if (!harness) return;
	const fixture = harness;
	evidence = {
		...evidence,
		operations: captureRows(join(fixture.root, "capture.jsonl")).map(
			({ kind }) => kind,
		),
		nativeCreates: captureRows(join(fixture.root, "capture.jsonl"))
			.filter(({ kind }) => kind === "create.options")
			.map(({ data }) => data),
		logTail: fixture.proof().logTail.slice(-10_000),
	};
	await fixture.dispose();
	scenarios.push({
		scenario: task.name,
		result: task.result?.state,
		failures: task.result?.errors?.map(({ message }) => message),
		remainingRunners: fixture.remainingRunnerPids(),
		evidence,
	});
	mkdirSync("test-results/82tn9-5", { recursive: true });
	writeFileSync(
		"test-results/82tn9-5/lifetime.json",
		JSON.stringify({ scenarios }, null, 2),
	);
	harness = undefined;
});

it.each([
	{ legacy: false, removeBeforeRestart: false },
	{ legacy: true, removeBeforeRestart: false },
	{ legacy: false, removeBeforeRestart: true },
	{ legacy: true, removeBeforeRestart: true },
])("does not revive completed turn demand on restart (%j)", async ({
	legacy,
	removeBeforeRestart,
}) => {
	evidence = { legacy, removeBeforeRestart };
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		runnerLifecycle: { idleTimeoutMs: null },
	});
	const fixture = harness;
	const capture = join(fixture.root, "capture.jsonl");
	const serviceEnvironment = {
		CURSOR_API_KEY: "",
		CONDUIT_CURSOR_SDK_TRACE: resolve(
			"test/fixtures/cursor-sdk-traces/auth-login.jsonl",
		),
		CONDUIT_CURSOR_SDK_CAPTURE: capture,
		CONDUIT_TEST_RUNNER_HELLO_WITHOUT_BINDING_RELEASE_STATE: legacy ? "1" : "",
	};
	await fixture.restart({ startupTimeoutMs: 90_000, serviceEnvironment });
	const { addedInstanceId: accountId } = await fixture.requestRpc({
		_tag: "AddInstance",
		name: "Completed owner",
		driver: "cursor",
		env: { CURSOR_API_KEY: "[REDACTED:completed]" },
	});
	if (!accountId) throw new Error("No account allocated");
	const browser = await fixture.connect();
	const sessionId = await browser.createSession(
		"Completed",
		accountId,
		"cursor",
		{
			modelId: "composer-2.5",
			contextWindow: "",
			permissionMode: "full",
		},
	);
	await browser.send(sessionId, "Say hello", 90_000);
	await vi.waitFor(() =>
		expect(
			captureRows(capture).some(({ kind }) => kind === "store.disposed"),
		).toBe(true),
	);
	const runnerPids = fixture.remainingRunnerPids();
	expect(runnerPids).toHaveLength(1);
	if (removeBeforeRestart)
		await fixture.requestRpc({ _tag: "RemoveInstance", instanceId: accountId });
	await fixture.terminate();
	await fixture.restart({ startupTimeoutMs: 30_000, serviceEnvironment });
	expect(fixture.remainingRunnerPids()).toEqual(runnerPids);
	const { projects } = await fixture.requestRpc({ _tag: "GetProjects" });
	expect(
		projects.find(({ slug }) => slug === "process-test")?.unavailableReason,
	).toBeUndefined();
	const recovered = await fixture.connect();
	await recovered.createSession("Recovered project");
	if (!removeBeforeRestart) {
		const removing = fixture.requestRpc({
			_tag: "RemoveInstance",
			instanceId: accountId,
		});
		void removing.catch(() => {});
		const inventory = fixture.requestRpc({ _tag: "GetInstances" });
		void inventory.catch(() => {});
		let finished = false;
		try {
			finished = await Promise.race([
				Promise.all([removing, inventory]).then(() => true),
				setTimeout(3000, false),
			]);
			evidence = { ...evidence, removalCompleted: finished, runnerPids };
			expect(
				finished,
				"account removal and inventory must finish while the idle runner survives",
			).toBe(true);
		} finally {
			// Unblock a failing regression without touching any process outside this fixture.
			if (!finished) {
				for (const pid of fixture.remainingRunnerPids())
					process.kill(pid, "SIGTERM");
				await Promise.allSettled([removing, inventory]);
			}
		}
	}
	expect(fixture.remainingRunnerPids()).toEqual(runnerPids);
	evidence = { ...evidence, projectRecovered: true, runnerPids };
}, 120_000);

it("finishes a live binding for a deleted account without blocking project recovery", async () => {
	evidence = { phase: "live-deleted-account" };
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		runnerLifecycle: { idleTimeoutMs: null },
	});
	const fixture = harness;
	const trace = join(fixture.root, "cursor.jsonl");
	const capture = join(fixture.root, "capture.jsonl");
	const gate = join(fixture.root, "stream.gate");
	writeFileSync(
		trace,
		readFileSync(
			resolve("test/fixtures/cursor-sdk-traces/auth-login.jsonl"),
			"utf8",
		).replaceAll('"status":"finished"', '"status":"cancelled"'),
	);
	writeFileSync(gate, "hold");
	const serviceEnvironment = {
		CURSOR_API_KEY: "",
		CONDUIT_CURSOR_SDK_TRACE: trace,
		CONDUIT_CURSOR_SDK_CAPTURE: capture,
		CONDUIT_TEST_CURSOR_STREAM_GATE: gate,
	};
	await fixture.restart({ startupTimeoutMs: 90_000, serviceEnvironment });
	const { addedInstanceId: accountId } = await fixture.requestRpc({
		_tag: "AddInstance",
		name: "Deleted owner",
		driver: "cursor",
		env: { CURSOR_API_KEY: "[REDACTED:deleted]" },
	});
	if (!accountId) throw new Error("No account allocated");
	const browser = await fixture.connect();
	const sessionId = await browser.createSession(
		"Deleted owner",
		accountId,
		"cursor",
		{
			modelId: "composer-2.5",
			contextWindow: "",
			permissionMode: "full",
		},
	);
	void browser.send(sessionId, "Say hello", 90_000).catch(() => {});
	await vi.waitFor(
		() =>
			expect(
				captureRows(capture).some(({ kind }) => kind === "run.handle"),
			).toBe(true),
		{ timeout: 30_000 },
	);
	await fixture.terminate();
	// Simulate removing the admitted account while its detached runner survives.
	const configPath = join(fixture.configDir, "daemon.json");
	const config: { instances: { id: string }[] } = JSON.parse(
		readFileSync(configPath, "utf8"),
	);
	writeFileSync(
		configPath,
		JSON.stringify({
			...config,
			instances: config.instances.filter(({ id }) => id !== accountId),
		}),
	);
	const beforeAdoption = captureRows(capture).filter(
		({ kind }) => kind === "credential.store.call",
	).length;
	await fixture.restart({ startupTimeoutMs: 30_000, serviceEnvironment });
	const { projects } = await fixture.requestRpc({ _tag: "GetProjects" });
	expect(
		projects.find(({ slug }) => slug === "process-test")?.unavailableReason,
	).toBeUndefined();
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		await vi.waitFor(() =>
			expect(
				db
					.prepare<[string], { state: string }>(
						"SELECT state FROM turns WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
					)
					.get(sessionId)?.state,
			).toBe("error"),
		);
		const terminal = db
			.prepare<[string], { data: string }>(
				"SELECT data FROM events WHERE session_id = ? AND type = 'turn.error' ORDER BY sequence DESC LIMIT 1",
			)
			.get(sessionId);
		expect(JSON.parse(terminal?.data ?? "{}")).toMatchObject({
			code: "account_unavailable",
			error: expect.stringContaining(accountId),
		});
	} finally {
		db.close();
		rmSync(gate);
	}
	const recovered = await fixture.connect();
	await recovered.createSession("Recovered project");
	expect(
		captureRows(capture).filter(({ kind }) => kind === "credential.store.call"),
	).toHaveLength(beforeAdoption);
	evidence = { ...evidence, projectRecovered: true, terminal: "error" };
}, 120_000);

it.each([
	{ restart: false, legacy: false },
	{ restart: true, legacy: false },
	{ restart: true, legacy: true },
])("retains native turn demand and cancels only the removed account (%j)", async ({
	restart,
	legacy,
}) => {
	evidence = { restart, legacy, accountIdleGraceMs: 100 };
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		runnerLifecycle: { idleTimeoutMs: 100 },
	});
	const fixture = harness;
	const trace = join(fixture.root, "cursor.jsonl");
	const capture = join(fixture.root, "capture.jsonl");
	const auth = join(fixture.root, "auth.json");
	const gate = join(fixture.root, "stream.gate");
	const original = readFileSync(
		resolve("test/fixtures/cursor-sdk-traces/auth-login.jsonl"),
		"utf8",
	);
	// Account A's recorded run settles cancellation without releasing B's stream.
	writeFileSync(
		trace,
		original
			.split("\n")
			.filter((line) => !line.startsWith('{"kind":"delta"'))
			.join("\n")
			.replaceAll('"status":"finished"', '"status":"cancelled"'),
	);
	writeFileSync(auth, JSON.stringify({ accounts: {} }));
	writeFileSync(gate, "hold");
	const environment = {
		CURSOR_API_KEY: "",
		CONDUIT_CURSOR_SDK_TRACE: trace,
		CONDUIT_CURSOR_SDK_CAPTURE: capture,
		CONDUIT_TEST_CURSOR_AUTH_STATE: auth,
		CONDUIT_TEST_CURSOR_STREAM_GATE: gate,
		CONDUIT_TEST_RUNNER_HELLO_WITHOUT_BINDING_RELEASE_STATE: legacy ? "1" : "",
	};
	await fixture.restart({
		startupTimeoutMs: 90_000,
		runnerStartupTimeoutMs: 90_000,
		opencodeIdleTimeoutMs: 100,
		serviceEnvironment: environment,
	});
	const browser = await fixture.connect();
	const accounts: string[] = [];
	const sessions: string[] = [];
	for (const name of ["A", "B"]) {
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			name,
			driver: "cursor",
		});
		const accountId = added.addedInstanceId;
		if (!accountId) throw new Error("No account allocated");
		accounts.push(accountId);
		await fixture.requestRpc({ _tag: "StartCursorLogin", accountId });
		await vi.waitFor(
			async () => {
				expect(
					(await fixture.requestRpc({ _tag: "GetCursorAuth", accountId })).login
						.state,
				).toBe("complete");
			},
			{ timeout: 30_000 },
		);
		const sessionId = await browser.createSession(name, accountId, "cursor", {
			modelId: "composer-2.5",
			contextWindow: "",
			permissionMode: "full",
		});
		sessions.push(sessionId);
		void browser.send(sessionId, "Say hello", 90_000).catch(() => {});
		await vi.waitFor(
			() => {
				expect(
					captureRows(capture).filter(({ kind }) => kind === "send.options"),
				).toHaveLength(sessions.length);
			},
			{ timeout: 30_000 },
		);
		writeFileSync(trace, original);
	}
	const states = () => {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return sessions.map(
				(id) =>
					db
						.prepare<[string], { state: string }>(
							"SELECT state FROM turns WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
						)
						.get(id)?.state,
			);
		} finally {
			db.close();
		}
	};
	await vi.waitFor(() => expect(states()).toEqual(["running", "running"]));
	if (restart) {
		await fixture.terminate();
		expect(fixture.remainingRunnerPids()).toHaveLength(2);
		await fixture.restart({
			startupTimeoutMs: 90_000,
			serviceEnvironment: environment,
		});
	}
	await setTimeout(450);
	evidence = {
		...evidence,
		beforeRemoval: states(),
		runnerPids: fixture.remainingRunnerPids(),
	};
	expect(states()).toEqual(["running", "running"]);
	expect(captureRows(capture).some(({ kind }) => kind === "cancel.call")).toBe(
		false,
	);
	await fixture.requestRpc({
		_tag: "RemoveInstance",
		instanceId: accounts[0] ?? "",
	});
	await vi.waitFor(
		() =>
			expect(
				captureRows(capture).filter(({ kind }) => kind === "cancel.call"),
			).toHaveLength(1),
		{ timeout: 15_000 },
	);
	await vi.waitFor(() => expect(states()).toEqual(["interrupted", "running"]), {
		timeout: 15_000,
	});
	evidence = { ...evidence, afterRemoval: states(), cancellations: 1 };
	rmSync(gate);
	await vi.waitFor(
		() => expect(states()).toEqual(["interrupted", "completed"]),
		{ timeout: 30_000 },
	);
	evidence = { ...evidence, final: states() };
}, 180_000);

it("removes an environment account while native send is awaiting its SDK handle", async () => {
	evidence = {
		phase: "native-send-acquisition",
		credentialSource: "environment",
	};
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		runnerLifecycle: { idleTimeoutMs: 100 },
	});
	const fixture = harness;
	const trace = join(fixture.root, "cursor.jsonl");
	const capture = join(fixture.root, "capture.jsonl");
	const gate = join(fixture.root, "send.gate");
	writeFileSync(
		trace,
		readFileSync(
			resolve("test/fixtures/cursor-sdk-traces/auth-login.jsonl"),
			"utf8",
		).replaceAll('"status":"finished"', '"status":"cancelled"'),
	);
	writeFileSync(gate, "hold");
	await fixture.restart({
		startupTimeoutMs: 90_000,
		opencodeIdleTimeoutMs: 100,
		serviceEnvironment: {
			CURSOR_API_KEY: "",
			CONDUIT_CURSOR_SDK_TRACE: trace,
			CONDUIT_CURSOR_SDK_CAPTURE: capture,
			CONDUIT_TEST_CURSOR_SEND_GATE: gate,
		},
	});
	const added = await fixture.requestRpc({
		_tag: "AddInstance",
		name: "Environment token",
		driver: "cursor",
		env: { CURSOR_API_KEY: "[REDACTED:environment]" },
	});
	if (!added.addedInstanceId) throw new Error("No account allocated");
	expect(
		await fixture.requestRpc({
			_tag: "GetCursorAuth",
			accountId: added.addedInstanceId,
		}),
	).toMatchObject({ source: "environment", status: "logged-in" });
	const fingerprint = createHash("sha256")
		.update(JSON.stringify(["environment", "", "[REDACTED:environment]"]))
		.digest("hex");
	const browser = await fixture.connect();
	const sessionId = await browser.createSession(
		"Pending send",
		added.addedInstanceId,
		"cursor",
		{
			modelId: "composer-2.5",
			contextWindow: "",
			permissionMode: "full",
		},
	);
	void browser.send(sessionId, "Say hello", 90_000).catch(() => {});
	await vi.waitFor(
		() =>
			expect(
				captureRows(capture).some(({ kind }) => kind === "send.options"),
			).toBe(true),
		{ timeout: 30_000 },
	);
	expect(
		captureRows(capture).find(({ kind }) => kind === "create.options")?.data,
	).toMatchObject({ credentialFingerprint: fingerprint });
	expect(
		captureRows(capture)
			.filter(({ kind }) => kind === "models.list.call")
			.map(({ data }) => data),
	).toContainEqual(
		expect.objectContaining({
			credential: expect.objectContaining({
				source: "environment",
				fingerprint,
			}),
		}),
	);
	expect(captureRows(capture).some(({ kind }) => kind === "run.handle")).toBe(
		false,
	);
	const removing = fixture.requestRpc({
		_tag: "RemoveInstance",
		instanceId: added.addedInstanceId,
	});
	void removing.catch(() => {});
	await setTimeout(150);
	rmSync(gate);
	await removing;
	await vi.waitFor(
		() =>
			expect(
				captureRows(capture).filter(({ kind }) => kind === "cancel.call"),
			).toHaveLength(1),
		{ timeout: 15_000 },
	);
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		await vi.waitFor(
			() =>
				expect(
					db
						.prepare<[string], { state: string }>(
							"SELECT state FROM turns WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
						)
						.get(sessionId)?.state,
				).toBe("interrupted"),
			{ timeout: 15_000 },
		);
		evidence = { ...evidence, cancelled: true, terminal: "interrupted" };
	} finally {
		db.close();
	}
}, 90_000);

it.each([
	"sdk-login",
	"default-environment",
	"legacy-missing-credential",
] as const)("retains account demand when restart replays an admission the runner never received (%s)", async (source) => {
	evidence = {
		phase: "replayed-undispatched-admission",
		source,
		accountIdleGraceMs: 100,
	};
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		holdRunnerOutput: "send-turn",
		restartProof: true,
		runnerLifecycle: { idleTimeoutMs: null },
	});
	const fixture = harness;
	if (source === "default-environment") {
		const configPath = join(fixture.configDir, "daemon.json");
		const config: Record<string, unknown> = JSON.parse(
			readFileSync(configPath, "utf8"),
		);
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				configVersion: CURRENT_CONFIG_VERSION,
				instances: [
					{
						id: "cursor-default",
						name: "Existing Cursor",
						driver: "cursor",
						port: 0,
						managed: false,
					},
				],
				accountDefaults: { cursor: "cursor-default" },
			}),
		);
	}
	const trace = join(fixture.root, "cursor.jsonl");
	const capture = join(fixture.root, "capture.jsonl");
	const auth = join(fixture.root, "auth.json");
	const gate = join(fixture.root, "stream.gate");
	writeFileSync(
		trace,
		readFileSync(
			resolve("test/fixtures/cursor-sdk-traces/auth-login.jsonl"),
			"utf8",
		).replaceAll('"status":"finished"', '"status":"cancelled"'),
	);
	writeFileSync(
		auth,
		JSON.stringify({
			accounts: {
				"cursor-default": {
					status: { status: "logged-out" },
					credential: null,
				},
			},
		}),
	);
	writeFileSync(gate, "hold");
	const serviceEnvironment = {
		CURSOR_API_KEY: source === "sdk-login" ? "" : "[REDACTED:environment]",
		CONDUIT_CURSOR_SDK_TRACE: trace,
		CONDUIT_CURSOR_SDK_CAPTURE: capture,
		CONDUIT_TEST_CURSOR_AUTH_STATE: auth,
		CONDUIT_TEST_CURSOR_STREAM_GATE: gate,
	};
	await fixture.restart({
		startupTimeoutMs: 90_000,
		opencodeIdleTimeoutMs: 100,
		serviceEnvironment,
	});
	let accountId = "cursor-default";
	if (source !== "default-environment") {
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Replay owner",
			driver: "cursor",
		});
		if (!added.addedInstanceId) throw new Error("No account allocated");
		accountId = added.addedInstanceId;
		await fixture.requestRpc({ _tag: "StartCursorLogin", accountId });
		await vi.waitFor(
			async () =>
				expect(
					(await fixture.requestRpc({ _tag: "GetCursorAuth", accountId })).login
						.state,
				).toBe("complete"),
			{ timeout: 30_000 },
		);
	}
	expect(
		await fixture.requestRpc({ _tag: "GetCursorAuth", accountId }),
	).toMatchObject({
		source: source === "default-environment" ? "environment" : "sdk-login",
		status: "logged-in",
	});
	const credentialSource =
		source === "default-environment" ? "environment" : "sdk-login";
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify(
				source !== "default-environment"
					? ["sdk-login", "https://api2.cursor.sh", "[REDACTED]"]
					: ["environment", "", "[REDACTED:environment]"],
			),
		)
		.digest("hex");
	const browser = await fixture.connect();
	const sessionId = await browser.createSession(
		"Replay owner",
		accountId,
		"cursor",
		{ modelId: "composer-2.5", contextWindow: "", permissionMode: "full" },
	);
	void browser.send(sessionId, "Say hello", 90_000).catch(() => {});
	await vi.waitFor(
		() =>
			expect(
				captureRows(join(fixture.root, "sdk-proof.ndjson")),
			).toContainEqual(
				expect.objectContaining({ kind: "held-output", type: "send-turn" }),
			),
		{ timeout: 30_000 },
	);
	expect(
		captureRows(capture).filter(({ kind }) => kind === "send.options"),
	).toHaveLength(0);
	expect(
		captureRows(capture)
			.filter(({ kind }) => kind === "models.list.call")
			.map(({ data }) => data),
	).toContainEqual(
		expect.objectContaining({
			credential: expect.objectContaining({
				source: credentialSource,
				fingerprint,
			}),
		}),
	);
	const beforeRestart = fixture.remainingRunnerPids();
	await fixture.terminate();
	if (source === "legacy-missing-credential") {
		writeFileSync(
			auth,
			JSON.stringify({
				accounts: {
					[accountId]: { status: { status: "logged-out" }, credential: null },
				},
			}),
		);
		const database = new Database(fixture.daemonStorePath());
		try {
			database
				.prepare(
					"UPDATE provider_command_outbox SET payload_json = json_remove(payload_json, '$.account') WHERE session_id = ? AND status = 'running'",
				)
				.run(sessionId);
		} finally {
			database.close();
		}
	}
	await fixture.restart({ startupTimeoutMs: 90_000, serviceEnvironment });
	if (source === "legacy-missing-credential") {
		const database = new Database(fixture.daemonStorePath(), {
			readonly: true,
		});
		try {
			await vi.waitFor(
				() => {
					evidence = {
						...evidence,
						terminalEvents: database
							.prepare<[string], { type: string; data: string }>(
								"SELECT type, data FROM events WHERE session_id = ? AND type IN ('turn.error', 'message.created', 'run.started') ORDER BY sequence",
							)
							.all(sessionId),
						outbox: database
							.prepare<[string], { status: string; error_code: string | null }>(
								"SELECT status, error_code FROM provider_command_outbox WHERE session_id = ?",
							)
							.all(sessionId),
					};
					expect(
						captureRows(capture).filter(({ kind }) => kind === "send.options"),
					).toHaveLength(0);
					expect(
						database
							.prepare<[string], { state: string }>(
								"SELECT state FROM turns WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
							)
							.get(sessionId)?.state,
					).toBe("error");
				},
				{ timeout: 5000 },
			);
			const terminal = database
				.prepare<[string], { data: string }>(
					"SELECT data FROM events WHERE session_id = ? AND type = 'turn.error' ORDER BY sequence DESC LIMIT 1",
				)
				.get(sessionId);
			expect(JSON.parse(terminal?.data ?? "{}")).toMatchObject({
				code: "auth_required",
			});
			evidence = {
				...evidence,
				noNativeSend: true,
				terminalCode: "auth_required",
			};
			return;
		} finally {
			database.close();
		}
	}
	await vi.waitFor(
		() =>
			expect(
				captureRows(capture).filter(({ kind }) => kind === "send.options"),
			).toHaveLength(1),
		{ timeout: 30_000 },
	);
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const state = () =>
			db
				.prepare<[string], { state: string }>(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
				)
				.get(sessionId)?.state;
		await vi.waitFor(() => expect(state()).toBe("running"));
		await setTimeout(450);
		expect(state()).toBe("running");
		expect(fixture.remainingRunnerPids()).toEqual(beforeRestart);
		evidence = {
			...evidence,
			beforeRemoval: state(),
			retainedRunnerPids: beforeRestart,
		};
		const removing = fixture.requestRpc({
			_tag: "RemoveInstance",
			instanceId: accountId,
		});
		void removing.catch(() => {});
		await vi.waitFor(
			() =>
				expect(
					captureRows(capture).filter(({ kind }) => kind === "cancel.call"),
				).toHaveLength(1),
			{ timeout: 3000 },
		);
		rmSync(gate);
		await removing;
		await vi.waitFor(() => expect(state()).toBe("interrupted"), {
			timeout: 15_000,
		});
		const created = captureRows(capture).find(
			({ kind }) => kind === "create.options",
		)?.data;
		expect(created).toMatchObject({ credentialFingerprint: fingerprint });
		evidence = { ...evidence, afterRemoval: state(), nativeCreate: created };
	} finally {
		db.close();
	}
}, 120_000);
