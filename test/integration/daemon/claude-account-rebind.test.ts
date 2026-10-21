// Failures: account switches replace the controller, replayed goal facts count
// twice, a same-folder account/env change reuses stale credentials, or an old
// output/approval is attributed to the next account's run.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { discoverRunners } from "../../../src/lib/provider/runner/runner-registry.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
const proofs: Record<string, unknown>[] = [];
afterEach(async ({ task }) => {
	if (!harness) return;
	const fixture = harness;
	await fixture.dispose();
	expect(fixture.remainingRunnerPids()).toEqual([]);
	proofs.push({
		name: task.name,
		result: task.result?.state,
		errors: task.result?.errors?.map((error) => error.message),
		cleanup: {
			disposed: fixture.proof().disposed,
			runners: fixture.proof().runnerCleanup,
			remaining: fixture.remainingRunnerPids(),
		},
	});
	writeFileSync(
		"/tmp/82tn9-3-r3-account-rebind.json",
		JSON.stringify(proofs, null, 2),
	);
	harness = undefined;
});

it.each([
	{ sharedFolder: false, legacy: false, rejectResume: false },
	{ sharedFolder: true, legacy: false, rejectResume: false },
	{ sharedFolder: false, legacy: true, rejectResume: false },
	{ sharedFolder: false, legacy: false, rejectResume: true },
	{ sharedFolder: false, legacy: false, rejectResume: "result" },
])("continues A B A with shared login folder $sharedFolder, legacy runner $legacy, rejected resume $rejectResume", async ({
	sharedFolder,
	legacy,
	rejectResume,
}) => {
	const fixture = ProcessHarness.create({ dist: "dist", restartProof: true });
	harness = fixture;
	await fixture.restart(
		legacy
			? {
					serviceEnvironment: {
						CONDUIT_TEST_RUNNER_WITHOUT_ACCOUNT_REBIND: "1",
					},
				}
			: {},
	);
	let browser = await fixture.connect();
	const folderA = join(fixture.root, "account-a");
	const folderB = sharedFolder ? folderA : join(fixture.root, "account-b");
	for (const folder of [folderA, folderB])
		mkdirSync(folder, { recursive: true });
	const add = (name: string, configDir: string) =>
		fixture.requestRpc({
			_tag: "AddInstance",
			name,
			driver: "claude",
			configDir,
			env: { ACCOUNT_OWNER: sharedFolder ? "shared" : name },
		});
	const a = (await add("A", folderA)).addedInstanceId;
	const b = (await add("B", folderB)).addedInstanceId;
	if (!a || !b) throw new Error("Missing fixture accounts");
	const sessionId = await browser.createSession(
		"Retained account controller",
		a,
	);
	const controllers: ReturnType<typeof discoverRunners> = [];
	const accounts = legacy ? [a, b] : [a, b, a, a, a];
	for (const [index, account] of accounts.entries()) {
		if (index === 2 && rejectResume) {
			if (rejectResume === "result")
				writeFileSync(
					join(fixture.root, "rejected-resume-as-result"),
					"result",
				);
			const store = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				const native = store
					.prepare<[string, string], { value: string }>(
						"SELECT value FROM provider_state WHERE session_id = ? AND key = ?",
					)
					.get(sessionId, `nativeThread:${a}`);
				if (!native) throw new Error("Missing account A resume receipt");
				const receipt = JSON.parse(native.value) as { resumeSessionId: string };
				writeFileSync(
					join(fixture.root, "rejected-resume-session-id"),
					receipt.resumeSessionId,
				);
			} finally {
				store.close();
			}
		}
		if (index > 0 && account !== accounts[index - 1])
			await fixture.requestRpc({
				_tag: "ContinueSession",
				sessionId,
				instanceId: account,
				expectedInstanceId: accounts[index - 1] ?? a,
			});
		if (index === 3)
			await fixture.requestRpc({
				_tag: "UpdateInstance",
				instanceId: AccountIdSchema.make(a),
				env: { ACCOUNT_OWNER: "A-new" },
			});
		if (index === 4) {
			await fixture.kill();
			const configPath = join(fixture.configDir, "daemon.json");
			const config = JSON.parse(
				readFileSync(configPath, "utf8"),
			) as DaemonConfig;
			writeFileSync(
				configPath,
				JSON.stringify({
					...config,
					projects: config.projects.map((project) => ({
						...project,
						shellEnv: { overrides: { SHELL_OWNER: "updated" } },
					})),
				} satisfies DaemonConfig),
			);
			await fixture.restart();
			browser = await fixture.connect(sessionId);
		}
		const cursor = browser.frames.length;
		const pending = browser.send(
			sessionId,
			index === 4 ? "question-rebind" : `approval-rebind-${index}`,
		);
		// Teardown can close the browser if waiting for a card fails.
		void pending.catch(() => undefined);
		const request = await browser.waitFor(
			(frame) =>
				frame["type"] ===
				(index === 4 ? "question_pending" : "permission_pending"),
			cursor,
		);
		if (index === 4) await browser.rejectQuestion(request);
		else await browser.answerApproval(request, "allow");
		await pending;
		const controller = discoverRunners(
			fixture.projectDir,
			fixture.configDir,
		).find((entry) => entry.sessionId === sessionId);
		if (!controller) throw new Error("Missing session controller");
		controllers.push(controller);
	}
	const launches = accounts.map((_, index) => {
		const request =
			index === 4 ? "question-rebind" : `approval-rebind-${index}`;
		const launch = fixture
			.claudeOptions()
			.filter(
				({ prompt }) =>
					prompt === request || prompt?.endsWith(`\n\n${request}`),
			)
			.at(-1);
		if (!launch) throw new Error(`Missing SDK launch for ${request}`);
		return launch;
	});
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const events = db
			.prepare<[string], { type: string; data: string; metadata: string }>(
				"SELECT type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
			)
			.all(sessionId);
		const runs = db
			.prepare<[string], { id: string; account_id: string }>(
				"SELECT run_id AS id, provider_id AS account_id FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
			)
			.all(sessionId);
		proofs.push({
			sharedFolder,
			sessionId,
			controllers,
			launches,
			events,
			runs,
			sdk: readFileSync(join(fixture.root, "sdk-proof.ndjson"), "utf8"),
		});
		expect(new Set(controllers.map(({ runnerId }) => runnerId)).size).toBe(
			legacy ? 2 : 1,
		);
		expect(new Set(launches.map(({ pid }) => pid)).size).toBe(legacy ? 2 : 1);
		expect(
			launches.map(({ options }) => {
				const env = options["env"] as Record<string, string>;
				return {
					ACCOUNT_OWNER: env["ACCOUNT_OWNER"],
					...(env["SHELL_OWNER"] ? { SHELL_OWNER: env["SHELL_OWNER"] } : {}),
				};
			}),
		).toEqual(
			[
				{ ACCOUNT_OWNER: sharedFolder ? "shared" : "A" },
				{ ACCOUNT_OWNER: sharedFolder ? "shared" : "B" },
				{ ACCOUNT_OWNER: sharedFolder ? "shared" : "A" },
				{ ACCOUNT_OWNER: "A-new" },
				{ ACCOUNT_OWNER: "A-new", SHELL_OWNER: "updated" },
			].slice(0, accounts.length),
		);
		expect(
			events.filter(({ type }) => type === "session.goal_changed"),
		).toHaveLength(legacy ? 4 : 2);
		expect(runs).toMatchObject(accounts.map((account_id) => ({ account_id })));
		const permissions = events.filter(
			({ type }) => type === "permission.asked",
		);
		expect(
			permissions.map(({ metadata }) => JSON.parse(metadata).runId),
		).toEqual(runs.slice(0, 4).map(({ id }) => id));
		const questions = events.filter(({ type }) => type === "question.asked");
		expect(questions.map(({ metadata }) => JSON.parse(metadata).runId)).toEqual(
			legacy ? [] : [runs[4]?.id],
		);
		const sdk = readFileSync(join(fixture.root, "sdk-proof.ndjson"), "utf8")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						kind: string;
						request?: string;
						queryId?: string;
					},
			);
		expect(
			new Set(
				sdk
					.filter(
						(mark) =>
							mark.kind === "enqueue" &&
							(mark.request?.startsWith("approval-rebind-") ||
								mark.request === "question-rebind"),
					)
					.map((mark) => mark.queryId),
			).size,
		).toBe(legacy ? 2 : rejectResume ? 6 : 5);
		if (!legacy) {
			const late = events.filter(
				({ type, data }) =>
					type === "text.delta" && data.includes("late-from-account-A"),
			);
			expect(late).toHaveLength(1);
			expect(JSON.parse(late[0]?.metadata ?? "{}").runId).toBe(runs[0]?.id);
		}
	} finally {
		db.close();
	}
}, 60_000);

