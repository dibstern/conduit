import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

type Driver = "claude" | "cursor" | "opencode";
interface Observation {
	kind: string;
	driver?: Driver;
	identity?: string;
	constructorName?: string;
	sessionId?: string;
	projectId?: string;
	accountId?: string;
	workspaceRoot?: string;
	extraFolders?: string[];
	shellMarker?: string;
	resourceIdentity?: number;
	generation?: number;
}
interface CursorCapture {
	kind?: string;
	data?: {
		agentId?: string;
		credentialFingerprint?: string;
		local?: {
			cwd: string;
			dirs: string[];
			store: { stateRoot: string; workspaceRef: string };
		};
	};
}

let harness: ProcessHarness | undefined;
const evidence: Record<string, unknown> = {};
const rows = () => {
	const file = harness && join(harness.root, "daemon-adapters.ndjson");
	return file && existsSync(file)
		? readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Observation)
		: [];
};

afterEach(async ({ task }) => {
	if (!harness) return;
	const fixture = harness;
	try {
		evidence["observations"] = rows();
		evidence["ambientMiseInvoked"] = existsSync(
			join(fixture.root, "ambient-mise-invoked"),
		);
		await fixture.dispose();
		const cleanup = fixture.proof();
		evidence["cleanup"] = {
			remainingRunnerPids: fixture.remainingRunnerPids(),
			managedCleanup: cleanup.managedCleanup,
			remainingObservedOpenCodePids: cleanup.remainingObservedOpenCodePids,
			generations: fixture.generations,
		};
		expect(fixture.remainingRunnerPids()).toEqual([]);
		expect(cleanup.remainingObservedOpenCodePids).toEqual([]);
	} finally {
		const artifact = JSON.stringify(
			{
				bead: "conduit-test-82tn.9.8",
				result: task.result?.state,
				failures: task.result?.errors?.map(({ message }) => message),
				...evidence,
			},
			null,
			2,
		);
		mkdirSync("test-results", { recursive: true });
		writeFileSync("test-results/82tn-9-driver-accounts.json", `${artifact}\n`);
		writeFileSync("/tmp/82tn-9-driver-accounts.json", `${artifact}\n`);
		harness = undefined;
	}
});

