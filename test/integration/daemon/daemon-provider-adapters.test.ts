import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

interface AdapterObservation {
	daemonPid: number;
	kind:
		| "adapter-constructed"
		| "send"
		| "shutdown"
		| "recovery-start"
		| "recovery-end"
		| "outbox-drain"
		| "engine-drain-started"
		| "account-scope-use"
		| "invalidation-start"
		| "invalidation-end";
	driver?: string;
	identity?: string;
	sessionId?: string;
	projectId?: string;
	accountId?: string;
	workspaceRoot?: string;
	extraFolders?: string[];
	resourceIdentity?: number;
	engineIdentity?: number;
}

// Failure modes: project-local adapters/recovery, a project finalizer closing a
// shared adapter, cross-project launch context, and a restart killing retained
// runners or managed OpenCode instead of detaching them.
describe("daemon-owned provider adapters", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	const scenarios: Record<string, unknown>[] = [];
	beforeEach(() => {
		evidence = {};
	});
	const observations = () => {
		if (!harness) return [];
		const path = join(harness.root, "daemon-adapters.ndjson");
		return existsSync(path)
			? readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as AdapterObservation)
			: [];
	};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		await fixture.terminate();
		const rows = observations();
		await fixture.dispose();
		const generations = [
			...new Set(rows.map(({ daemonPid }) => daemonPid)),
		].map((daemonPid) => ({
			daemonPid,
			registeredAdapterConstructions: Object.fromEntries(
				["claude", "cursor", "opencode"].map((driver) => [
					driver,
					rows.filter(
						(row) =>
							row.daemonPid === daemonPid &&
							row.kind === "adapter-constructed" &&
							row.driver === driver,
					).length,
				]),
			),
			shutdownCalls: Object.fromEntries(
				["claude", "cursor", "opencode"].map((driver) => [
					driver,
					rows.filter(
						(row) =>
							row.daemonPid === daemonPid &&
							row.kind === "shutdown" &&
							row.driver === driver,
					).length,
				]),
			),
		}));
		scenarios.push({
			scenario: task.name,
			result: task.result?.state,
			failures: task.result?.errors?.map(({ message }) => message),
			observations: rows,
			generations,
			...evidence,
			cleanup: {
				remainingRunnerPids: fixture.remainingRunnerPids(),
				generations: fixture.generations,
			},
		});
		const artifact = JSON.stringify(
			{ bead: "conduit-test-82tn.9.7", scenarios },
			null,
			2,
		);
		mkdirSync("test-results", { recursive: true });
		writeFileSync("test-results/82tn-9-7-daemon-adapters.json", artifact);
		writeFileSync("/tmp/82tn-9-7-daemon-adapters.json", artifact);
		harness = undefined;
	});

	it.each([
		false,
		true,
	])("stops a settled runner when its last background task finishes, restart=%s", async (restart) => {
		harness = await ProcessHarness.start({
			restartProof: true,
			runnerLifecycle: { idleTimeoutMs: null },
		});
		const fixture = harness;
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Settled background work");
		expect(
			(await browser.send(sessionId, "upgrade-background-work")).chunks.join(
				"",
			),
		).toBe(responseChunks("upgrade-background-work").join(""));
		const runner = fixture.marks.find(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
		);
		if (runner?.kind !== "runner-started")
			throw new Error("Missing background runner");
		const socket = join(fixture.configDir, "relay.sock");
		await sendRpcRequest(socket, {
			_tag: "SetSessionSettled",
			sessionId,
			settled: true,
		});
		// Drain the settle request while the task still protects the runner.
		await sendRpcRequest(socket, {
			_tag: "CleanUpWorktreesNow",
			projectSlug: "process-test",
		});
		if (restart) {
			await fixture.kill();
			await fixture.restart();
			await fixture.connect(sessionId);
		}
		expect(() => process.kill(runner.pid, 0)).not.toThrow();
		evidence = { sessionId, runnerPid: runner.pid, restart };
		writeFileSync(join(fixture.root, "release-upgrade-background"), "release");
		// No manual sweep or new turn: completion alone must stop this PID.
		await vi.waitFor(
			() => expect(() => process.kill(runner.pid, 0)).toThrow(),
			{
				timeout: 15_000,
			},
		);
		evidence["stoppedAfterBackgroundCompletion"] = true;
	}, 60_000);

	it("shares three adapters, isolates project and account removal, and detaches retained processes on restart", async () => {
		harness = ProcessHarness.create({
			managedOpenCode: true,
			restartProof: true,
			runnerLifecycle: { idleTimeoutMs: null },
			managedOpenCodeStopGraceMs: 100,
		});
		const fixture = harness;
		writeFileSync(join(fixture.root, "daemon-adapters-proof"), "");
		const projectB = join(fixture.root, "project-b");
		const extraA = join(fixture.root, "extra-a");
		const extraB = join(fixture.root, "extra-b");
		const claudeAccountA = join(fixture.root, "claude-a");
		const claudeAccountB = join(fixture.root, "claude-b");
		for (const directory of [
			projectB,
			extraA,
			extraB,
			claudeAccountA,
			claudeAccountB,
		])
			mkdirSync(directory, { recursive: true });
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: [
					{
						path: fixture.projectDir,
						folders: [fixture.projectDir, extraA],
						slug: "process-test",
						addedAt: 1,
					},
					{
						path: projectB,
						folders: [projectB, extraB],
						slug: "project-b",
						addedAt: 2,
					},
				],
			} satisfies DaemonConfig),
		);
		const cursorGate = join(fixture.root, "cursor-stream-gate");
		const cursorCapture = join(fixture.root, "cursor-capture.jsonl");
		const cursorAuth = join(fixture.root, "cursor-auth.json");
		writeFileSync(cursorAuth, JSON.stringify({ accounts: {} }));
		const restart = () =>
			fixture.restart({
				startupTimeoutMs: 90_000,
				runnerStartupTimeoutMs: 90_000,
				serviceEnvironment: {
					CONDUIT_CURSOR_SDK_TRACE: resolve(
						"test/fixtures/cursor-sdk-traces/basic.jsonl",
					),
					CONDUIT_CURSOR_SDK_CAPTURE: cursorCapture,
					CONDUIT_TEST_CURSOR_AUTH_STATE: cursorAuth,
					CONDUIT_TEST_CURSOR_STREAM_GATE: cursorGate,
				},
			});
		await restart();
		const bootstrapAccounts = (
			await fixture.requestRpc({ _tag: "GetInstances" })
		).instances;
		for (const account of bootstrapAccounts.filter(
			({ id, driver }) => driver === "opencode" && id !== "managed-test",
		))
			await fixture.requestRpc({
				_tag: "RemoveInstance",
				instanceId: account.id,
			});
		const addAccount = async (
			name: string,
			driver: "claude" | "cursor",
			configDir?: string,
		) => {
			const added = await fixture.requestRpc({
				_tag: "AddInstance",
				name,
				driver,
				...(configDir ? { configDir } : {}),
			});
			if (!added.addedInstanceId)
				throw new Error(`Missing isolated ${name} account`);
			return added.addedInstanceId;
		};
		const claudeA = (
			await fixture.requestRpc({ _tag: "GetInstances" })
		).instances.find(({ driver }) => driver === "claude")?.id;
		if (!claudeA) throw new Error("Missing default isolated Claude account");
		await fixture.requestRpc({
			_tag: "UpdateInstance",
			instanceId: claudeA,
			configDir: claudeAccountA,
		});
		const claudeB = await addAccount("Claude B", "claude", claudeAccountB);
		const cursorA = await addAccount("Cursor A", "cursor");
		const cursorB = await addAccount("Cursor B", "cursor");
		writeFileSync(
			cursorAuth,
			JSON.stringify({
				accounts: Object.fromEntries(
					[cursorA, cursorB].map((accountId) => [
						accountId,
						{
							status: { status: "logged-in" },
							credential: {
								apiKey: `[REDACTED:${accountId}]`,
								backendUrl: "https://api2.cursor.sh",
								createdAtMs: 0,
							},
						},
					]),
				),
			}),
		);
		const a = await fixture.connect();
		let b = await fixture.connect(undefined, undefined, "project-b");
		const sessions: Array<{
			id: string;
			driver: "claude" | "cursor" | "opencode";
			account: string;
			project: string;
			directory: string;
			extra: string;
		}> = [];
		for (const project of [
			{
				browser: a,
				slug: "process-test",
				directory: fixture.projectDir,
				extra: extraA,
				claude: claudeA,
				cursor: cursorA,
				opencode: "managed-test",
			},
			{
				browser: b,
				slug: "project-b",
				directory: projectB,
				extra: extraB,
				claude: claudeB,
				cursor: cursorB,
				opencode: "managed-test",
			},
		]) {
			for (const driver of ["claude", "cursor", "opencode"] as const) {
				const account = project[driver];
				const id = await project.browser.createSession(
					`${project.slug} ${driver}`,
					account,
					driver,
					driver === "cursor"
						? { modelId: "composer-2.5", contextWindow: "" }
						: {},
				);
				sessions.push({
					id,
					driver,
					account,
					project: project.slug,
					directory: project.directory,
					extra: project.extra,
				});
			}
		}
		const rows = observations();
		const constructions = rows.filter(
			({ kind }) => kind === "adapter-constructed",
		);
		expect(constructions.map(({ driver }) => driver).sort()).toEqual([
			"claude",
			"cursor",
			"opencode",
		]);
		const recoveries = rows.filter(({ kind }) => kind === "recovery-end");
		expect(recoveries.map(({ driver }) => driver).sort()).toEqual([
			"claude",
			"cursor",
		]);
		const firstDrain = rows.findIndex(({ kind }) => kind === "outbox-drain");
		expect(firstDrain).toBeGreaterThan(-1);
		expect(
			rows.slice(0, firstDrain).filter(({ kind }) => kind === "recovery-end"),
		).toHaveLength(2);
		const initialPid = rows[0]?.daemonPid;
		expect(initialPid).toBeGreaterThan(0);
		const send = (id: string, text: string) =>
			fixture.requestRpc({
				_tag: "input.submit",
				sessionId: id,
				originId: "daemon-adapters-proof",
				inputId: randomUUID(),
				delivery: "queue",
				text,
			});
		writeFileSync(join(fixture.configDir, "fake-opencode-hold-turn"), "hold");
		for (const session of sessions) {
			if (session.driver === "opencode")
				await send(session.id, `routing-${session.project}`);
			else
				await (session.project === "process-test" ? a : b).send(
					session.id,
					`routing-${session.driver}-${session.project}`,
					90_000,
				);
		}
		await vi.waitFor(
			() =>
				expect(
					observations().filter(({ kind }) => kind === "send"),
				).toHaveLength(6),
			{ timeout: 10_000 },
		);
		for (const session of sessions) {
			expect(
				observations().find(
					(row) => row.kind === "send" && row.sessionId === session.id,
				),
			).toMatchObject({
				driver: session.driver,
				projectId: session.project,
				accountId: session.account,
				workspaceRoot: session.directory,
				extraFolders: [session.extra],
				identity: constructions.find(({ driver }) => driver === session.driver)
					?.identity,
			});
		}
		const nativeLaunches = fixture
			.claudeOptions()
			.filter(({ prompt }) => prompt?.startsWith("routing-claude-"));
		for (const session of sessions.filter(
			({ driver }) => driver === "claude",
		)) {
			const launch = nativeLaunches.find(
				({ prompt }) => prompt === `routing-claude-${session.project}`,
			);
			expect(launch).toMatchObject({
				configDir:
					session.project === "process-test" ? claudeAccountA : claudeAccountB,
				options: {
					cwd: session.directory,
					additionalDirectories: [session.extra],
				},
			});
		}
		const cursorLaunches = readFileSync(cursorCapture, "utf8")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						kind: string;
						data: {
							credentialFingerprint?: string;
							local?: { cwd: string; dirs: string[] };
						};
					},
			)
			.filter(({ kind }) => kind === "create.options");
		for (const session of sessions.filter(({ driver }) => driver === "cursor"))
			expect(
				cursorLaunches.some(
					({ data }) =>
						data.local?.cwd === session.directory &&
						data.local.dirs.includes(session.extra),
				),
			).toBe(true);
		expect(
			new Set(cursorLaunches.map(({ data }) => data.credentialFingerprint))
				.size,
		).toBe(2);
		await vi.waitFor(
			() => {
				const prompts = fixture
					.opencodeRequests()
					.filter(({ url }) =>
						new URL(url, "http://fixture.invalid").pathname.endsWith(
							"/prompt_async",
						),
					);
				for (const session of sessions.filter(
					({ driver }) => driver === "opencode",
				))
					expect(
						prompts.some(
							({ url, directory }) =>
								decodeURIComponent(
									directory ??
										new URL(url, "http://fixture.invalid").searchParams.get(
											"directory",
										) ??
										"",
								) === session.directory,
						),
					).toBe(true);
			},
			{ timeout: 10_000 },
		);
		const survivingSessions = sessions.filter(
			({ project }) => project === "project-b",
		);
		const claudeSession = survivingSessions.find(
			({ driver }) => driver === "claude",
		);
		const cursorSession = survivingSessions.find(
			({ driver }) => driver === "cursor",
		);
		if (!claudeSession || !cursorSession)
			throw new Error("Missing surviving provider sessions");
		await fixture.requestRpc({ _tag: "GetCursorAuth", accountId: cursorB });
		const resourceBefore = observations()
			.filter(
				({ kind, accountId }) =>
					kind === "account-scope-use" && accountId === cursorB,
			)
			.at(-1)?.resourceIdentity;
		expect(resourceBefore).toBeGreaterThan(0);
		writeFileSync(cursorGate, "hold");
		const claudePending = b
			.send(claudeSession.id, "tool-long-daemon-adapters", 90_000)
			.catch(() => undefined);
		const cursorPending = b
			.send(cursorSession.id, "Held Cursor survivor", 90_000)
			.catch(() => undefined);
		await vi.waitFor(
			() => {
				expect(
					fixture
						.claudeOptions()
						.some(({ prompt }) => prompt === "tool-long-daemon-adapters"),
				).toBe(true);
				expect(readFileSync(cursorCapture, "utf8")).toContain(
					'"prompt":"Held Cursor survivor"',
				);
			},
			{ timeout: 30_000 },
		);
		await vi.waitFor(
			async () => {
				expect(
					(await b.history(claudeSession.id)).some((message) =>
						message.parts?.some(
							(part) =>
								part.type === "tool" && part.state?.["status"] === "running",
						),
					),
				).toBe(true);
			},
			{ timeout: 10_000 },
		);
		const survivingPids = survivingSessions
			.filter(({ driver }) => driver !== "opencode")
			.map(({ id }) => {
				const mark = fixture.marks.find(
					(entry) => entry.kind === "runner-started" && entry.sessionId === id,
				);
				if (mark?.kind !== "runner-started")
					throw new Error(`Missing runner for ${id}`);
				return { sessionId: id, pid: mark.pid };
			});
		const openCodePid = () =>
			(
				JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig
			).instances?.find(({ id }) => id === "managed-test")?.pid;
		const serverPid = openCodePid();
		expect(serverPid).toBeGreaterThan(0);
		evidence = {
			routing: sessions,
			nativeRouting: {
				claude: nativeLaunches.map(({ pid, prompt, configDir, options }) => ({
					pid,
					prompt,
					configDir,
					cwd: options["cwd"],
					extraFolders: options["additionalDirectories"],
				})),
				cursor: cursorLaunches.map(({ data }) => ({
					cwd: data.local?.cwd,
					extraFolders: data.local?.dirs,
					credentialFingerprint: data.credentialFingerprint,
				})),
				opencode: fixture
					.opencodeRequests()
					.filter(({ url }) =>
						new URL(url, "http://fixture.invalid").pathname.endsWith(
							"/prompt_async",
						),
					),
			},
			survivingPids,
			openCodePidBefore: serverPid,
			cursorResourceBefore: resourceBefore,
		};
		await fixture.requestRpc({ _tag: "RemoveProject", slug: "process-test" });
		const removals: Array<{
			accountId: string;
			waitedForInvalidation: boolean;
		}> = [];
		for (const driver of ["claude", "cursor", "opencode"] as const) {
			const accountId =
				driver === "claude"
					? claudeA
					: driver === "cursor"
						? cursorA
						: (
								await fixture.requestRpc({
									_tag: "AddInstance",
									name: "OpenCode removal",
									driver: "opencode",
									managed: true,
									port: 0,
									env: { CONDUIT_TEST_OPENCODE_STATE_PREFIX: "removal" },
								})
							).addedInstanceId;
			if (!accountId) throw new Error(`Missing ${driver} account to remove`);
			if (driver === "opencode")
				await fixture.requestRpc({
					_tag: "StartInstance",
					instanceId: accountId,
				});
			const gate = join(fixture.root, `invalidate-${accountId}.hold`);
			writeFileSync(gate, "hold");
			let returned = false;
			const removing = fixture
				.requestRpc({ _tag: "RemoveInstance", instanceId: accountId })
				.finally(() => {
					returned = true;
				});
			try {
				await vi.waitFor(
					() =>
						expect(
							observations().some(
								(row) =>
									row.kind === "invalidation-start" &&
									row.accountId === accountId,
							),
						).toBe(true),
					{ timeout: 5000 },
				);
				await setTimeout(50);
				expect(
					returned,
					`${accountId} removal returned while its scope invalidation was held`,
				).toBe(false);
			} finally {
				rmSync(gate, { force: true });
				await removing;
			}
			expect(
				observations().some(
					(row) =>
						row.kind === "invalidation-end" && row.accountId === accountId,
				),
			).toBe(true);
			removals.push({ accountId, waitedForInvalidation: true });
		}
		await fixture.requestRpc({ _tag: "GetCursorAuth", accountId: cursorB });
		const resourceAfter = observations()
			.filter(
				({ kind, accountId }) =>
					kind === "account-scope-use" && accountId === cursorB,
			)
			.at(-1)?.resourceIdentity;
		expect(resourceAfter).toBe(resourceBefore);
		expect(observations().filter(({ kind }) => kind === "shutdown")).toEqual(
			[],
		);
		expect(
			observations().filter(({ kind }) => kind === "adapter-constructed"),
		).toHaveLength(3);
		for (const { pid } of survivingPids)
			expect(() => process.kill(pid, 0)).not.toThrow();
		expect(openCodePid()).toBe(serverPid);
		expect(
			(await b.history(claudeSession.id)).some((message) =>
				message.parts?.some(
					(part) =>
						part.type === "tool" && part.state?.["status"] === "running",
				),
			),
		).toBe(true);
		evidence = {
			...evidence,
			removal: {
				accounts: removals,
				cursorResourceAfter: resourceAfter,
				survivingPids,
				openCodePid: serverPid,
			},
		};
		await fixture.terminate();
		await Promise.all([claudePending, cursorPending]);
		for (const { pid } of survivingPids)
			expect(() => process.kill(pid, 0)).not.toThrow();
		if (serverPid === undefined)
			throw new Error("Missing managed OpenCode PID");
		expect(() => process.kill(serverPid, 0)).not.toThrow();
		expect(
			observations()
				.filter(
					({ kind, daemonPid }) =>
						kind === "shutdown" && daemonPid === initialPid,
				)
				.map(({ driver }) => driver)
				.sort(),
		).toEqual(["claude", "cursor", "opencode"]);
		await restart();
		b = await fixture.connect(undefined, undefined, "project-b");
		const nextRows = observations().filter(
			({ daemonPid }) => daemonPid !== initialPid,
		);
		expect(
			nextRows
				.filter(({ kind }) => kind === "adapter-constructed")
				.map(({ driver }) => driver)
				.sort(),
		).toEqual(["claude", "cursor", "opencode"]);
		const nextDrain = nextRows.findIndex(({ kind }) => kind === "outbox-drain");
		expect(nextDrain).toBeGreaterThan(-1);
		expect(
			nextRows
				.slice(0, nextDrain)
				.filter(({ kind }) => kind === "recovery-end")
				.map(({ driver }) => driver)
				.sort(),
		).toEqual(["claude", "cursor"]);
		for (const { pid } of survivingPids)
			expect(() => process.kill(pid, 0)).not.toThrow();
		expect(openCodePid()).toBe(serverPid);
		writeFileSync(join(fixture.root, "release-tool-long"), "release");
		rmSync(cursorGate);
		for (const session of [claudeSession, cursorSession])
			expect(
				(
					await b.send(session.id, "Survives removal and restart", 90_000)
				).chunks.join(""),
			).not.toBe("");
		for (const { sessionId, pid } of survivingPids) {
			const marks = fixture.marks.filter(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			);
			expect(
				marks.every(
					(mark) => mark.kind === "runner-started" && mark.pid === pid,
				),
			).toBe(true);
		}
		evidence = {
			...evidence,
			restart: {
				survivingPids,
				openCodePid: openCodePid(),
				retainedRunnersReused: true,
			},
		};
		await fixture.shutdown();
		const nextPid = nextRows[0]?.daemonPid;
		expect(
			observations()
				.filter(
					({ kind, daemonPid }) => kind === "shutdown" && daemonPid === nextPid,
				)
				.map(({ driver }) => driver)
				.sort(),
		).toEqual(["claude", "cursor", "opencode"]);
		await vi.waitFor(
			() => {
				for (const { pid } of survivingPids)
					expect(() => process.kill(pid, 0)).toThrow();
				expect(() => process.kill(serverPid, 0)).toThrow();
			},
			{ timeout: 10_000 },
		);
	}, 180_000);

	it("preserves a running session when new project folders replace its relay", async () => {
		harness = ProcessHarness.create({
			restartProof: true,
			runnerLifecycle: { idleTimeoutMs: null },
		});
		const fixture = harness;
		writeFileSync(join(fixture.root, "daemon-adapters-proof"), "");
		await fixture.restart();
		let browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Keep the same runner across relay replacement",
		);
		const pending = browser
			.send(sessionId, "tool-long-replace-project-relay", 30_000)
			.catch(() => undefined);
		const started = await fixture.waitForMark(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
		);
		if (started.kind !== "runner-started")
			throw new Error("Missing runner identity");
		await vi.waitFor(
			async () =>
				expect(
					(await browser.history(sessionId)).some((message) =>
						message.parts?.some(
							(part) =>
								part.type === "tool" && part.state?.["status"] === "running",
						),
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		const extra = join(fixture.root, "added-folder");
		mkdirSync(extra);
		const replacement = await fixture.requestRpc({
			_tag: "SaveProject",
			slug: "process-test",
			folders: [fixture.projectDir, extra],
		});
		expect(replacement.savedSlug).toBe("process-test");
		expect(
			(await fixture.requestRpc({ _tag: "GetProjects" })).projects.find(
				({ slug }) => slug === "process-test",
			)?.folders,
		).toEqual([fixture.projectDir, extra]);
		expect(() => process.kill(started.pid, 0)).not.toThrow();
		browser = await fixture.connect(sessionId);
		const stop = fixture.requestRpc({
			_tag: "CancelSession",
			sessionId,
			commandId: randomUUID(),
		});
		const sdkProof = join(fixture.root, "sdk-proof.ndjson");
		await vi.waitFor(
			() =>
				expect(readFileSync(sdkProof, "utf8")).toContain(
					'"kind":"query-interrupted"',
				),
			{ timeout: 5000 },
		);
		const beforeFreshSend = fixture.marks.filter(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
		);
		expect(
			beforeFreshSend.every(
				(mark) => mark.kind === "runner-started" && mark.pid === started.pid,
			),
		).toBe(true);
		writeFileSync(join(fixture.root, "release-tool-long"), "release");
		await stop;
		expect(
			(
				await browser.send(
					sessionId,
					"After replacing the project relay",
					15_000,
				)
			).chunks.join(""),
		).not.toBe("");
		const pids = fixture.marks
			.filter(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			)
			.map((mark) => (mark.kind === "runner-started" ? mark.pid : undefined));
		const nextLaunch = fixture
			.claudeOptions()
			.find(({ prompt }) => prompt === "After replacing the project relay");
		expect(nextLaunch?.options["additionalDirectories"]).toEqual([extra]);
		evidence = {
			sessionId,
			runnerPidBefore: started.pid,
			runnerPidsAfter: pids,
			folderAdded: extra,
			interruptedThroughReplacement: true,
			newCallExtraFolders: nextLaunch?.options["additionalDirectories"],
		};
		await fixture.terminate();
		await pending;
	}, 60_000);

	it("recovers retained runners from both registered projects once before either project's outbox drains", async () => {
		harness = ProcessHarness.create({
			restartProof: true,
			runnerLifecycle: { idleTimeoutMs: null },
		});
		const fixture = harness;
		writeFileSync(join(fixture.root, "daemon-adapters-proof"), "");
		const projectB = join(fixture.root, "project-b");
		mkdirSync(projectB);
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: [
					{
						path: fixture.projectDir,
						folders: [fixture.projectDir],
						slug: "process-test",
						addedAt: 1,
					},
					{
						path: projectB,
						folders: [projectB],
						slug: "project-b",
						addedAt: 2,
					},
				],
			} satisfies DaemonConfig),
		);
		await fixture.restart();
		const pending: Promise<unknown>[] = [];
		const sessions: Array<{
			projectId: string;
			sessionId: string;
			pid: number;
			queryId: string;
		}> = [];
		for (const projectId of ["process-test", "project-b"]) {
			const browser = await fixture.connect(undefined, undefined, projectId);
			const sessionId = await browser.createSession(`Retained ${projectId}`);
			pending.push(
				browser
					.send(sessionId, `tool-long-recover-${projectId}`, 90_000)
					.catch(() => undefined),
			);
			const runner = await fixture.waitForMark(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			);
			if (runner.kind !== "runner-started")
				throw new Error(`Missing ${projectId} runner`);
			await vi.waitFor(
				async () =>
					expect(
						(await browser.history(sessionId)).some((message) =>
							message.parts?.some(
								(part) =>
									part.type === "tool" && part.state?.["status"] === "running",
							),
						),
					).toBe(true),
				{ timeout: 10_000 },
			);
			const query = fixture.marks.find(
				(mark) => mark.kind === "query" && mark.runnerSessionId === sessionId,
			);
			if (query?.kind !== "query")
				throw new Error(`Missing ${projectId} query`);
			sessions.push({
				projectId,
				sessionId,
				pid: runner.pid,
				queryId: query.queryId,
			});
		}
		expect(new Set(sessions.map(({ pid }) => pid)).size).toBe(2);
		const beforePid = observations()[0]?.daemonPid;
		evidence = { sessions };
		await fixture.terminate();
		await Promise.all(pending);
		for (const { pid } of sessions)
			expect(() => process.kill(pid, 0)).not.toThrow();
		await fixture.restart({ startupTimeoutMs: 90_000 });
		const restarted = observations().filter(
			({ daemonPid }) => daemonPid !== beforePid,
		);
		const recoveryStarts = restarted.filter(
			({ kind }) => kind === "recovery-start",
		);
		const recoveryEnds = restarted.filter(
			({ kind }) => kind === "recovery-end",
		);
		expect(recoveryStarts.map(({ driver }) => driver).sort()).toEqual([
			"claude",
			"cursor",
		]);
		expect(recoveryEnds.map(({ driver }) => driver).sort()).toEqual([
			"claude",
			"cursor",
		]);
		const drains = restarted.filter(({ kind }) => kind === "outbox-drain");
		expect(
			new Set(drains.map(({ engineIdentity }) => engineIdentity)).size,
		).toBe(1);
		expect(drains.every(({ projectId }) => projectId === undefined)).toBe(true);
		expect(
			restarted.filter(({ kind }) => kind === "engine-drain-started"),
		).toHaveLength(1);
		const firstDrain = restarted.findIndex(
			({ kind }) => kind === "outbox-drain",
		);
		expect(
			restarted
				.slice(0, firstDrain)
				.filter(({ kind }) => kind === "recovery-end"),
		).toHaveLength(2);
		for (const { sessionId, pid } of sessions) {
			expect(() => process.kill(pid, 0)).not.toThrow();
			const adoptions = fixture.marks.filter(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			);
			expect(adoptions.length).toBeGreaterThanOrEqual(2);
			expect(
				adoptions.every(
					(mark) => mark.kind === "runner-started" && mark.pid === pid,
				),
			).toBe(true);
		}
		const stops = Promise.all(
			sessions.map(({ sessionId }) =>
				fixture.requestRpc({
					_tag: "CancelSession",
					sessionId,
					commandId: randomUUID(),
				}),
			),
		);
		const sdkProof = join(fixture.root, "sdk-proof.ndjson");
		await vi.waitFor(
			() => {
				const rows = readFileSync(sdkProof, "utf8")
					.trim()
					.split("\n")
					.map(
						(line) => JSON.parse(line) as { kind: string; queryId?: string },
					);
				for (const { queryId } of sessions)
					expect(
						rows.some(
							(row) =>
								row.kind === "query-interrupted" && row.queryId === queryId,
						),
					).toBe(true);
			},
			{ timeout: 10_000 },
		);
		writeFileSync(join(fixture.root, "release-tool-long"), "release");
		await stops;
		for (const { sessionId, projectId, pid } of sessions) {
			const browser = await fixture.connect(sessionId, undefined, projectId);
			expect(
				(
					await browser.send(sessionId, `Continues in ${projectId}`, 15_000)
				).chunks.join(""),
			).not.toBe("");
			expect(
				fixture.marks
					.filter(
						(mark) =>
							mark.kind === "runner-started" && mark.sessionId === sessionId,
					)
					.every((mark) => mark.kind === "runner-started" && mark.pid === pid),
			).toBe(true);
		}
		evidence = {
			...evidence,
			startupRecovery: {
				recoveryStarts,
				recoveryEnds,
				drains,
				beforeEitherOutbox: true,
			},
			bothControlsReachedRetainedQueries: true,
			retainedPidsReused: true,
		};
		await fixture.shutdown();
	}, 150_000);
});