// An upgraded query's effective env must never become the next login's shell env.
it("drops removed account credentials after upgrade and through A B A rebinding", async () => {
	const fixture = ProcessHarness.create({
		dist: "dist",
		restartProof: true,
		buildId: "rebind-env-old",
	});
	harness = fixture;
	await fixture.restart();
	let browser = await fixture.connect();
	const accounts: string[] = [];
	for (const name of ["A", "B"]) {
		const configDir = join(fixture.root, name);
		mkdirSync(configDir);
		const { addedInstanceId } = await fixture.requestRpc({
			_tag: "AddInstance",
			name,
			driver: "claude",
			configDir,
			env: {
				ACCOUNT_OWNER: name,
				...(name === "A" ? { A_ONLY_SECRET: "credential-A" } : {}),
			},
		});
		if (!addedInstanceId) throw new Error("Missing fixture account");
		accounts.push(addedInstanceId);
	}
	const [a, b] = accounts;
	if (!a || !b) throw new Error("Missing fixture accounts");
	const sessionId = await browser.createSession("Upgrade rebind env", a);
	const controller = () =>
		discoverRunners(fixture.projectDir, fixture.configDir).find(
			(entry) => entry.sessionId === sessionId,
		);
	await browser.send(sessionId, "env-before-upgrade");
	const old = controller();
	await fixture.kill();
	await fixture.restart({ buildId: "rebind-env-new" });
	browser = await fixture.connect(sessionId);
	await vi.waitFor(() => expect(controller()?.pid).not.toBe(old?.pid), {
		timeout: 15_000,
	});
	const upgraded = controller();
	expect(upgraded).toBeDefined();
	await fixture.requestRpc({
		_tag: "UpdateInstance",
		instanceId: AccountIdSchema.make(a),
		env: { ACCOUNT_OWNER: "A-updated" },
	});
	await browser.send(sessionId, "env-removed-from-A");
	for (const [from, to] of [
		[a, b],
		[b, a],
	] as const) {
		await fixture.requestRpc({
			_tag: "ContinueSession",
			sessionId,
			instanceId: to,
			expectedInstanceId: from,
		});
		await browser.send(sessionId, `env-rebound-${to}`);
	}
	const launches = fixture.claudeOptions();
	proofs.push({ sessionId, upgraded, launches });
	expect(launches.map(({ options }) => options["env"])).toEqual([
		expect.objectContaining({
			ACCOUNT_OWNER: "A",
			A_ONLY_SECRET: "credential-A",
		}),
		expect.objectContaining({ ACCOUNT_OWNER: "A-updated" }),
		expect.objectContaining({ ACCOUNT_OWNER: "B" }),
		expect.objectContaining({ ACCOUNT_OWNER: "A-updated" }),
	]);
	for (const launch of launches.slice(1))
		expect(launch.options["env"]).not.toHaveProperty("A_ONLY_SECRET");
	expect(controller()?.runnerId).toBe(upgraded?.runnerId);
}, 40_000);