// Failure modes: project-owned adapters, captured launch context, shared account
// resources, removal closing unrelated resources, and continuation losing the
// session-owned native identity or transcript. All processes use fixture HOME.
it("proves daemon driver ownership, account isolation, launch context and continuation through one process", async () => {
	harness = ProcessHarness.create({
		managedOpenCode: true,
		restartProof: true,
		shellEnvProof: true,
		runnerLifecycle: { idleTimeoutMs: null },
		managedOpenCodeStopGraceMs: 100,
	});
	const fixture = harness;
	// Keep global startup files from reordering the inherited tool PATH.
	appendFileSync(
		join(fixture.root, "home", ".zshenv"),
		"unsetopt GLOBAL_RCS\n",
	);
	// Ambient tool failures must not replace the profile proof with fallback env.
	writeFileSync(
		join(fixture.root, "bin", "mise"),
		`#!/bin/sh\n: > "\${0%/*}/../ambient-mise-invoked"\nexit 91\n`,
		{ mode: 0o755 },
	);
	writeFileSync(join(fixture.root, "daemon-adapters-proof"), "");
	const projectB = join(fixture.root, "project-b");
	const extraA = join(fixture.root, "extra-a");
	const extraB = join(fixture.root, "extra-b");
	const claudeAPath = join(fixture.root, "claude-a");
	for (const path of [projectB, extraA, extraB, claudeAPath])
		mkdirSync(path, { recursive: true });
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
					shellEnv: { overrides: { PROJECT_OWNER: "project-a" } },
				},
				{
					path: projectB,
					folders: [projectB, extraB],
					slug: "project-b",
					addedAt: 2,
					shellEnv: { overrides: { PROJECT_OWNER: "project-b" } },
				},
			],
		} satisfies DaemonConfig),
	);
	const cursorCapture = join(fixture.root, "cursor-capture.jsonl");
	const cursorAuth = join(fixture.root, "cursor-auth.json");
	writeFileSync(cursorAuth, JSON.stringify({ accounts: {} }));
	await fixture.restart({
		startupTimeoutMs: 90_000,
		runnerStartupTimeoutMs: 90_000,
		serviceEnvironment: {
			CONDUIT_CURSOR_SDK_TRACE: resolve(
				"test/fixtures/cursor-sdk-traces/basic.jsonl",
			),
			CONDUIT_CURSOR_SDK_CAPTURE: cursorCapture,
			CONDUIT_TEST_CURSOR_AUTH_STATE: cursorAuth,
		},
	});
	const bootstrap = (await fixture.requestRpc({ _tag: "GetInstances" }))
		.instances;
	for (const { id, driver } of bootstrap)
		if (driver === "opencode" && id !== "managed-test")
			await fixture.requestRpc({ _tag: "RemoveInstance", instanceId: id });
	const add = async (driver: Driver, name: string, configDir?: string) => {
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			driver,
			name,
			...(configDir ? { configDir } : {}),
			...(driver === "opencode"
				? {
						managed: true,
						port: 0,
						env: { CONDUIT_TEST_OPENCODE_STATE_PREFIX: "account-b" },
					}
				: {}),
		});
		if (!added.addedInstanceId) throw new Error(`Missing ${name}`);
		return added.addedInstanceId;
	};
	const claudeA = bootstrap.find(({ driver }) => driver === "claude")?.id;
	if (!claudeA) throw new Error("Missing isolated Claude account");
	await fixture.requestRpc({
		_tag: "UpdateInstance",
		instanceId: claudeA,
		configDir: claudeAPath,
	});
	const accounts = {
		claude: [claudeA, claudeA],
		cursor: [await add("cursor", "Cursor A"), await add("cursor", "Cursor B")],
		opencode: ["managed-test", await add("opencode", "OpenCode B")],
	} satisfies Record<Driver, [string, string]>;
	writeFileSync(
		cursorAuth,
		JSON.stringify({
			accounts: Object.fromEntries(
				accounts.cursor.map((id) => [
					id,
					{
						status: { status: "logged-in" },
						credential: {
							apiKey: `[REDACTED:${id}]`,
							backendUrl: "https://api2.cursor.sh",
							createdAtMs: 0,
						},
					},
				]),
			),
		}),
	);
	const a = await fixture.connect();
	const b = await fixture.connect(undefined, undefined, "project-b");
	const sessions: Array<{
		id: string;
		driver: Driver;
		account: string;
		project: string;
		directory: string;
		extra: string;
		marker: string;
	}> = [];
	for (const [index, project] of [
		{
			browser: a,
			slug: "process-test",
			directory: fixture.projectDir,
			extra: extraA,
			marker: "project-a",
		},
		{
			browser: b,
			slug: "project-b",
			directory: projectB,
			extra: extraB,
			marker: "project-b",
		},
	].entries()) {
		for (const driver of ["claude", "cursor", "opencode"] as const) {
			const account = accounts[driver][index];
			if (!account) throw new Error(`Missing ${driver} account`);
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
				marker: project.marker,
			});
			await project.browser.send(id, `first-${driver}-${project.slug}`, 90_000);
		}
	}
	const constructors = rows().filter(
		({ kind }) => kind === "adapter-constructed",
	);
	expect(constructors.map(({ driver }) => driver).sort()).toEqual([
		"claude",
		"codex",
		"cursor",
		"opencode",
	]);
	const historyIds: string[] = [];
	for (const session of sessions) {
		const messages = await (session.project === "process-test" ? a : b).history(
			session.id,
		);
		expect(messages.length).toBeGreaterThan(0);
		historyIds.push(...messages.map(({ id }) => id));
		const history = JSON.stringify(messages);
		// The fake OpenCode server echoes native user IDs without message parts.
		if (session.driver !== "opencode")
			expect(history).toContain(`first-${session.driver}-${session.project}`);
		for (const other of sessions.filter(({ id }) => id !== session.id))
			expect(history).not.toContain(`first-${other.driver}-${other.project}`);
	}
	expect(new Set(historyIds).size).toBe(historyIds.length);
	for (const session of sessions)
		expect(
			rows().find((row) => row.kind === "send" && row.sessionId === session.id),
		).toMatchObject({
			driver: session.driver,
			identity: constructors.find(({ driver }) => driver === session.driver)
				?.identity,
			projectId: session.project,
			accountId: session.account,
			workspaceRoot: session.directory,
			extraFolders: [session.extra],
			shellMarker: session.marker,
		});
	const cursorRows = () =>
		readFileSync(cursorCapture, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as CursorCapture);
	const cursorCreates = cursorRows().filter(
		({ kind }) => kind === "create.options",
	);
	expect(
		new Set(cursorCreates.map(({ data }) => data?.local?.store.stateRoot)).size,
	).toBe(2);
	expect(
		new Set(cursorCreates.map(({ data }) => data?.credentialFingerprint)).size,
	).toBe(2);
	for (const session of sessions.filter(({ driver }) => driver === "cursor"))
		expect(
			cursorCreates.some(
				({ data }) =>
					data?.local?.cwd === session.directory &&
					data.local.dirs.includes(session.extra),
			),
		).toBe(true);
	const claudeLaunches = fixture
		.claudeOptions()
		.filter(({ prompt }) => prompt?.startsWith("first-claude-"));
	for (const session of sessions.filter(({ driver }) => driver === "claude"))
		expect(
			claudeLaunches.find(
				({ prompt }) => prompt === `first-claude-${session.project}`,
			),
		).toMatchObject({
			configDir: claudeAPath,
			options: {
				cwd: session.directory,
				additionalDirectories: [session.extra],
				env: {
					PROJECT_OWNER: session.marker,
					CONDUIT_ENV_PROOF: "server-cache",
				},
			},
		});
	expect(existsSync(join(fixture.root, "ambient-mise-invoked"))).toBe(false);
	const openCodePids = () =>
		Object.fromEntries(
			(JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig).instances
				?.filter(({ driver }) => driver === "opencode")
				.map(({ id, pid }) => [id, pid]) ?? [],
		);
	const initialOpenCodePids = openCodePids();
	expect(initialOpenCodePids[accounts.opencode[0]]).toBeGreaterThan(0);
	expect(initialOpenCodePids[accounts.opencode[1]]).toBeGreaterThan(0);
	expect(initialOpenCodePids[accounts.opencode[0]]).not.toBe(
		initialOpenCodePids[accounts.opencode[1]],
	);
	for (const session of sessions.filter(({ driver }) => driver === "opencode"))
		expect(
			fixture
				.opencodeRequests()
				.some(
					({ pid, url, directory }) =>
						url.includes(`/${session.id}/prompt_async`) &&
						pid === initialOpenCodePids[session.account] &&
						decodeURIComponent(directory ?? "") === session.directory,
				),
		).toBe(true);
	const cursorUses = rows().filter(({ kind }) => kind === "account-scope-use");
	const cursorGenerations = accounts.cursor.map((accountId) => {
		const use = cursorUses.find((row) => row.accountId === accountId);
		expect(use?.resourceIdentity).toBeGreaterThan(0);
		return {
			accountId,
			resourceIdentity: use?.resourceIdentity,
			generation: use?.generation,
		};
	});
	expect(cursorGenerations[0]?.resourceIdentity).not.toBe(
		cursorGenerations[1]?.resourceIdentity,
	);
	expect(
		rows().filter(
			({ kind, accountId }) =>
				kind === "account-scope-open" &&
				accounts.cursor.includes(accountId ?? ""),
		),
	).toHaveLength(2);
	const snapshot = (sessionId: string) => {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return {
				state: db
					.prepare<[string], { key: string; value: string }>(
						"SELECT key, value FROM provider_state WHERE session_id = ? AND key IN ('cursor.agentId', 'cursor.cwd') ORDER BY key",
					)
					.all(sessionId),
				bindings: db
					.prepare<[string], { provider: string; provider_sid: string | null }>(
						"SELECT provider, provider_sid FROM session_providers WHERE session_id = ? ORDER BY activated_at",
					)
					.all(sessionId),
			};
		} finally {
			db.close();
		}
	};
	const crossProjectSharedAccountReuse: Array<Record<string, unknown>> = [];
	for (const driver of ["cursor", "opencode"] as const) {
		const original = sessions.find(
			(session) =>
				session.driver === driver && session.project === "process-test",
		);
		if (!original) throw new Error(`Missing original ${driver} session`);
		const originalState = snapshot(original.id);
		const originalHistory = await a.history(original.id);
		const observationIndex = rows().length;
		const captureIndex = driver === "cursor" ? cursorRows().length : 0;
		const sharedSessionId = await b.createSession(
			`project-b ${driver} on account A`,
			original.account,
			driver,
			driver === "cursor" ? { modelId: "composer-2.5", contextWindow: "" } : {},
		);
		expect(sharedSessionId).not.toBe(original.id);
		const prompt = `shared-account-${driver}-project-b`;
		await b.send(sharedSessionId, prompt, 90_000);
		const sharedHistory = await b.history(sharedSessionId);
		expect(sharedHistory.length).toBeGreaterThan(0);
		expect(
			sharedHistory.some(({ id }) =>
				originalHistory.some((row) => row.id === id),
			),
		).toBe(false);
		expect(JSON.stringify(sharedHistory)).not.toContain(
			`first-${driver}-process-test`,
		);
		expect(await a.history(original.id)).toEqual(originalHistory);
		expect(snapshot(original.id)).toEqual(originalState);
		const send = rows()
			.slice(observationIndex)
			.find((row) => row.kind === "send" && row.sessionId === sharedSessionId);
		expect(send).toMatchObject({
			driver,
			identity: constructors.find((row) => row.driver === driver)?.identity,
			projectId: "project-b",
			accountId: original.account,
			workspaceRoot: projectB,
			extraFolders: [extraB],
			shellMarker: "project-b",
		});
		const reuse = {
			driver,
			accountId: original.account,
			originalSessionId: original.id,
			sharedSessionId,
			send,
			originalHistoryIds: originalHistory.map(({ id }) => id),
			sharedHistoryIds: sharedHistory.map(({ id }) => id),
		};
		if (driver === "cursor") {
			const scope = rows()
				.slice(observationIndex)
				.find(
					(row) =>
						row.kind === "account-scope-use" &&
						row.accountId === original.account,
				);
			expect(scope).toMatchObject(cursorGenerations[0] ?? {});
			const created = cursorRows()
				.slice(captureIndex)
				.find(
					({ kind, data }) =>
						kind === "create.options" && data?.local?.cwd === projectB,
				)?.data;
			expect(created?.local?.dirs).toEqual([extraB]);
			expect(created?.credentialFingerprint).toBe(
				cursorCreates.find(
					({ data }) => data?.local?.cwd === original.directory,
				)?.data?.credentialFingerprint,
			);
			expect(created?.local?.store.stateRoot).toEqual(expect.any(String));
			expect(
				cursorCreates.some(
					({ data }) =>
						data?.local?.store.stateRoot === created?.local?.store.stateRoot,
				),
			).toBe(false);
			const agentId = snapshot(sharedSessionId).state.find(
				({ key }) => key === "cursor.agentId",
			)?.value;
			expect(agentId).toEqual(expect.any(String));
			expect(snapshot(sharedSessionId).state).toContainEqual({
				key: "cursor.cwd",
				value: projectB,
			});
			expect(JSON.stringify(sharedHistory)).toContain(prompt);
			crossProjectSharedAccountReuse.push({
				...reuse,
				scope,
				nativeThread: {
					agentId,
					sessionStore: created?.local?.store.stateRoot,
				},
				nativeIdObservation:
					"Replay uses fixed opaque agent IDs. Isolation is demonstrated by distinct owned stores, working directories and histories; fresh native ID generation is not proven.",
				launch: {
					cwd: created?.local?.cwd,
					extraFolders: created?.local?.dirs,
					sessionStore: created?.local?.store.stateRoot,
					credentialFingerprint: created?.credentialFingerprint,
				},
			});
		} else {
			const request = fixture
				.opencodeRequests()
				.find(({ url }) => url.includes(`/${sharedSessionId}/prompt_async`));
			expect(request).toMatchObject({
				pid: initialOpenCodePids[original.account],
			});
			expect(decodeURIComponent(request?.directory ?? "")).toBe(projectB);
			const body = fixture
				.opencodeRequestBodies()
				.find(({ path }) =>
					path.includes(`/${sharedSessionId}/prompt_async`),
				)?.body;
			expect(body).toContain(prompt);
			expect(body).toContain(extraB);
			expect(body).not.toContain(extraA);
			crossProjectSharedAccountReuse.push({
				...reuse,
				nativeThread: sharedSessionId,
				request,
			});
		}
	}
	evidence["crossProjectSharedAccountReuse"] = crossProjectSharedAccountReuse;
	evidence["constructorIdentities"] = constructors;
	evidence["routing"] = sessions;
	evidence["scopeGenerations"] = cursorGenerations;
	evidence["scopeObservationContract"] = {
		cursor:
			"AccountResourceScopes generation is identified by its resource object; open is first successful borrow; close is completion of exact-account invalidation. Idle expiry and daemon shutdown are outside this observation window.",
		opencode:
			"OpenCodeInstances owns each account server; generation is the live server PID, verified independently before and after exact-account removal.",
	};
	evidence["launchMarkers"] = {
		claude: claudeLaunches.map(({ pid, prompt, options }) => ({
			pid,
			prompt,
			cwd: options["cwd"],
			extraFolders: options["additionalDirectories"],
		})),
		cursor: cursorCreates.map(({ data }) => ({
			cwd: data?.local?.cwd,
			extraFolders: data?.local?.dirs,
			sessionStore: data?.local?.store.stateRoot,
			credentialFingerprint: data?.credentialFingerprint,
		})),
		opencode: fixture
			.opencodeRequests()
			.filter(({ url }) => url.includes("/prompt_async")),
	};
	const continuation: Record<string, unknown> = {
		claude: {
			status: "pending",
			requires: ["conduit-test-82tn.9.3", "conduit-test-82tn.9.4"],
			reason:
				"Claude account rebinding and account scopes are not on this HEAD",
		},
	};
	evidence["continuationOutcomes"] = continuation;
	for (const driver of ["cursor", "opencode"] as const) {
		const session = sessions.find(
			(row) => row.driver === driver && row.project === "process-test",
		);
		if (!session) throw new Error(`Missing ${driver} continuation session`);
		const before = snapshot(session.id);
		const historyBefore = (await a.history(session.id)).map(({ id }) => id);
		const runnerPidsBefore = fixture.runnerPids();
		const outcome = await fixture
			.requestRpc({
				_tag: "ContinueSession",
				sessionId: session.id,
				instanceId: accounts[driver][1],
				expectedInstanceId: accounts[driver][0],
			})
			.then(
				() => ({ status: "accepted" }),
				(error: unknown) => ({
					status: "rejected",
					reason: error instanceof Error ? error.message : String(error),
				}),
			);
		const attempt = {
			status: "blocked-on-HEAD",
			reason:
				"Public ContinueSession rejects this driver's supportsNativeResume=false contract; same-account continuation is verified below",
			outcome,
			before,
		};
		continuation[driver] = attempt;
		expect(outcome.status).toBe("rejected");
		expect("reason" in outcome && outcome.reason).toMatch(
			/native resume|driver|account/i,
		);
		expect(snapshot(session.id)).toEqual(before);
		if (driver === "cursor") {
			const auth = JSON.parse(readFileSync(cursorAuth, "utf8")) as {
				accounts: Record<string, { credential: { apiKey: string } }>;
			};
			const account = auth.accounts[session.account];
			if (!account) throw new Error("Missing isolated Cursor login");
			account.credential.apiKey = "[REDACTED:refreshed-account-a]";
			writeFileSync(cursorAuth, JSON.stringify(auth));
		}
		await a.send(session.id, `same-account-continuation-${driver}`, 90_000);
		const historyAfter = (await a.history(session.id)).map(({ id }) => id);
		expect(historyAfter).toEqual(expect.arrayContaining(historyBefore));
		expect(historyAfter.length).toBeGreaterThan(historyBefore.length);
		expect(snapshot(session.id)).toEqual(before);
		expect(
			rows()
				.filter((row) => row.kind === "send" && row.sessionId === session.id)
				.at(-1)?.accountId,
		).toBe(accounts[driver][0]);
		if (driver === "cursor") {
			const resumed = cursorRows()
				.filter(({ kind }) => kind === "resumed")
				.at(-1)?.data?.agentId;
			const agentId = before.state.find(
				({ key }) => key === "cursor.agentId",
			)?.value;
			expect(agentId).toEqual(expect.any(String));
			expect(resumed).toBe(agentId);
			expect(fixture.runnerPids()).toEqual(runnerPidsBefore);
		}
		continuation[driver] = {
			...attempt,
			sameAccount: {
				status: "passed",
				before,
				after: snapshot(session.id),
				historyBefore,
				historyAfter,
				runnerPids: fixture.runnerPids(),
			},
		};
	}
	const survivorPids = sessions
		.filter(
			({ project, driver }) => project === "project-b" && driver !== "opencode",
		)
		.map(({ id }) => {
			const mark = fixture.marks
				.filter(
					(mark) => mark.kind === "runner-started" && mark.sessionId === id,
				)
				.at(-1);
			if (mark?.kind !== "runner-started")
				throw new Error(`Missing current runner for ${id}`);
			return mark.pid;
		});
	expect(survivorPids).toHaveLength(2);
	const removalIndex = rows().length;
	for (const driver of ["cursor", "opencode"] as const)
		await fixture.requestRpc({
			_tag: "RemoveInstance",
			instanceId: accounts[driver][0],
		});
	expect(
		rows()
			.slice(removalIndex)
			.filter(({ kind }) => kind === "account-scope-close")
			.map(({ accountId }) => accountId),
	).toEqual([accounts.cursor[0]]);
	await fixture.requestRpc({
		_tag: "GetCursorAuth",
		accountId: accounts.cursor[1],
	});
	expect(
		rows()
			.filter(
				({ kind, accountId }) =>
					kind === "account-scope-use" && accountId === accounts.cursor[1],
			)
			.at(-1)?.resourceIdentity,
	).toBe(cursorGenerations[1]?.resourceIdentity);
	expect(openCodePids()[accounts.opencode[1]]).toBe(
		initialOpenCodePids[accounts.opencode[1]],
	);
	const survivorServerPid = initialOpenCodePids[accounts.opencode[1]];
	if (typeof survivorServerPid !== "number")
		throw new Error("Missing surviving server PID");
	expect(() => process.kill(survivorServerPid, 0)).not.toThrow();
	for (const pid of survivorPids)
		expect(() => process.kill(pid, 0)).not.toThrow();
	const removedPid = initialOpenCodePids[accounts.opencode[0]];
	if (typeof removedPid !== "number")
		throw new Error("Missing removed server PID");
	await vi.waitFor(() => expect(() => process.kill(removedPid, 0)).toThrow(), {
		timeout: 10_000,
	});
	evidence["survivingPids"] = {
		runners: survivorPids,
		openCodeBefore: initialOpenCodePids,
		openCodeAfter: openCodePids(),
		removedOpenCodePid: removedPid,
	};
	evidence["openCodeResourceEvents"] = [
		...accounts.opencode.map((accountId) => ({
			kind: "open",
			accountId,
			generation: initialOpenCodePids[accountId],
			pid: initialOpenCodePids[accountId],
		})),
		{
			kind: "close",
			accountId: accounts.opencode[0],
			generation: removedPid,
			pid: removedPid,
		},
		{
			kind: "survived",
			accountId: accounts.opencode[1],
			generation: survivorServerPid,
			pid: survivorServerPid,
		},
	];
	evidence["criteria"] = {
		oneAdapterPerDriverForTwoProjects: "passed",
		accountResourceIsolationAndExactRemoval:
			"passed for Cursor/OpenCode; Claude account scopes pending 9.4",
		crossAccountContinuation:
			"partial: public cross-account native resume disabled for Cursor/OpenCode on HEAD; Claude pending 9.3/9.4",
		perCallLaunchContext: "passed; source guard is verified separately",
	};
}, 240_000);
