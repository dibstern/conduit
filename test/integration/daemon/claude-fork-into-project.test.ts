// Forking a Claude session into another project (m379.11), over the isolated process harness and the
// fake Claude SDK. How it could fail (lane m37911 audit):
// 1, 2. the fork lists under the source project, or its events carry the source's project id;
// 3. the fork runs in the source's folder, so a Write tool call lands there;
// 4. the fork resumes the source's Claude conversation instead of a fresh one seeded with the transcript;
// 9. the fork takes the target's default account instead of keeping the source's;
// 12. the response names the source project, so the page opens the fork in the wrong project;
// 5, 6. a removed target or a target whose folder is gone still gets a fork row;
// 7. a fork during the source's Run is refused, or its seed carries the in-flight prompt;
// 10. a daemon restart between the fork and its first turn loses the seed or the folder;
// 8. an OpenCode session, which has no seeded fresh start yet, forks natively in the source's folder
// and lists under the target.
import {
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

const query = <T>(
	harness: ProcessHarness,
	sql: string,
	...params: unknown[]
) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return db.prepare(sql).all(...params) as T[];
	} finally {
		db.close();
	}
};

const forkRows = (harness: ProcessHarness, sourceId: string) =>
	query<{ id: string; project_id: string; provider: string }>(
		harness,
		"SELECT id, project_id, provider FROM sessions WHERE forked_from = ?",
		sourceId,
	);

const eventProjects = (harness: ProcessHarness, sessionId: string) =>
	query<{ project_id: string }>(
		harness,
		"SELECT DISTINCT project_id FROM events WHERE session_id = ?",
		sessionId,
	).map((row) => row.project_id);

/** The Claude query that carried one request, as the fake SDK recorded it. */
const queryFor = (harness: ProcessHarness, request: string) => {
	const found = harness
		.claudeOptions()
		.filter((entry) => entry.prompt?.includes(request));
	expect(found).toHaveLength(1);
	const [entry] = found;
	if (!entry) throw new Error(`No query carried ${request}`);
	return entry;
};

const writeTurn = (file: string) =>
	`workspace-hint-tools ${JSON.stringify({ writes: [file], create: true })}`;