it("cancels an undelivered account rebind while background work is running, then retries", async () => {
	const fixture = ProcessHarness.create({ dist: "dist", restartProof: true });
	harness = fixture;
	await fixture.restart();
	const browser = await fixture.connect();
	const accounts: string[] = [];
	for (const name of ["A", "B"]) {
		const configDir = join(fixture.root, name);
		mkdirSync(configDir);
		const { addedInstanceId } = await fixture.requestRpc({
			_tag: "AddInstance",
			name,
			driver: "claude",
			configDir,
		});
		if (!addedInstanceId) throw new Error("Missing fixture account");
		accounts.push(addedInstanceId);
	}
	const [a, b] = accounts;
	if (!a || !b) throw new Error("Missing fixture accounts");
	const sessionId = await browser.createSession("Cancel pending rebind", a);
	await browser.send(sessionId, "upgrade-background-work");
	const controller = discoverRunners(
		fixture.projectDir,
		fixture.configDir,
	).find((entry) => entry.sessionId === sessionId);
	await fixture.requestRpc({
		_tag: "ContinueSession",
		sessionId,
		instanceId: b,
		expectedInstanceId: a,
	});
	const inputId = randomUUID();
	const prompt = "cancel-pending-rebind";
	await Effect.runPromise(
		browser.rpc["input.submit"]({
			sessionId,
			originId: browser.originId,
			inputId,
			delivery: "queue",
			text: prompt,
		}),
	);
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const command = () =>
			db
				.prepare<[string], { status: string }>(
					"SELECT status FROM provider_command_outbox WHERE command_id = ? AND effect_type = 'send_turn'",
				)
				.get(inputId);
		await vi.waitFor(() => expect(command()?.status).toBe("running"));
		expect(fixture.claudeOptions()).toHaveLength(1);
		const cancel = await Effect.runPromise(
			browser.rpc
				.CancelSession({ sessionId, commandId: randomUUID() })
				.pipe(Effect.as("cancelled"), Effect.timeoutOption("5 seconds")),
		);
		writeFileSync(join(fixture.root, "release-upgrade-background"), "release");
		await vi.waitFor(() => expect(command()?.status).not.toBe("running"), {
			timeout: 10_000,
		});
		proofs.push({
			sessionId,
			inputId,
			cancel,
			command: command(),
			launches: fixture.claudeOptions(),
		});
		expect(cancel).toMatchObject({ _tag: "Some", value: "cancelled" });
		expect(fixture.claudeOptions()).toHaveLength(1);
		await Effect.runPromise(
			browser.rpc
				.CancelSession({ sessionId, commandId: randomUUID() })
				.pipe(Effect.timeout("3 seconds")),
		);
		await browser.send(sessionId, "retry-after-cancelled-rebind");
		expect(
			discoverRunners(fixture.projectDir, fixture.configDir).find(
				(entry) => entry.sessionId === sessionId,
			)?.runnerId,
		).toBe(controller?.runnerId);
		await fixture.kill();
		await fixture.restart();
		const reconnected = await fixture.connect(sessionId);
		await reconnected.send(sessionId, "after-cancelled-rebind-restart");
		const requests = readFileSync(
			join(fixture.root, "sdk-proof.ndjson"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; request?: string })
			.filter(({ kind }) => kind === "enqueue")
			.map(({ request }) => request);
		proofs.push({ sessionId, cancelledPrompt: prompt, requests });
		expect(requests).toEqual([
			"upgrade-background-work",
			"retry-after-cancelled-rebind",
			"after-cancelled-rebind-restart",
		]);
	} finally {
		db.close();
	}
}, 45_000);

