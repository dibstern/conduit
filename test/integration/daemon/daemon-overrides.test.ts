import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/provider-instance.js";
import type { SessionState } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

interface Observation {
	kind: "state" | "timeout";
	at: number;
	sessionId: string;
	defaultAgent?: string;
	overrides?: SessionState;
	timeoutActive?: boolean;
	entries?: {
		sessionId: string;
		overrides?: SessionState;
		timeoutActive: boolean;
	}[];
}

// Failures: A's live default is absent in B; replacement loses transient
// overrides, cancels a surviving session's timer, or arms it a second time.
describe("daemon overrides ownership", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	const scenarios: Record<string, unknown>[] = [];
	const observations = (): Observation[] =>
		harness && existsSync(join(harness.root, "daemon-overrides.ndjson"))
			? readFileSync(join(harness.root, "daemon-overrides.ndjson"), "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Observation)
			: [];

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const calls = observations();
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			const {
				marks: _marks,
				frames: _frames,
				logTail: _logTail,
				...cleanup
			} = fixture.proof();
			mkdirSync("test-results", { recursive: true });
			scenarios.push({
				name: task.name,
				result: task.result?.state,
				failures: task.result?.errors?.map(({ message }) => message),
				...evidence,
				calls,
				cleanup,
				remainingRunnerPids: fixture.remainingRunnerPids(),
			});
			writeFileSync(
				"test-results/82tn-10-5-daemon-overrides.json",
				JSON.stringify(
					{
						bead: "conduit-test-82tn.10.5",
						scenarios,
					},
					null,
					2,
				),
			);
			harness = undefined;
			evidence = {};
		}
	});

	it("shares live defaults across projects and retains overrides and one timeout across relay replacement", async () => {
		const fixture = ProcessHarness.create({
			restartProof: true,
			runnerLifecycle: { idleTimeoutMs: null },
		});
		harness = fixture;
		const control = join(fixture.root, "daemon-overrides-proof.json");
		const timeoutMs = 6000;
		writeFileSync(control, JSON.stringify({ timeoutMs }));
		writeFileSync(join(fixture.root, "daemon-overrides.ndjson"), "");
		const projectB = join(fixture.root, "project-b");
		mkdirSync(projectB);
		await fixture.restart();
		await fixture.requestRpc({ _tag: "SaveProject", folders: [projectB] });
		const a = await fixture.connect();
		const b = await fixture.connect(undefined, undefined, "project-b");
		// Both relays are already alive when A changes an in-memory default.
		await fixture.requestRpc({
			_tag: "SetAgent",
			slug: "process-test",
			agent: "daemon-default-agent",
		});
		const sessionB = await b.createSession("B uses A's new default");
		await b.preWarmSession(sessionB);
		const bDefault = observations().find(
			({ sessionId }) => sessionId === sessionB,
		);

		const sessionA = await a.createSession(
			"Overrides survive relay replacement",
		);
		void a
			.send(sessionA, "tool-long-overrides-replacement", 30_000)
			.catch(() => undefined);
		await vi.waitFor(
			async () => {
				expect(
					(await a.history(sessionA)).some((message) =>
						message.parts?.some(
							(part) =>
								part.type === "tool" && part.state?.["status"] === "running",
						),
					),
				).toBe(true);
			},
			{ timeout: 10_000 },
		);
		writeFileSync(
			control,
			JSON.stringify({ timeoutMs, seedSession: sessionA }),
		);
		await a.preWarmSession(sessionA);
		const before = observations()
			.filter(({ sessionId }) => sessionId === sessionA)
			.at(-1);
		expect(before?.overrides?.agent).toBe("session-only-agent");
		expect(before?.timeoutActive).toBe(true);

		const extra = join(fixture.root, "added-folder");
		mkdirSync(extra);
		const replacement = await fixture.requestRpc({
			_tag: "SaveProject",
			slug: "process-test",
			folders: [fixture.projectDir, extra],
		});
		expect(replacement.savedSlug).toBe("process-test");
		const browser = await fixture.connect(sessionA);
		await browser.preWarmSession(sessionA);
		const after = observations()
			.filter(({ sessionId }) => sessionId === sessionA)
			.at(-1);
		evidence = { sessionA, sessionB, timeoutMs, bDefault, before, after };
		// Wait past the original deadline, then through another replacement to
		// prove the expired timer is neither cancelled nor rearmed on adoption.
		await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + 1000));
		await fixture.requestRpc({
			_tag: "SaveProject",
			slug: "process-test",
			folders: [fixture.projectDir],
		});
		const finalBrowser = await fixture.connect(sessionA);
		await finalBrowser.preWarmSession(sessionA);
		const final = observations()
			.filter(({ sessionId }) => sessionId === sessionA)
			.at(-1);
		const timeouts = observations().filter(({ kind }) => kind === "timeout");
		const notices = (await finalBrowser.history(sessionA)).filter((message) =>
			message.parts?.some(
				(part) =>
					part.type === "notice" &&
					part.text?.startsWith("No response for 2 minutes."),
			),
		);
		evidence = { ...evidence, final, timeouts, notices };
		expect.soft(bDefault?.defaultAgent).toBe("daemon-default-agent");
		expect.soft(after?.overrides).toEqual(before?.overrides);
		expect.soft(after?.timeoutActive).toBe(true);
		expect.soft(final?.overrides).toEqual(before?.overrides);
		expect.soft(final?.timeoutActive).toBe(false);
		expect.soft(timeouts).toHaveLength(1);
		expect.soft(timeouts[0]?.at).toBeGreaterThan(after?.at ?? Infinity);
		expect.soft(notices).toHaveLength(1);
	}, 60_000);

	it("clears removed-project state before the deadline and re-adds the same slug without transient overrides", async () => {
		const fixture = ProcessHarness.create({
			restartProof: true,
			runnerLifecycle: { idleTimeoutMs: null },
		});
		harness = fixture;
		const control = join(fixture.root, "daemon-overrides-proof.json");
		const timeoutMs = 6000;
		writeFileSync(control, JSON.stringify({ timeoutMs }));
		writeFileSync(join(fixture.root, "daemon-overrides.ndjson"), "");
		const projectB = join(fixture.root, "project-b");
		mkdirSync(projectB);
		await fixture.restart();
		await fixture.requestRpc({ _tag: "SaveProject", folders: [projectB] });
		const a = await fixture.connect();
		const b = await fixture.connect(undefined, undefined, "project-b");
		const sessionA = await a.createSession(
			"Removed project with running timeout",
		);
		const sessionB = await b.createSession("Other project's overrides remain");
		writeFileSync(
			control,
			JSON.stringify({ timeoutMs: 120_000, armSession: sessionB }),
		);
		await b.preWarmSession(sessionB);
		void a
			.send(sessionA, "tool-long-project-removal", 30_000)
			.catch(() => undefined);
		await vi.waitFor(
			async () => {
				expect(
					(await a.history(sessionA)).some((message) =>
						message.parts?.some(
							(part) =>
								part.type === "tool" && part.state?.["status"] === "running",
						),
					),
				).toBe(true);
			},
			{ timeout: 10_000 },
		);
		writeFileSync(
			control,
			JSON.stringify({ timeoutMs, seedSession: sessionA }),
		);
		await a.preWarmSession(sessionA);
		await fixture.requestRpc({ _tag: "RemoveProject", slug: "process-test" });
		writeFileSync(
			control,
			JSON.stringify({ timeoutMs, inspectSessions: [sessionA, sessionB] }),
		);
		await b.preWarmSession(sessionB);
		const afterRemove = observations().at(-1)?.entries;
		const saved = await fixture.requestRpc({
			_tag: "SaveProject",
			folders: [fixture.projectDir],
		});
		expect(saved.savedSlug).toBe("process-test");
		const readded = await fixture.connect(sessionA);
		await readded.preWarmSession(sessionA);
		const afterReadd = observations().at(-1);
		await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + 500));
		const timeouts = observations().filter(({ kind }) => kind === "timeout");
		const notices = (await readded.history(sessionA)).filter((message) =>
			message.parts?.some(
				(part) =>
					part.type === "notice" &&
					part.text?.startsWith("No response for 2 minutes."),
			),
		);
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		const durableNotices = db
			.prepare<[string], { count: number }>(
				"SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND type = 'turn.notice'",
			)
			.get(sessionA)?.count;
		db.close();
		evidence = {
			sessionA,
			sessionB,
			afterRemove,
			afterReadd,
			timeouts,
			notices,
			durableNotices,
		};
		expect
			.soft(afterRemove?.find(({ sessionId }) => sessionId === sessionA))
			.toEqual({ sessionId: sessionA, timeoutActive: false });
		expect
			.soft(afterRemove?.find(({ sessionId }) => sessionId === sessionB))
			.toMatchObject({
				overrides: { agent: "session-only-agent" },
				timeoutActive: true,
			});
		expect.soft(afterReadd?.overrides?.agent).toBeUndefined();
		expect.soft(afterReadd?.timeoutActive).toBe(false);
		expect
			.soft(timeouts.filter(({ sessionId }) => sessionId === sessionA))
			.toHaveLength(0);
		expect.soft(notices).toHaveLength(0);
		expect.soft(durableNotices).toBe(0);
	}, 60_000);

	it("deleting one session interrupts its live timeout and leaves its sibling intact", async () => {
		const fixture = ProcessHarness.create({
			restartProof: true,
			runnerLifecycle: { idleTimeoutMs: null },
		});
		harness = fixture;
		const control = join(fixture.root, "daemon-overrides-proof.json");
		const timeoutMs = 15_000;
		writeFileSync(control, JSON.stringify({ timeoutMs }));
		writeFileSync(join(fixture.root, "daemon-overrides.ndjson"), "");
		await fixture.restart();
		const browser = await fixture.connect();
		const deleted = await browser.createSession("Delete with a live timer");
		const sibling = await browser.createSession("Sibling remains registered");
		writeFileSync(control, JSON.stringify({ timeoutMs, armSession: deleted }));
		await browser.preWarmSession(deleted);
		writeFileSync(
			control,
			JSON.stringify({ timeoutMs: 120_000, armSession: sibling }),
		);
		await browser.preWarmSession(sibling);
		await browser.deleteSession(deleted);
		writeFileSync(
			control,
			JSON.stringify({ timeoutMs, inspectSessions: [deleted, sibling] }),
		);
		await browser.preWarmSession(sibling);
		const afterDelete = observations().at(-1)?.entries;
		await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + 500));
		const timeouts = observations().filter(({ kind }) => kind === "timeout");
		evidence = { deleted, sibling, afterDelete, timeouts };
		expect
			.soft(afterDelete?.find(({ sessionId }) => sessionId === deleted))
			.toEqual({ sessionId: deleted, timeoutActive: false });
		expect
			.soft(afterDelete?.find(({ sessionId }) => sessionId === sibling))
			.toMatchObject({
				overrides: { agent: "session-only-agent" },
				timeoutActive: true,
			});
		expect
			.soft(timeouts.filter(({ sessionId }) => sessionId === deleted))
			.toHaveLength(0);
	}, 60_000);

	it("keeps two projects' native defaults separate, shares the saved conduit default and reloads it on restart", async () => {
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		harness = fixture;
		const projectB = join(fixture.root, "project-b");
		mkdirSync(projectB);
		for (const [directory, model] of [
			[fixture.projectDir, "model-a"],
			[projectB, "model-b"],
		] as const) {
			writeFileSync(
				join(directory, "opencode.json"),
				JSON.stringify({ model: `fake/${model}` }),
			);
		}
		writeFileSync(
			join(fixture.configDir, "fake-opencode-model-catalog.json"),
			JSON.stringify({
				all: [
					{
						id: "fake",
						name: "Fake",
						models: Object.fromEntries(
							["model-a", "model-b", "saved"].map((id) => [
								id,
								{ id, name: id, limit: { context: 128000, output: 4096 } },
							]),
						),
					},
				],
				default: { fake: "model-a" },
				connected: ["fake"],
			}),
		);
		await fixture.restart();
		await fixture.requestRpc({ _tag: "SaveProject", folders: [projectB] });
		const a = await fixture.connect();
		const b = await fixture.connect(undefined, undefined, "project-b");
		await a.startInstance(MANAGED_OPENCODE_ACCOUNT_ID);
		expect((await a.getModels(MANAGED_OPENCODE_ACCOUNT_ID)).active?.model).toBe(
			"model-a",
		);
		expect((await b.getModels(MANAGED_OPENCODE_ACCOUNT_ID)).active?.model).toBe(
			"model-b",
		);
		const aSnapshot = await fixture.connect();
		const bSnapshot = await fixture.connect(undefined, undefined, "project-b");
		const defaultRow = (browser: typeof a) =>
			browser.frames.find(
				({ message }) =>
					message["type"] === "project_setting" &&
					message["_tag"] === "defaultModel",
			)?.message;
		const nativeA = defaultRow(aSnapshot);
		const nativeB = defaultRow(bSnapshot);
		evidence = { nativeA, nativeB };
		expect.soft(nativeA).toMatchObject({ provider: "fake", model: "model-a" });
		expect.soft(nativeB).toMatchObject({ provider: "fake", model: "model-b" });
		await fixture.requestRpc({
			_tag: "SetDefaultModel",
			projectSlug: "process-test",
			provider: "fake",
			model: "saved",
		});
		const savedA = defaultRow(await fixture.connect());
		const savedB = defaultRow(
			await fixture.connect(undefined, undefined, "project-b"),
		);
		await fixture.terminate();
		await fixture.restart();
		const restartA = defaultRow(await fixture.connect());
		const restartB = defaultRow(
			await fixture.connect(undefined, undefined, "project-b"),
		);
		evidence = { nativeA, nativeB, savedA, savedB, restartA, restartB };
		for (const row of [savedA, savedB, restartA, restartB])
			expect.soft(row).toMatchObject({ provider: "fake", model: "saved" });
	}, 90_000);
});