describe("a Claude session forks into another project", () => {
	let harness: ProcessHarness | undefined;
	const proof: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			proof[`${task.name} outcome`] =
				task.result?.state === "pass" ? "passed" : "failed";
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/m379-11-fork-into-project.json",
				`${JSON.stringify(proof, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	const start = async (openCode = false) => {
		const fixture = ProcessHarness.create({
			...(openCode
				? {
						managedOpenCode: true,
						managedOpenCodeId: "opencode",
						autoStartOpenCode: true,
						managedOpenCodeStopGraceMs: 100,
					}
				: {}),
			restartProof: true,
			logLevel: "warn",
			serverLogFile: join("test-results", "m379-11-daemon.log"),
		});
		harness = fixture;
		await fixture.restart();
		const targetDir = join(fixture.root, "project-b");
		mkdirSync(targetDir, { recursive: true });
		await fixture.requestRpc({ _tag: "SaveProject", folders: [targetDir] });
		const accounts: string[] = [];
		for (const name of ["A", "B"]) {
			const configDir = join(fixture.root, name);
			mkdirSync(configDir, { recursive: true });
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
		const browser = await fixture.connect();
		await browser.followSessions();
		const sessionId = await browser.createSession("Source", a);
		await browser.send(sessionId, "fork-source-said");
		return { fixture, browser, sessionId, targetDir, accounts: { a, b } };
	};

	// 1, 2, 3, 4, 9, 12.
	it("lists the fork under the target, keeps the source's account, and runs a fresh seeded conversation in the target's folder", async () => {
		const { fixture, browser, sessionId, targetDir, accounts } = await start();
		const target = await fixture.connect(undefined, undefined, "project-b");
		// The target's own default account, which the fork must not take.
		const plain = await target.createSession("Target default");
		const targetDefault = query<{ provider: string }>(
			fixture,
			"SELECT provider FROM sessions WHERE id = ?",
			plain,
		)[0]?.provider;
		proof["target default account"] = targetDefault;
		expect(targetDefault).not.toBe(accounts.a);
		const fork = await Effect.runPromise(
			browser.rpc.ForkSession({
				sessionId,
				originId: browser.originId,
				targetProjectSlug: "project-b",
			}),
		);
		proof["fork response"] = fork;
		expect(fork.projectSlug).toBe("project-b");
		const rows = forkRows(fixture, sessionId);
		proof["fork rows"] = rows;
		expect(rows).toEqual([
			{ id: fork.sessionId, project_id: "project-b", provider: accounts.a },
		]);
		expect(eventProjects(fixture, fork.sessionId)).toEqual(["project-b"]);

		await target.send(fork.sessionId, writeTurn("fork-landed.txt"));
		const sent = queryFor(fixture, "fork-landed.txt");
		const landed = {
			cwd: sent.options["cwd"],
			resumeId: sent.resumeId,
			forkSession: sent.options["forkSession"] ?? null,
			handoff: sent.prompt?.startsWith("[Conduit context handoff]"),
			carriesSource: sent.prompt?.includes("fork-source-said"),
			inTarget: existsSync(join(targetDir, "fork-landed.txt")),
			inSource: existsSync(join(fixture.projectDir, "fork-landed.txt")),
			eventProjects: eventProjects(fixture, fork.sessionId),
		};
		proof["fork first turn"] = landed;
		expect(landed).toEqual({
			cwd: realpathSync(targetDir),
			resumeId: null,
			forkSession: null,
			handoff: true,
			carriesSource: true,
			inTarget: true,
			inSource: false,
			eventProjects: ["project-b"],
		});
	});

	// 7, 10.
	it("admits a fork during the source's Run, seeds only the settled transcript, and keeps it across a daemon restart", async () => {
		const { fixture, browser, sessionId, targetDir } = await start();
		const held = browser.send(sessionId, "approval-admission");
		void held.catch(() => undefined);
		// test-waits-allow polling: the open permission is a store row, not a frame this test follows.
		await vi.waitFor(
			() =>
				expect(
					query(
						fixture,
						"SELECT 1 FROM pending_approvals WHERE session_id = ? AND status = 'pending'",
						sessionId,
					),
				).toHaveLength(1),
			{ timeout: 10_000 },
		);
		const fork = await Effect.runPromise(
			browser.rpc.ForkSession({
				sessionId,
				originId: browser.originId,
				targetProjectSlug: "project-b",
			}),
		);
		proof["fork during a Run"] = fork;
		expect(fork.projectSlug).toBe("project-b");

		// The daemon dies between the fork's write and its first turn.
		await fixture.kill();
		await fixture.restart();
		const target = await fixture.connect(undefined, undefined, "project-b");
		await target.send(fork.sessionId, writeTurn("after-restart.txt"));
		const sent = queryFor(fixture, "after-restart.txt");
		const landed = {
			cwd: sent.options["cwd"],
			resumeId: sent.resumeId,
			carriesSource: sent.prompt?.includes("fork-source-said"),
			carriesInFlight: sent.prompt?.includes("approval-admission"),
			inTarget: existsSync(join(targetDir, "after-restart.txt")),
			eventProjects: eventProjects(fixture, fork.sessionId),
		};
		proof["fork after restart"] = { ...landed, prompt: sent.prompt };
		expect(landed).toEqual({
			cwd: realpathSync(targetDir),
			resumeId: null,
			carriesSource: true,
			carriesInFlight: false,
			inTarget: true,
			eventProjects: ["project-b"],
		});
	});

	// 5, 6, 8.
	it("refuses a fork into a removed project, one whose folder is gone, or of an OpenCode session, writing no fork", async () => {
		const { fixture, browser, sessionId } = await start(true);
		const openCodeSession = await browser.createSession(
			"OpenCode source",
			"opencode",
			"opencode",
		);
		await browser.send(openCodeSession, "opencode-source-said");
		const removedDir = join(fixture.root, "project-c");
		const goneDir = join(fixture.root, "project-d");
		for (const directory of [removedDir, goneDir]) {
			mkdirSync(directory, { recursive: true });
			await fixture.requestRpc({ _tag: "SaveProject", folders: [directory] });
		}
		// The relay is live when the project goes away.
		await fixture.connect(undefined, undefined, "project-c");
		await fixture.requestRpc({ _tag: "RemoveProject", slug: "project-c" });
		await fixture.connect(undefined, undefined, "project-d");
		rmSync(goneDir, { recursive: true, force: true });

		const refusals: Record<string, string> = {};
		for (const target of ["project-c", "project-d"]) {
			const error = await Effect.runPromise(
				Effect.flip(
					browser.rpc.ForkSession({
						sessionId,
						originId: browser.originId,
						targetProjectSlug: target,
					}),
				),
			);
			refusals[target] = error.message;
		}
		refusals["opencode"] = (
			await Effect.runPromise(
				Effect.flip(
					browser.rpc.ForkSession({
						sessionId: openCodeSession,
						originId: browser.originId,
						targetProjectSlug: "project-b",
					}),
				),
			)
		).message;
		proof["refusals"] = refusals;
		proof["fork rows after refusals"] = forkRows(fixture, sessionId);
		expect(refusals["project-c"]).toMatch(/project-c/);
		expect(refusals["project-d"]).toMatch(/folder/i);
		expect(refusals["opencode"]).toMatch(/opencode.*another project/i);
		expect(forkRows(fixture, sessionId)).toEqual([]);
		expect(forkRows(fixture, openCodeSession)).toEqual([]);
	});
});