it("cancels an ordinary account rebind during environment capture", async () => {
	const fixture = ProcessHarness.create({
		dist: "dist",
		restartProof: true,
		shellEnvProof: true,
	});
	harness = fixture;
	await fixture.restart();
	const browser = await fixture.connect();
	const sessionId = await browser.createSession(
		"Cancel during ordinary preparation",
	);
	await browser.send(sessionId, "upgrade-background-work");
	const configDir = join(fixture.root, "account-b");
	mkdirSync(configDir);
	const { addedInstanceId } = await fixture.requestRpc({
		_tag: "AddInstance",
		name: "B",
		driver: "claude",
		configDir,
	});
	if (!addedInstanceId) throw new Error("Missing fixture account");
	await fixture.requestRpc({
		_tag: "ContinueSession",
		sessionId,
		instanceId: addedInstanceId,
		expectedInstanceId: "claude",
	});
	const profile = join(fixture.root, "home/.zprofile");
	const release = join(fixture.root, "home/release-send-env");
	writeFileSync(
		profile,
		'printf ready > "$ZDOTDIR/send-env-started"\nwhile [ ! -f "$ZDOTDIR/release-send-env" ]; do sleep 0.02; done\n' +
			readFileSync(profile, "utf8"),
	);
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		await vi.waitFor(() =>
			expect(existsSync(join(fixture.root, "home/send-env-started"))).toBe(
				true,
			),
		);
		const inputId = randomUUID();
		const prompt = "must-not-send-after-preparation-stop";
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				delivery: "queue",
				text: prompt,
			}),
		);
		const command = () =>
			db
				.prepare<[string], { status: string; error_code: string | null }>(
					"SELECT status, error_code FROM provider_command_outbox WHERE command_id = ? AND effect_type = 'send_turn'",
				)
				.get(inputId);
		await vi.waitFor(() => expect(command()?.status).toBe("running"));
		const beforeStopCommands = fixture
			.proof()
			.marks.filter(
				(mark) => mark.kind === "runner-command" && mark.type === "send-turn",
			);
		expect(beforeStopCommands).toHaveLength(1);
		const cancel = await Effect.runPromise(
			browser.rpc
				.CancelSession({ sessionId, commandId: randomUUID() })
				.pipe(Effect.timeoutOption("3 seconds")),
		);
		const beforeRelease = command();
		writeFileSync(release, "release");
		writeFileSync(join(fixture.root, "release-upgrade-background"), "release");
		await vi.waitFor(() => expect(command()?.status).not.toBe("running"), {
			timeout: 10_000,
		});
		const requests = readFileSync(
			join(fixture.root, "sdk-proof.ndjson"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; request?: string })
			.filter(({ kind }) => kind === "enqueue")
			.map(({ request }) => request);
		proofs.push({
			beforeStopCommands,
			inputId,
			sessionId,
			cancel,
			beforeRelease,
			command: command(),
			requests,
		});
		expect(cancel).toMatchObject({ _tag: "Some", value: { ok: true } });
		expect(beforeRelease).toMatchObject({
			status: "failed",
			error_code: "cancelled",
		});
		expect(command()).toMatchObject({
			status: "failed",
			error_code: "cancelled",
		});
		expect(requests).toEqual(["upgrade-background-work"]);
		await browser.send(sessionId, "retry-after-preparation-stop");
	} finally {
		writeFileSync(release, "release");
		db.close();
	}
}, 45_000);

