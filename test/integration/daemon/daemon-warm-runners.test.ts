import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { discoverAllRunners } from "../../../src/lib/provider/runner/runner-registry.js";
import { testRunnerAlive } from "../../helpers/claude-runner-cleanup.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failures: relay disposal loses a reservation, foreign projects adopt an
// identical launch, discard leaves a runner alive, and removal leaves a stale
// reservation that gets reused when the project is registered again. Pending
// launch hints must not replace newer reservations or warm discarded drafts.
// Taking a draft must also fence pending hints on hits, misses and key changes.
// Retiring an older draft or project must preserve unrelated pending hints,
// including a draft moving projects and identities reused after a restart.
// Failed attachment recovery must release the unavailable project's drafts.
describe("daemon draft warm runners", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	const scenarios: Record<string, unknown>[] = [];

	function prepare(restartProof = false, draftPreWarmTtlMs?: number) {
		const fixture = ProcessHarness.create({
			runnerLifecycle: { idleTimeoutMs: null },
			restartProof,
			...(draftPreWarmTtlMs === undefined ? {} : { draftPreWarmTtlMs }),
		});
		harness = fixture;
		evidence = {};
		{
			const configPath = join(fixture.configDir, "daemon.json");
			const config = JSON.parse(
				readFileSync(configPath, "utf8"),
			) as DaemonConfig;
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
					],
				}),
			);
		}
		return fixture;
	}

	const registrations = (fixture: ProcessHarness) =>
		discoverAllRunners(fixture.configDir);
	const starts = (fixture: ProcessHarness) =>
		fixture.marks.filter((mark) => mark.kind === "runner-started");
	async function ready(fixture: ProcessHarness, count: number) {
		await vi.waitFor(
			() => {
				expect(
					fixture.marks.filter((mark) => mark.kind === "initialization-ready"),
				).toHaveLength(count);
				expect(starts(fixture)).toHaveLength(count);
			},
			{ timeout: 15_000 },
		);
		return starts(fixture);
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const marks = [...fixture.marks];
		const retained = registrations(fixture);
		const failureLog = task.result?.errors?.length
			? fixture.logTail
			: undefined;
		await fixture.dispose();
		fixture.assertNoRunners();
		scenarios.push({
			scenario: task.name,
			result: task.result?.state,
			failures: task.result?.errors?.map(({ message }) => message),
			...evidence,
			marks,
			retainedRegistrations: retained,
			failureLog,
			cleanup: { remainingRunnerPids: fixture.remainingRunnerPids() },
		});
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn-10-8-warm-runners.json",
			JSON.stringify({ bead: "conduit-test-82tn.10.8", scenarios }, null, 2),
		);
		harness = undefined;
	});

	it("keeps one reservation through relay replacement and sends on its original registration", async () => {
		const fixture = prepare();
		// A missing extra folder is omitted from launch inputs. Removing it replaces
		// the relay without changing the effective folders of the warm runner.
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: config.projects.map((project) => ({
					...project,
					folders: [fixture.projectDir, join(fixture.root, "missing")],
				})),
			}),
		);
		await fixture.restart();
		const browser = await fixture.connect();
		const draftId = randomUUID();
		await browser.preWarmDraft(draftId);
		const [runner] = await ready(fixture, 1);
		if (!runner) throw new Error("Missing warm runner");
		const initial = registrations(fixture);
		expect(initial).toHaveLength(1);
		expect(initial[0]).toMatchObject({
			sessionId: runner.sessionId,
			pid: runner.pid,
		});
		await fixture.requestRpc({
			_tag: "SaveProject",
			slug: "process-test",
			folders: [fixture.projectDir],
		});
		const replacement = await fixture.connect(undefined, browser.originId);
		expect(testRunnerAlive(runner.pid)).toBe(true);
		await replacement.preWarmDraft(draftId);
		const sessionId = await replacement.createSession(
			"Warm across relay",
			undefined,
			"claude",
			{ draftId },
		);
		expect(sessionId).toBe(runner.sessionId);
		expect(
			(await replacement.send(sessionId, "daemon-warm-first-send")).done[
				"status"
			],
		).toBe("idle");
		expect(starts(fixture)).toHaveLength(1);
		expect(registrations(fixture)).toEqual(initial);
		evidence = {
			draftId,
			sessionId,
			initialRegistrations: initial,
			finalRegistrations: registrations(fixture),
		};
	});

	it("releases draft reservations when attachment recovery makes the project unavailable", async () => {
		const fixture = prepare(true);
		writeFileSync(join(fixture.root, "daemon-engine-proof"), "");
		await fixture.restart();
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Attachment recovery failure",
		);
		const draftId = randomUUID();
		await browser.preWarmDraft(draftId);
		const [runner] = await ready(fixture, 1);
		if (!runner) throw new Error("Missing unavailable project's warm runner");
		const initial = registrations(fixture);
		expect(initial).toHaveLength(1);
		const attachment = join(fixture.root, "hold-attachment");
		const failure = join(fixture.root, "fail-attachment");
		try {
			writeFileSync(attachment, sessionId);
			writeFileSync(failure, "");
			const extra = join(fixture.root, "extra");
			mkdirSync(extra);
			const replacing = fixture
				.requestRpc({
					_tag: "SaveProject",
					slug: "process-test",
					folders: [fixture.projectDir, extra],
				})
				.catch((error: unknown) => String(error));
			await vi.waitFor(
				() =>
					expect(
						readFileSync(join(fixture.root, "daemon-engine.ndjson"), "utf8"),
					).toContain('"kind":"attachment-gap"'),
				{ timeout: 15_000 },
			);
			unlinkSync(attachment);
			await replacing;
			await vi.waitFor(async () => {
				const projects = await fixture.requestRpc({ _tag: "GetProjects" });
				expect(
					projects.projects.find(({ slug }) => slug === "process-test")
						?.unavailableReason,
				).toBe("Provider attachment recovery failed");
			});
			evidence = { draftId, sessionId, initialRegistrations: initial, runner };
			await vi.waitFor(
				() => {
					expect(registrations(fixture)).toEqual([]);
					expect(testRunnerAlive(runner.pid)).toBe(false);
					expect(existsSync(runner.socketPath)).toBe(false);
				},
				{ timeout: 5000 },
			);
			evidence["finalRegistrations"] = registrations(fixture);
		} finally {
			for (const path of [attachment, failure])
				if (existsSync(path)) unlinkSync(path);
		}
	});

	it("releases a discarded draft from another browser origin", async () => {
		const fixture = prepare();
		await fixture.restart();
		const browser = await fixture.connect();
		const draftId = randomUUID();
		await browser.preWarmDraft(draftId);
		const [runner] = await ready(fixture, 1);
		if (!runner) throw new Error("Missing discarded runner");
		const other = await fixture.connect();
		await Effect.runPromise(
			other.rpc.SyncInputDraft({
				key: { draft: draftId },
				text: "",
				projectSlug: "process-test",
				originId: other.originId,
			}),
		);
		await vi.waitFor(
			() => {
				expect(testRunnerAlive(runner.pid)).toBe(false);
				expect(registrations(fixture)).toEqual([]);
			},
			{ timeout: 5000 },
		);
		expect(existsSync(runner.socketPath)).toBe(false);
		await browser.preWarmDraft(draftId);
		const runners = await ready(fixture, 2);
		expect(runners[1]?.sessionId).not.toBe(runner.sessionId);
		evidence = { draftId, discarded: runner, replacement: runners[1] };
	});

	it("separates otherwise identical launches by project and refuses foreign adoption", async () => {
		const fixture = prepare();
		// Choosing A as the workspace in both projects produces exactly the same
		// workspace root and extra folder, despite their different primary folders.
		const projectB = join(fixture.root, "project-b");
		mkdirSync(projectB);
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: [
					{ ...config.projects[0], folders: [fixture.projectDir, projectB] },
					{
						path: projectB,
						folders: [projectB, fixture.projectDir],
						slug: "project-b",
						addedAt: 2,
					},
				],
			}),
		);
		await fixture.restart();
		const a = await fixture.connect();
		const b = await fixture.connect(undefined, undefined, "project-b");
		const draftA = randomUUID();
		const draftB = randomUUID();
		const pick = { worktreePath: fixture.projectDir };
		await Promise.all([
			a.preWarmDraft(draftA, pick),
			b.preWarmDraft(draftB, pick),
		]);
		await ready(fixture, 2);
		const reserved = registrations(fixture);
		expect(reserved).toHaveLength(2);
		const launches = fixture.marks
			.filter((mark) => mark.kind === "query")
			.map((mark) => JSON.parse(mark.optionsJson) as Record<string, unknown>);
		expect(launches).toHaveLength(2);
		for (const launch of launches)
			expect(launch).toMatchObject({
				cwd: fixture.projectDir,
				additionalDirectories: [projectB],
			});
		const sessionB = await b.createSession(
			"Project B warm",
			undefined,
			"claude",
			{ draftId: draftB, ...pick },
		);
		expect(reserved.some((runner) => runner.sessionId === sessionB)).toBe(true);
		// A tab moving A's draft to B cannot take A's project-bound reservation.
		const moved = await fixture.connect(undefined, a.originId, "project-b");
		const sessionA = reserved.find(
			(runner) => runner.sessionId !== sessionB,
		)?.sessionId;
		const movedSession = await moved.createSession(
			"Moved draft",
			undefined,
			"claude",
			{ draftId: draftA, ...pick },
		);
		expect(movedSession).not.toBe(sessionA);
		expect(
			(await moved.send(movedSession, "foreign-draft-send")).done["status"],
		).toBe("idle");
		await vi.waitFor(() =>
			expect(
				registrations(fixture).some((runner) => runner.sessionId === sessionA),
			).toBe(false),
		);
		expect((await b.send(sessionB, "project-b-warm-send")).done["status"]).toBe(
			"idle",
		);
		expect(starts(fixture)).toHaveLength(3);
		evidence = {
			reserved,
			launches,
			sessionA,
			sessionB,
			movedSession,
			finalRegistrations: registrations(fixture),
		};
	});

	it("removes project reservations before re-registration can warm the same draft", async () => {
		const fixture = prepare();
		await fixture.restart();
		const browser = await fixture.connect();
		const draftId = randomUUID();
		await browser.preWarmDraft(draftId);
		const [runner] = await ready(fixture, 1);
		if (!runner) throw new Error("Missing project runner");
		await fixture.requestRpc({ _tag: "RemoveProject", slug: "process-test" });
		expect(testRunnerAlive(runner.pid)).toBe(false);
		expect(registrations(fixture)).toEqual([]);
		await fixture.requestRpc({
			_tag: "SaveProject",
			folders: [fixture.projectDir],
		});
		const replacement = await fixture.connect(undefined, browser.originId);
		await replacement.preWarmDraft(draftId);
		const runners = await ready(fixture, 2);
		expect(runners[1]?.sessionId).not.toBe(runner.sessionId);
		evidence = { draftId, removed: runner, replacement: runners[1] };
	});

	it("keeps B warm when A's delayed preparation finishes after the origin moves", async () => {
		const fixture = prepare();
		const projectB = join(fixture.root, "project-b");
		mkdirSync(projectB);
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: [
					...config.projects,
					{
						path: projectB,
						folders: [projectB],
						slug: "project-b",
						addedAt: 2,
					},
				],
			}),
		);
		const hold = join(fixture.root, "hold-draft-launch");
		writeFileSync(hold, fixture.projectDir);
		await fixture.restart();
		const a = await fixture.connect();
		const draftId = randomUUID();
		const pending = a.preWarmDraft(draftId);
		await vi.waitFor(
			() =>
				expect(existsSync(join(fixture.root, "draft-launch-held"))).toBe(true),
			{ timeout: 15_000 },
		);
		expect(starts(fixture)).toHaveLength(0);
		const b = await fixture.connect(undefined, a.originId, "project-b");
		await b.preWarmDraft(draftId);
		const [runner] = await ready(fixture, 1);
		if (!runner) throw new Error("Missing B reservation");
		unlinkSync(hold);
		await pending;
		const sessionId = await b.createSession(
			"B after delayed A",
			undefined,
			"claude",
			{ draftId },
		);
		expect(
			(await b.send(sessionId, "b-keeps-warm-reservation")).done["status"],
		).toBe("idle");
		evidence = {
			draftId,
			originalB: runner,
			sessionId,
			finalRegistrations: registrations(fixture),
		};
		expect(sessionId).toBe(runner.sessionId);
		expect(starts(fixture)).toHaveLength(1);
		expect(registrations(fixture).map(({ pid }) => pid)).toEqual([runner.pid]);
		expect(testRunnerAlive(runner.pid)).toBe(true);
	});

	it("does not warm a discarded pending hint and lets the same origin retry", async () => {
		const fixture = prepare();
		const hold = join(fixture.root, "hold-draft-launch");
		writeFileSync(hold, fixture.projectDir);
		await fixture.restart();
		const browser = await fixture.connect();
		const draftId = randomUUID();
		const discard = () =>
			Effect.runPromise(
				browser.rpc.SyncInputDraft({
					key: { draft: draftId },
					text: "",
					projectSlug: "process-test",
					originId: browser.originId,
				}),
			);
		// No reservation or preparation exists yet.
		await discard();
		expect(registrations(fixture)).toEqual([]);
		const pending = browser.preWarmDraft(draftId);
		await vi.waitFor(
			() =>
				expect(existsSync(join(fixture.root, "draft-launch-held"))).toBe(true),
			{ timeout: 15_000 },
		);
		await discard();
		expect(starts(fixture)).toHaveLength(0);
		expect(registrations(fixture)).toEqual([]);
		unlinkSync(hold);
		await pending;
		evidence = {
			draftId,
			afterDiscard: registrations(fixture),
			startsAfterDiscard: starts(fixture),
		};
		expect(registrations(fixture)).toEqual([]);
		expect(starts(fixture)).toHaveLength(0);
		await browser.preWarmDraft(draftId);
		const [runner] = await ready(fixture, 1);
		if (!runner) throw new Error("Missing retry reservation");
		evidence = { ...evidence, retry: runner };
		await discard();
		expect(testRunnerAlive(runner.pid)).toBe(false);
		expect(registrations(fixture)).toEqual([]);
	});

	it.each([
		"missing",
		"matching",
		"mismatched",
	] as const)("fences a delayed hint across relay replacement and send with a %s reservation", async (reservation) => {
		const fixture = prepare();
		const workspaceB = join(fixture.root, "workspace-b");
		mkdirSync(workspaceB);
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: config.projects.map((project) => ({
					...project,
					folders: [
						fixture.projectDir,
						workspaceB,
						join(fixture.root, "missing"),
					],
				})),
			}),
		);
		const hold = join(fixture.root, "hold-draft-launch");
		// Install the launch barrier without blocking the initial reservation.
		writeFileSync(hold, "");
		await fixture.restart();
		const browser = await fixture.connect();
		const draftId = randomUUID();
		if (reservation !== "missing") {
			await browser.preWarmDraft(draftId);
			await ready(fixture, 1);
		}
		const initial = registrations(fixture);
		writeFileSync(hold, fixture.projectDir);
		const pending = browser.preWarmDraft(draftId);
		await vi.waitFor(
			() =>
				expect(existsSync(join(fixture.root, "draft-launch-held"))).toBe(true),
			{ timeout: 15_000 },
		);
		// Keep the old hint paused while allowing creation at the same workspace.
		writeFileSync(hold, "");
		await fixture.requestRpc({
			_tag: "SaveProject",
			slug: "process-test",
			folders: [fixture.projectDir, workspaceB],
		});
		const replacement = await fixture.connect(undefined, browser.originId);
		const sessionId = await replacement.createSession(
			"Send before old hint resolves",
			undefined,
			"claude",
			{
				draftId,
				worktreePath:
					reservation === "matching" ? fixture.projectDir : workspaceB,
			},
		);
		expect(
			(await replacement.send(sessionId, "send-before-delayed-hint")).done[
				"status"
			],
		).toBe("idle");
		const sent = registrations(fixture);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.sessionId).toBe(sessionId);
		if (reservation === "matching") expect(sent).toEqual(initial);
		unlinkSync(hold);
		await pending;
		evidence = {
			reservation,
			draftId,
			sessionId,
			initialRegistrations: initial,
			sentRegistrations: sent,
			afterDelayedHint: registrations(fixture),
		};
		expect(registrations(fixture)).toEqual(sent);
		expect(starts(fixture)).toHaveLength(reservation === "mismatched" ? 2 : 1);
		for (const runner of initial)
			if (runner.sessionId !== sessionId)
				expect(testRunnerAlive(runner.pid)).toBe(false);
	});

	it("fences A's delayed refresh when its draft is sent from B and warms the next draft", async () => {
		const fixture = prepare();
		const projectB = join(fixture.root, "project-b");
		mkdirSync(projectB);
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: [
					...config.projects,
					{
						path: projectB,
						folders: [projectB],
						slug: "project-b",
						addedAt: 2,
					},
				],
			}),
		);
		const hold = join(fixture.root, "hold-draft-launch");
		writeFileSync(hold, "");
		await fixture.restart();
		const a = await fixture.connect();
		const draftId = randomUUID();
		await a.preWarmDraft(draftId);
		const [runnerA] = await ready(fixture, 1);
		if (!runnerA) throw new Error("Missing A reservation");
		writeFileSync(hold, fixture.projectDir);
		const pending = a.preWarmDraft(draftId);
		await vi.waitFor(
			() =>
				expect(existsSync(join(fixture.root, "draft-launch-held"))).toBe(true),
			{ timeout: 15_000 },
		);
		const b = await fixture.connect(undefined, a.originId, "project-b");
		const sessionId = await b.createSession(
			"Move and send before A refreshes",
			undefined,
			"claude",
			{ draftId },
		);
		expect(
			(await b.send(sessionId, "send-b-before-a-refresh")).done["status"],
		).toBe("idle");
		const sent = registrations(fixture);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.sessionId).toBe(sessionId);
		expect(testRunnerAlive(runnerA.pid)).toBe(false);
		unlinkSync(hold);
		await pending;
		evidence = {
			draftId,
			sessionId,
			runnerA,
			sentRegistrations: sent,
			afterDelayedHint: registrations(fixture),
		};
		expect(registrations(fixture)).toEqual(sent);
		expect(starts(fixture)).toHaveLength(2);
		const nextDraftId = randomUUID();
		await b.preWarmDraft(nextDraftId);
		const runners = await ready(fixture, 3);
		evidence = { ...evidence, nextDraftId, nextRunner: runners[2] };
		expect(runners[2]?.sessionId).not.toBe(sessionId);
		expect(registrations(fixture)).toHaveLength(2);
		await Effect.runPromise(
			b.rpc.SyncInputDraft({
				key: { draft: nextDraftId },
				text: "",
				projectSlug: "project-b",
				originId: b.originId,
			}),
		);
		expect(registrations(fixture)).toEqual(sent);
	});

	it("preserves the next draft's pending hint through duplicate creates of a sent draft", async () => {
		const fixture = prepare();
		const hold = join(fixture.root, "hold-draft-launch");
		writeFileSync(hold, "");
		await fixture.restart();
		const browser = await fixture.connect();
		const draftId = randomUUID();
		await browser.preWarmDraft(draftId);
		const [sentRunner] = await ready(fixture, 1);
		const sessionId = await browser.createSession(
			"First draft",
			undefined,
			"claude",
			{ draftId },
		);
		expect(sessionId).toBe(sentRunner?.sessionId);
		expect(
			(await browser.send(sessionId, "first-draft-send")).done["status"],
		).toBe("idle");
		const sent = registrations(fixture);
		const nextDraftId = randomUUID();
		writeFileSync(hold, fixture.projectDir);
		const pending = browser.preWarmDraft(nextDraftId);
		await vi.waitFor(
			() =>
				expect(existsSync(join(fixture.root, "draft-launch-held"))).toBe(true),
			{ timeout: 15_000 },
		);
		// Both retries take an already-consumed draft while D2 is preparing.
		writeFileSync(hold, "");
		for (let retry = 0; retry < 2; retry++)
			await expect(
				browser.createSession("Retry first draft", undefined, "claude", {
					draftId,
				}),
			).rejects.toThrow("already sent");
		unlinkSync(hold);
		await pending;
		evidence = {
			draftId,
			nextDraftId,
			sessionId,
			sent,
			afterHint: registrations(fixture),
			startsAfterHint: starts(fixture),
		};
		expect(registrations(fixture)).toHaveLength(2);
		const runners = await ready(fixture, 2);
		const nextSession = await browser.createSession(
			"Next draft",
			undefined,
			"claude",
			{ draftId: nextDraftId },
		);
		expect(nextSession).toBe(runners[1]?.sessionId);
		expect(
			(await browser.send(nextSession, "next-draft-send")).done["status"],
		).toBe("idle");
		expect(starts(fixture)).toHaveLength(2);
		evidence = { ...evidence, nextSession };
	});

	it.each([
		"same",
		"newer",
	] as const)("preserves B's pending %s draft when project A is removed", async (draft) => {
		const fixture = prepare();
		const projectB = join(fixture.root, "project-b");
		mkdirSync(projectB);
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: [
					...config.projects,
					{
						path: projectB,
						folders: [projectB],
						slug: "project-b",
						addedAt: 2,
					},
				],
			}),
		);
		const hold = join(fixture.root, "hold-draft-launch");
		writeFileSync(hold, projectB);
		await fixture.restart();
		const a = await fixture.connect();
		const draftA = randomUUID();
		await a.preWarmDraft(draftA);
		const [runnerA] = await ready(fixture, 1);
		if (!runnerA) throw new Error("Missing A reservation");
		const b = await fixture.connect(undefined, a.originId, "project-b");
		const draftB = draft === "same" ? draftA : randomUUID();
		const pending = b.preWarmDraft(draftB);
		await vi.waitFor(
			() =>
				expect(existsSync(join(fixture.root, "draft-launch-held"))).toBe(true),
			{ timeout: 15_000 },
		);
		await fixture.requestRpc({ _tag: "RemoveProject", slug: "process-test" });
		expect(testRunnerAlive(runnerA.pid)).toBe(false);
		expect(registrations(fixture)).toEqual([]);
		unlinkSync(hold);
		await pending;
		evidence = {
			draftA,
			draftB,
			removed: runnerA,
			afterHint: registrations(fixture),
			startsAfterHint: starts(fixture),
		};
		expect(registrations(fixture)).toHaveLength(1);
		const runners = await ready(fixture, 2);
		const sessionId = await b.createSession(
			"B survives removal of A",
			undefined,
			"claude",
			{ draftId: draftB },
		);
		expect(sessionId).toBe(runners[1]?.sessionId);
		expect(
			(await b.send(sessionId, "b-pending-after-a-removal")).done["status"],
		).toBe("idle");
		expect(starts(fixture)).toHaveLength(2);
		evidence = { ...evidence, sessionId };
	});

	it("invalidates a moved draft's pending hint when its destination project is removed", async () => {
		const fixture = prepare();
		const projectB = join(fixture.root, "project-b");
		mkdirSync(projectB);
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: [
					...config.projects,
					{
						path: projectB,
						folders: [projectB],
						slug: "project-b",
						addedAt: 2,
					},
				],
			}),
		);
		const hold = join(fixture.root, "hold-draft-launch");
		writeFileSync(hold, projectB);
		await fixture.restart();
		const a = await fixture.connect();
		const draftId = randomUUID();
		await a.preWarmDraft(draftId);
		const [runnerA] = await ready(fixture, 1);
		const b = await fixture.connect(undefined, a.originId, "project-b");
		const pending = b.preWarmDraft(draftId).then(
			() => "completed",
			(cause: unknown) => String(cause),
		);
		await vi.waitFor(
			() =>
				expect(existsSync(join(fixture.root, "draft-launch-held"))).toBe(true),
			{ timeout: 15_000 },
		);
		await fixture.requestRpc({ _tag: "RemoveProject", slug: "project-b" });
		// Re-register before the old hint resolves, with the same draft/origin.
		await fixture.requestRpc({ _tag: "SaveProject", folders: [projectB] });
		const replacement = await fixture.connect(
			undefined,
			a.originId,
			"project-b",
		);
		unlinkSync(hold);
		const oldHintOutcome = await pending;
		expect(starts(fixture)).toHaveLength(1);
		expect(registrations(fixture).map(({ sessionId }) => sessionId)).toEqual([
			runnerA?.sessionId,
		]);
		await replacement.preWarmDraft(draftId);
		const runners = await ready(fixture, 2);
		const sessionId = await replacement.createSession(
			"Moved draft after re-registration",
			undefined,
			"claude",
			{ draftId },
		);
		expect(sessionId).toBe(runners[1]?.sessionId);
		expect(
			(await replacement.send(sessionId, "moved-draft-after-removal")).done[
				"status"
			],
		).toBe("idle");
		expect(starts(fixture)).toHaveLength(2);
		expect(registrations(fixture)).toHaveLength(1);
		evidence = {
			draftId,
			runnerA,
			oldHintOutcome,
			replacement: runners[1],
			sessionId,
		};
	});

	it("preserves the next draft's pending hint when the previous reservation expires", async () => {
		const fixture = prepare(false, 5000);
		const hold = join(fixture.root, "hold-draft-launch");
		writeFileSync(hold, "");
		await fixture.restart();
		const browser = await fixture.connect();
		const draftId = randomUUID();
		await browser.preWarmDraft(draftId);
		const [expired] = await ready(fixture, 1);
		if (!expired) throw new Error("Missing expiring reservation");
		const nextDraftId = randomUUID();
		writeFileSync(hold, fixture.projectDir);
		const pending = browser.preWarmDraft(nextDraftId);
		await vi.waitFor(
			() =>
				expect(existsSync(join(fixture.root, "draft-launch-held"))).toBe(true),
			{ timeout: 15_000 },
		);
		await vi.waitFor(() => expect(testRunnerAlive(expired.pid)).toBe(false), {
			timeout: 15_000,
		});
		expect(registrations(fixture)).toEqual([]);
		unlinkSync(hold);
		await pending;
		evidence = {
			draftId,
			nextDraftId,
			expired,
			afterHint: registrations(fixture),
		};
		expect(registrations(fixture)).toHaveLength(1);
		const runners = await ready(fixture, 2);
		const sessionId = await browser.createSession(
			"Next draft after expiry",
			undefined,
			"claude",
			{ draftId: nextDraftId },
		);
		expect(sessionId).toBe(runners[1]?.sessionId);
		evidence = { ...evidence, sessionId };
	});

	it("reuses the same origin and draft after restarting during preparation", async () => {
		const fixture = prepare();
		const hold = join(fixture.root, "hold-draft-launch");
		writeFileSync(hold, fixture.projectDir);
		await fixture.restart();
		const browser = await fixture.connect();
		const draftId = randomUUID();
		const pending = browser.preWarmDraft(draftId).then(
			() => "completed",
			(cause: unknown) => String(cause),
		);
		await vi.waitFor(
			() =>
				expect(existsSync(join(fixture.root, "draft-launch-held"))).toBe(true),
			{ timeout: 15_000 },
		);
		expect(starts(fixture)).toHaveLength(0);
		await fixture.kill();
		await fixture.restart();
		const oldHintOutcome = await pending;
		const replacement = await fixture.connect(undefined, browser.originId);
		unlinkSync(hold);
		await replacement.preWarmDraft(draftId);
		const [runner] = await ready(fixture, 1);
		const sessionId = await replacement.createSession(
			"Draft after daemon restart",
			undefined,
			"claude",
			{ draftId },
		);
		expect(sessionId).toBe(runner?.sessionId);
		expect(
			(await replacement.send(sessionId, "draft-after-daemon-restart")).done[
				"status"
			],
		).toBe("idle");
		expect(starts(fixture)).toHaveLength(1);
		evidence = {
			draftId,
			originId: browser.originId,
			oldHintOutcome,
			runner,
			sessionId,
		};
	});

	it.each([
		"discard",
		"remove",
	] as const)("releases an initializing reservation on %s", async (action) => {
		const fixture = prepare(true);
		await fixture.restart();
		const browser = await fixture.connect();
		const draftId = randomUUID();
		writeFileSync(join(fixture.root, "hold-next-initialization"), "hold");
		const warming = browser.preWarmDraft(draftId).then(
			() => "completed",
			(cause: unknown) => String(cause),
		);
		await vi.waitFor(
			() =>
				expect(
					fixture.marks.filter((mark) => mark.kind === "initialization-held"),
				).toHaveLength(1),
			{ timeout: 15_000 },
		);
		const [runner] = starts(fixture);
		if (!runner) throw new Error("Missing initializing runner");
		if (action === "remove")
			await fixture.requestRpc({ _tag: "RemoveProject", slug: "process-test" });
		else
			await Effect.runPromise(
				browser.rpc.SyncInputDraft({
					key: { draft: draftId },
					text: "",
					projectSlug: "process-test",
				}),
			);
		const warmOutcome = await warming;
		await vi.waitFor(
			() => {
				expect(testRunnerAlive(runner.pid)).toBe(false);
				expect(registrations(fixture)).toEqual([]);
			},
			{ timeout: 5000 },
		);
		expect(starts(fixture)).toHaveLength(1);
		evidence = {
			action,
			draftId,
			runner,
			warmOutcome,
			finalRegistrations: registrations(fixture),
		};
	});
});