it.each([
	false,
	true,
])("cancels an unseen first send during environment capture, recovered %s", async (recovered) => {
	const fixture = ProcessHarness.create({
		dist: "dist",
		restartProof: true,
		shellEnvProof: true,
		holdRunnerOutput: "send-turn",
	});
	harness = fixture;
	await fixture.restart();
	let browser = await fixture.connect();
	const sessionId = await browser.createSession("Cancel unseen first send");
	const inputId = randomUUID();
	await Effect.runPromise(
		browser.rpc["input.submit"]({
			sessionId,
			originId: browser.originId,
			inputId,
			delivery: "queue",
			text: "must-not-send-after-preparation-stop",
		}),
	);
	await vi.waitFor(
		() =>
			expect(
				existsSync(join(fixture.root, "sdk-proof.ndjson")) &&
					readFileSync(join(fixture.root, "sdk-proof.ndjson"), "utf8").includes(
						'"kind":"held-output"',
					),
			).toBe(true),
		{ timeout: 15_000 },
	);
	if (recovered) await fixture.kill();
	const profile = join(fixture.root, "home/.zprofile");
	const release = join(fixture.root, "home/release-send-env");
	writeFileSync(
		profile,
		'printf ready > "$ZDOTDIR/send-env-started"\nwhile [ ! -f "$ZDOTDIR/release-send-env" ]; do sleep 0.02; done\n' +
			readFileSync(profile, "utf8"),
	);
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		if (recovered) {
			await fixture.restart();
			browser = await fixture.connect(sessionId);
		}
		await vi.waitFor(() =>
			expect(existsSync(join(fixture.root, "home/send-env-started"))).toBe(
				true,
			),
		);
		const deliveredBeforeStop = fixture
			.proof()
			.marks.filter(
				(mark) => mark.kind === "runner-command" && mark.type === "send-turn",
			);
		expect(deliveredBeforeStop).toEqual([]);
		const command = () =>
			db
				.prepare<[string], { status: string; error_code: string | null }>(
					"SELECT status, error_code FROM provider_command_outbox WHERE command_id = ? AND effect_type = 'send_turn'",
				)
				.get(inputId);
		expect(command()?.status).toBe("running");
		const cancel = await Effect.runPromise(
			browser.rpc
				.CancelSession({ sessionId, commandId: randomUUID() })
				.pipe(Effect.timeoutOption("3 seconds")),
		);
		await vi.waitFor(() =>
			expect(command()).toMatchObject({
				status: "failed",
				error_code: "cancelled",
			}),
		);
		const beforeRelease = command();
		writeFileSync(release, "release");
		await fixture.kill();
		await fixture.restart();
		browser = await fixture.connect(sessionId);
		await browser.send(sessionId, "retry-after-preparation-stop");
		const requests = readFileSync(
			join(fixture.root, "sdk-proof.ndjson"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; request?: string })
			.filter(({ kind }) => kind === "enqueue")
			.map(({ request }) => request);
		proofs.push({
			recovered,
			sessionId,
			inputId,
			deliveredBeforeStop,
			cancel,
			beforeRelease,
			command: command(),
			requests,
		});
		expect(cancel).toMatchObject({ _tag: "Some", value: { ok: true } });
		expect(command()).toMatchObject({
			status: "failed",
			error_code: "cancelled",
		});
		expect(requests).toEqual(["retry-after-preparation-stop"]);
	} finally {
		writeFileSync(release, "release");
		db.close();
	}
}, 45_000);

// Recovery must preserve admission, cancellation and the admitted account even
// when the account directory changes while the old query is still busy.
it.each([
	{ action: "release", legacy: false },
	{ action: "cancel", legacy: false },
	{ action: "cancel-preparing", legacy: false },
	{ action: "remove-account", legacy: false },
	{ action: "control", legacy: false },
	{ action: "end", legacy: false },
	{ action: "release", legacy: true },
] as const)("recovers an undelivered rebind across restart, then $action, legacy runner $legacy", async ({
	action,
	legacy,
}) => {
	const fixture = ProcessHarness.create({
		dist: "dist",
		restartProof: true,
		shellEnvProof: action === "cancel-preparing",
	});
	harness = fixture;
	await fixture.restart(
		legacy
			? {
					serviceEnvironment: {
						CONDUIT_TEST_RUNNER_WITHOUT_ACCOUNT_REBIND: "1",
					},
				}
			: {},
	);
	let browser = await fixture.connect();
	const configDir = join(fixture.root, "account-b");
	mkdirSync(configDir);
	const { addedInstanceId: b } = await fixture.requestRpc({
		_tag: "AddInstance",
		name: "B",
		driver: "claude",
		configDir,
		env: { ACCOUNT_OWNER: "B" },
	});
	if (!b) throw new Error("Missing fixture account");
	const sessionId = await browser.createSession("Recover pending rebind");
	await browser.send(sessionId, "upgrade-background-work");
	const controller = discoverRunners(
		fixture.projectDir,
		fixture.configDir,
	).find((entry) => entry.sessionId === sessionId);
	await fixture.requestRpc({
		_tag: "ContinueSession",
		sessionId,
		instanceId: b,
		expectedInstanceId: "claude",
	});
	const inputId = randomUUID();
	const prompt = `recovered-pending-rebind-${action}`;
	await Effect.runPromise(
		browser.rpc["input.submit"]({
			sessionId,
			originId: browser.originId,
			inputId,
			delivery: "queue",
			text: prompt,
		}),
	);
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const command = () =>
			db
				.prepare<[string], { status: string; error_code: string | null }>(
					"SELECT status, error_code FROM provider_command_outbox WHERE command_id = ? AND effect_type = 'send_turn'",
				)
				.get(inputId);
		await vi.waitFor(() => expect(command()?.status).toBe("running"));
		expect(fixture.claudeOptions()).toHaveLength(1);
		await fixture.kill();
		if (action === "cancel-preparing") {
			const profile = join(fixture.root, "home/.zprofile");
			writeFileSync(
				profile,
				'printf ready > "$ZDOTDIR/recovery-env-started"\nwhile [ ! -f "$ZDOTDIR/release-recovery-env" ]; do sleep 0.02; done\n' +
					readFileSync(profile, "utf8"),
			);
		}
		const marksBefore = fixture.proof().marks.length;
		await fixture.restart();
		browser = await fixture.connect(sessionId);
		await fixture.waitForMark(
			(mark) => mark.kind === "runner-started" && mark.pid === controller?.pid,
			marksBefore,
		);
		if (action === "cancel-preparing")
			await vi.waitFor(() =>
				expect(
					existsSync(join(fixture.root, "home/recovery-env-started")),
				).toBe(true),
			);
		if (action === "remove-account")
			await fixture.requestRpc({ _tag: "RemoveInstance", instanceId: b });
		let cancel: unknown;
		if (action === "control")
			cancel = await Effect.runPromise(
				browser.rpc
					.StopBackgroundTask({ sessionId, taskId: "upgrade-background-task" })
					.pipe(Effect.timeoutOption("3 seconds")),
			);
		if (action === "cancel" || action === "cancel-preparing") {
			cancel = await Effect.runPromise(
				browser.rpc
					.CancelSession({ sessionId, commandId: randomUUID() })
					.pipe(Effect.as("cancelled"), Effect.timeoutOption("5 seconds")),
			);
		}
		const beforeRelease = command();
		if (action === "cancel-preparing")
			writeFileSync(join(fixture.root, "home/release-recovery-env"), "release");
		if (action === "end")
			await Effect.runPromise(
				browser.rpc
					.DeleteSession({ sessionId })
					.pipe(Effect.timeout("5 seconds")),
			);
		writeFileSync(join(fixture.root, "release-upgrade-background"), "release");
		if (action === "end")
			await vi.waitFor(
				() =>
					expect(
						discoverRunners(fixture.projectDir, fixture.configDir).find(
							(entry) => entry.sessionId === sessionId,
						),
					).toBeUndefined(),
				{ timeout: 5_000 },
			);
		else
			await vi.waitFor(() => expect(command()?.status).not.toBe("running"), {
				timeout: 10_000,
			});
		const requests = readFileSync(
			join(fixture.root, "sdk-proof.ndjson"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; request?: string })
			.filter(({ kind }) => kind === "enqueue")
			.map(({ request }) => request);
		proofs.push({
			action,
			legacy,
			sessionId,
			command: command(),
			cancel,
			beforeRelease,
			requests,
		});
		if (action === "control")
			expect(cancel).toMatchObject({ _tag: "Some", value: { ok: true } });
		if (action === "end") {
			expect(requests).toEqual(["upgrade-background-work"]);
		} else if (action === "cancel" || action === "cancel-preparing") {
			expect(cancel).toMatchObject({ _tag: "Some", value: "cancelled" });
			expect(beforeRelease).toMatchObject({
				status: "failed",
				error_code: "cancelled",
			});
			expect(requests).toEqual(["upgrade-background-work"]);
			expect(command()).toMatchObject({
				status: "failed",
				error_code: "cancelled",
			});
			await browser.send(sessionId, "retry-after-recovered-cancel");
		} else {
			expect(command()).toMatchObject({
				status: "completed",
				error_code: null,
			});
			expect(requests).toEqual(["upgrade-background-work", prompt]);
			expect(fixture.claudeOptions().at(-1)).toMatchObject({
				configDir,
				options: { env: { ACCOUNT_OWNER: "B" } },
			});
		}
		const after = discoverRunners(fixture.projectDir, fixture.configDir).find(
			(entry) => entry.sessionId === sessionId,
		);
		if (action === "end") expect(after).toBeUndefined();
		else if (legacy) expect(after?.runnerId).not.toBe(controller?.runnerId);
		else expect(after?.runnerId).toBe(controller?.runnerId);
	} finally {
		if (action === "cancel-preparing")
			writeFileSync(join(fixture.root, "home/release-recovery-env"), "release");
		db.close();
	}
}, 45_000);

it("starts a goal after rebinding at the persisted cumulative token total", async () => {
	const fixture = ProcessHarness.create({ dist: "dist", restartProof: true });
	harness = fixture;
	await fixture.restart();
	const browser = await fixture.connect();
	const configDir = join(fixture.root, "account-b");
	mkdirSync(configDir);
	const { addedInstanceId: b } = await fixture.requestRpc({
		_tag: "AddInstance",
		name: "B",
		driver: "claude",
		configDir,
	});
	if (!b) throw new Error("Missing fixture account");
	const sessionId = await browser.createSession("Goal after rebinding");
	await browser.send(sessionId, "before-rebind-goal");
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const total = db
			.prepare<[string], { tokens: number }>(
				`SELECT COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)
					+ COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_write, 0)), 0) AS tokens
				FROM messages WHERE session_id = ?`,
			)
			.get(sessionId)?.tokens;
		expect(total).toBeGreaterThan(0);
		await fixture.requestRpc({
			_tag: "ContinueSession",
			sessionId,
			instanceId: b,
			expectedInstanceId: "claude",
		});
		await browser.send(sessionId, "goal-rebind");
		const goals = db
			.prepare<[string], { data: string }>(
				"SELECT data FROM events WHERE session_id = ? AND type = 'session.goal_changed' ORDER BY sequence",
			)
			.all(sessionId)
			.map(({ data }) => JSON.parse(data) as unknown);
		proofs.push({ sessionId, total, goals });
		expect(goals).toEqual([
			expect.objectContaining({
				goal: expect.objectContaining({
					condition: "After rebinding",
					tokensAtStart: total,
				}),
			}),
		]);
	} finally {
		db.close();
	}
}, 30_000);
