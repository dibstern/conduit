/*
 * Failure cases specified before implementing project setup:
 * - A nonzero exit is visible and does not prevent a following agent turn.
 * - A hanging script times out, kills its process group, and leaves the session usable.
 * - Excessive output is capped with a truncation note (runner boundary coverage).
 * - A background child outliving the shell is stopped (runner boundary coverage).
 * - Invalid JSON and a schema-invalid project file visibly skip setup.
 * - The daemon setting wins over the checked-in file, including after restart.
 * - A first turn submitted during setup observes the marker only after setup finishes.
 * - A daemon restart during setup makes the persisted block terminal.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventPayloadMap } from "../../../src/lib/contracts/stored-event.js";
import {
	CreateSession,
	GetProjects,
	ListDaemonSessions,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

type SetupEvent =
	| {
			type: "session.setup_started";
			data: EventPayloadMap["session.setup_started"];
	  }
	| {
			type: "session.setup_output";
			data: EventPayloadMap["session.setup_output"];
	  }
	| {
			type: "session.setup_finished";
			data: EventPayloadMap["session.setup_finished"];
	  };

const gitOverrides = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
const gitEnv = { ...process.env };
for (const key of gitOverrides) delete gitEnv[key];

function git(directory: string, ...args: string[]): void {
	execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw cause;
	}
}

function setupEvents(fixture: ProcessHarness, sessionId: string): SetupEvent[] {
	const db = new Database(fixture.projectStorePath(), { readonly: true });
	try {
		const rows = db
			.prepare(
				"SELECT type, data FROM events WHERE session_id = ? AND type IN ('session.setup_started', 'session.setup_output', 'session.setup_finished') ORDER BY sequence",
			)
			.all(sessionId) as { type: SetupEvent["type"]; data: string }[];
		return rows.map(({ type, data }) => ({
			type,
			data: JSON.parse(data) as SetupEvent["data"],
		})) as SetupEvent[];
	} finally {
		db.close();
	}
}

function setupOutput(fixture: ProcessHarness, sessionId: string): string {
	return setupEvents(fixture, sessionId)
		.flatMap((event) =>
			event.type === "session.setup_output" ? [event.data.output] : [],
		)
		.join("");
}

function finishedSetup(fixture: ProcessHarness, sessionId: string) {
	return setupEvents(fixture, sessionId).find(
		(event) => event.type === "session.setup_finished",
	)?.data;
}

describe("Project setup scripts through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	const sessions = new Map<string, { title: string; path: string }>();
	const releaseFiles = new Set<string>();
	let evidence: Record<string, unknown> = {};

	async function start(name: string, setupTimeoutMs = 10_000) {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		scenario = name;
		sessions.clear();
		releaseFiles.clear();
		evidence = {};
		harness = ProcessHarness.create();
		const fixture = harness;
		git(fixture.projectDir, "init", "-b", "main");
		writeFileSync(join(fixture.projectDir, "base.txt"), "committed base\n");
		git(fixture.projectDir, "add", "base.txt");
		git(
			fixture.projectDir,
			"-c",
			"user.name=Setup test",
			"-c",
			"user.email=setup@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-m",
			"Initial commit",
		);
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
			setupTimeoutMs,
		});
		const socket = join(fixture.configDir, "relay.sock");
		const save = (setupScript: string) =>
			sendRpcRequest(
				socket,
				new SaveProject({
					slug: "process-test",
					folders: [fixture.projectDir],
					setupScript,
				}),
			);
		const create = async (title: string, newWorktree = true) => {
			const created = await sendRpcRequest(
				socket,
				new CreateSession({
					permissionMode: "ask",
					projectSlug: "process-test",
					originId: "project-setup-test",
					providerId: "claude",
					title,
					...(newWorktree ? { newWorktree: true } : {}),
				}),
			);
			const rows = await sendRpcRequest(
				socket,
				new ListDaemonSessions({
					projectSlug: "process-test",
					scope: "process-test",
				}),
			);
			const session = rows.sessions.find(({ id }) => id === created.sessionId);
			const path = newWorktree
				? session?.workspace?.worktrees[fixture.projectDir]
				: fixture.projectDir;
			if (!path) throw new Error("New session did not publish its worktree");
			sessions.set(created.sessionId, { title, path });
			return { id: created.sessionId, path };
		};
		return { fixture, socket, save, create };
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		for (const file of releaseFiles) writeFileSync(file, "release\n");
		evidence["result"] = task.result?.state;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		if (task.result?.errors?.length)
			evidence["diagnosticLogs"] = fixture.logTail.slice(-4_000);
		try {
			if (existsSync(fixture.projectStorePath()))
				evidence["sessions"] = [...sessions]
					.sort(([, a], [, b]) => a.title.localeCompare(b.title))
					.map(([id, { title, path }]) => {
						const events = setupEvents(fixture, id);
						const started = events.find(
							(event) => event.type === "session.setup_started",
						);
						const finished = finishedSetup(fixture, id);
						const marker = join(path, "setup-marker.txt");
						return {
							session: title,
							path,
							source: started?.data.source ?? "none",
							outcome: finished?.status ?? (started ? "running" : "none"),
							exitCode: finished?.exitCode ?? null,
							message: finished?.message ?? null,
							markerPresent: existsSync(marker),
							marker: existsSync(marker) ? readFileSync(marker, "utf8") : null,
							output: setupOutput(fixture, id),
							eventTypes: events.map(({ type }) => type),
						};
					});
		} finally {
			try {
				await fixture.dispose();
				expect(fixture.remainingRunnerPids()).toEqual([]);
				evidence["cleanup"] = "no fixture runners remain";
			} finally {
				let manifest = JSON.stringify(
					evidence,
					(_key, value: unknown) =>
						value !== null && typeof value === "object" && !Array.isArray(value)
							? Object.fromEntries(
									Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
								)
							: value,
					2,
				);
				for (const [id, { title, path }] of sessions) {
					if (path !== fixture.projectDir)
						manifest = manifest.replaceAll(
							path,
							`<root>/config/worktrees/process-test/${title}/app`,
						);
					manifest = manifest.replaceAll(id, `<session:${title}>`);
				}
				manifest = manifest
					.replaceAll(
						fixture.root.replace(/^\/tmp\//, "/private/tmp/"),
						"<root>",
					)
					.replaceAll(fixture.root, "<root>")
					.replace(/\(node:\d+\)/g, "(node:<pid>)")
					.replace(/"time":\d+/g, '"time":"<time>"')
					.replace(/"pid":\d+/g, '"pid":"<pid>"')
					.replace(/"hostname":"[^"]+"/g, '"hostname":"<host>"');
				mkdirSync("test-results", { recursive: true });
				writeFileSync(`test-results/q5u6-6-${scenario}.json`, `${manifest}\n`);
				harness = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	it("returns while setup runs, streams both output channels, and gates the first turn", async () => {
		const { fixture, save, create } = await start("first-turn", 30_000);
		const release = join(fixture.root, "release-setup");
		releaseFiles.add(release);
		await save(
			`printf 'setup stdout\\n'; printf 'setup stderr\\n' >&2; while [ ! -e ${shellQuote(release)} ]; do sleep 0.02; done; printf 'ready' > setup-marker.txt; printf 'setup complete\\n'`,
		);
		const session = await create("New session");
		await vi.waitFor(
			() => {
				expect(setupOutput(fixture, session.id)).toContain("setup stdout");
				expect(setupOutput(fixture, session.id)).toContain("setup stderr");
			},
			{ timeout: 10_000 },
		);
		expect(finishedSetup(fixture, session.id)).toBeUndefined();
		expect(existsSync(join(session.path, "setup-marker.txt"))).toBe(false);
		const browser = await fixture.connect();
		await browser.view(session.id);
		const runningParts = (await browser.history(session.id))
			.flatMap((message) => message.parts ?? [])
			.filter((part) => part.type === "setup");
		expect(runningParts).toHaveLength(1);
		expect(runningParts[0]).toMatchObject({
			type: "setup",
			text: expect.stringContaining("setup stdout"),
			setup: { source: "daemon", status: "running" },
		});
		expect(runningParts[0]?.text).toContain("setup stderr");
		let firstTurnPending = true;
		const firstTurn = browser
			.send(session.id, "project-setup-read", 120_000)
			.finally(() => {
				firstTurnPending = false;
			});
		// Handle teardown rejection if an assertion fails before the turn is awaited.
		void firstTurn.catch(() => undefined);
		const admissionDb = new Database(fixture.projectStorePath(), {
			readonly: true,
		});
		try {
			const admittedCount = () =>
				(
					admissionDb
						.prepare(
							"SELECT count(*) AS count FROM events WHERE session_id = ? AND type = 'input.admitted'",
						)
						.get(session.id) as { count: number }
				).count;
			// Input admission belongs to atomic turn dispatch, after the setup gate.
			await new Promise<void>((done) => setTimeout(done, 1_000));
			expect(firstTurnPending).toBe(true);
			expect(admittedCount()).toBe(0);
			expect(existsSync(join(session.path, "setup-marker.txt"))).toBe(false);
			expect(
				fixture
					.claudeOptions()
					.filter(({ prompt }) => prompt?.includes("project-setup-read")),
			).toEqual([]);
			writeFileSync(release, "release\n");
			expect((await firstTurn).chunks.join("")).toBe("ready");
			expect(admittedCount()).toBe(1);
		} finally {
			admissionDb.close();
		}
		await vi.waitFor(
			() =>
				expect(fixture.claudeTitles()).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							prompt: expect.stringContaining("project-setup-read"),
							cwd: session.path,
						}),
					]),
				),
			{ timeout: 10_000 },
		);
		expect(finishedSetup(fixture, session.id)).toEqual({
			sessionId: session.id,
			status: "succeeded",
			exitCode: 0,
		});
		expect(setupOutput(fixture, session.id)).toContain("setup complete");
		// A browser already viewing the session must see the block finish live,
		// not only on a fresh history read.
		await browser.waitFor((message) => {
			const parts: unknown = message["parts"];
			return (
				message["type"] === "transcript_message" &&
				message["sessionId"] === session.id &&
				Array.isArray(parts) &&
				parts.some(
					(part: { type?: string; setup?: { status?: string } }) =>
						part.type === "setup" && part.setup?.status === "succeeded",
				)
			);
		});
		const succeededParts = (await browser.history(session.id))
			.flatMap((message) => message.parts ?? [])
			.filter((part) => part.type === "setup");
		expect(succeededParts).toHaveLength(1);
		expect(succeededParts[0]).toMatchObject({
			type: "setup",
			text: expect.stringContaining("setup complete"),
			setup: { source: "daemon", status: "succeeded", exitCode: 0 },
		});
		expect(succeededParts[0]?.text).toContain("setup stdout");
		expect(succeededParts[0]?.text).toContain("setup stderr");
		const db = new Database(fixture.projectStorePath(), { readonly: true });
		try {
			const events = db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(session.id) as { type: string; data: string }[];
			const types = events.map(({ type }) => type);
			expect(types.indexOf("session.created")).toBeLessThan(
				types.indexOf("session.setup_started"),
			);
			const firstAssistant = events.findIndex(
				({ type, data }) =>
					type === "message.created" &&
					(JSON.parse(data) as { role: string }).role === "assistant",
			);
			expect(types.indexOf("session.setup_finished")).toBeLessThan(
				firstAssistant,
			);
			evidence["eventOrder"] = types;
		} finally {
			db.close();
		}
	}, 300_000);

	it("records failure and timeout and still runs a following turn", async () => {
		const { fixture, save, create } = await start("failure-timeout", 500);
		await save("printf 'setup failed\\n' >&2; exit 23");
		const failed = await create("nonzero");
		await vi.waitFor(
			() =>
				expect(finishedSetup(fixture, failed.id)).toMatchObject({
					status: "failed",
					exitCode: 23,
				}),
			{ timeout: 10_000 },
		);
		expect(setupOutput(fixture, failed.id)).toContain("setup failed");
		const release = join(fixture.root, "release-hanging-setup");
		releaseFiles.add(release);
		await save(
			`printf 'setup hanging\\n'; while [ ! -e ${shellQuote(release)} ]; do sleep 0.05; done`,
		);
		const hanging = await create("timeout");
		await vi.waitFor(
			() =>
				expect(finishedSetup(fixture, hanging.id)).toMatchObject({
					status: "timed_out",
				}),
			{ timeout: 10_000 },
		);
		expect(setupOutput(fixture, hanging.id)).toContain("setup hanging");
		const browser = await fixture.connect();
		for (const [session, status, output] of [
			[failed, "failed", "setup failed"],
			[hanging, "timed_out", "setup hanging"],
		] as const) {
			await browser.view(session.id);
			const parts = (await browser.history(session.id))
				.flatMap((message) => message.parts ?? [])
				.filter((part) => part.type === "setup");
			expect(parts).toHaveLength(1);
			expect(parts[0]).toMatchObject({
				type: "setup",
				text: expect.stringContaining(output),
				setup: {
					source: "daemon",
					status,
					...(status === "failed" ? { exitCode: 23 } : {}),
				},
			});
			expect(
				(
					await browser.send(session.id, "project-setup-read", 120_000)
				).chunks.join(""),
			).toBe("absent");
		}
	}, 300_000);

	it("persists daemon precedence, clears it, and rereads the primary project file for each session", async () => {
		const { fixture, socket, save, create } = await start("sources");
		const projectFile = join(fixture.projectDir, "conduit.json");
		writeFileSync(
			projectFile,
			JSON.stringify({
				setupScript:
					"printf 'file-first' > setup-marker.txt; printf 'file output\\n'",
				futureSetting: true,
			}),
		);
		const script =
			"printf 'daemon' > setup-marker.txt; printf 'daemon output\\n'";
		await save(script);
		expect(
			(await sendRpcRequest(socket, new GetProjects({}))).projects.find(
				({ slug }) => slug === "process-test",
			)?.setupScript,
		).toBe(script);
		const daemon = await create("daemon-over-file");
		await vi.waitFor(
			() => expect(finishedSetup(fixture, daemon.id)?.status).toBe("succeeded"),
			{ timeout: 10_000 },
		);
		expect(readFileSync(join(daemon.path, "setup-marker.txt"), "utf8")).toBe(
			"daemon",
		);
		expect(setupEvents(fixture, daemon.id)[0]?.data).toMatchObject({
			source: "daemon",
		});
		await fixture.shutdown();
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
		});
		expect(
			(await sendRpcRequest(socket, new GetProjects({}))).projects.find(
				({ slug }) => slug === "process-test",
			)?.setupScript,
		).toBe(script);
		const persisted = await create("persisted-daemon");
		await vi.waitFor(
			() =>
				expect(finishedSetup(fixture, persisted.id)?.status).toBe("succeeded"),
			{ timeout: 10_000 },
		);
		expect(readFileSync(join(persisted.path, "setup-marker.txt"), "utf8")).toBe(
			"daemon",
		);
		await save(" \n\t ");
		expect(
			(await sendRpcRequest(socket, new GetProjects({}))).projects.find(
				({ slug }) => slug === "process-test",
			)?.setupScript,
		).toBeUndefined();
		await vi.waitFor(
			() => {
				const config = JSON.parse(
					readFileSync(join(fixture.configDir, "daemon.json"), "utf8"),
				) as {
					projects: { slug: string; setupScript?: string }[];
				};
				expect(
					config.projects.find(({ slug }) => slug === "process-test"),
				).not.toHaveProperty("setupScript");
			},
			{ timeout: 10_000 },
		);
		const firstFile = await create("file-first");
		await vi.waitFor(
			() =>
				expect(finishedSetup(fixture, firstFile.id)?.status).toBe("succeeded"),
			{ timeout: 10_000 },
		);
		expect(readFileSync(join(firstFile.path, "setup-marker.txt"), "utf8")).toBe(
			"file-first",
		);
		expect(existsSync(join(firstFile.path, "conduit.json"))).toBe(false);
		writeFileSync(
			projectFile,
			JSON.stringify({
				setupScript: "printf 'file-second' > setup-marker.txt",
			}),
		);
		const secondFile = await create("file-second");
		await vi.waitFor(
			() =>
				expect(finishedSetup(fixture, secondFile.id)?.status).toBe("succeeded"),
			{ timeout: 10_000 },
		);
		expect(
			readFileSync(join(secondFile.path, "setup-marker.txt"), "utf8"),
		).toBe("file-second");
		expect(setupEvents(fixture, secondFile.id)[0]?.data).toMatchObject({
			source: "file",
		});
		rmSync(projectFile);
		const absent = await create("no-script");
		expect(setupEvents(fixture, absent.id)).toEqual([]);
		await save(script);
		const local = await create("local", false);
		const browser = await fixture.connect();
		await browser.view(local.id);
		expect(
			(await browser.send(local.id, "project-setup-read", 120_000)).chunks.join(
				"",
			),
		).toBe("absent");
		expect(setupEvents(fixture, local.id)).toEqual([]);
		expect(existsSync(join(fixture.projectDir, "setup-marker.txt"))).toBe(
			false,
		);
	}, 300_000);

	it("visibly skips invalid JSON and schema-invalid project files without blocking turns", async () => {
		const { fixture, create } = await start("invalid-project-file");
		const browser = await fixture.connect();
		for (const [title, contents] of [
			["invalid-json", "{ broken JSON"],
			["invalid-schema", JSON.stringify({ setupScript: 123 })],
		] as const) {
			writeFileSync(join(fixture.projectDir, "conduit.json"), contents);
			const session = await create(title);
			await vi.waitFor(
				() =>
					expect(finishedSetup(fixture, session.id)).toMatchObject({
						status: "skipped",
						message: expect.stringMatching(/conduit\.json/i),
					}),
				{ timeout: 10_000 },
			);
			expect(setupEvents(fixture, session.id)[0]?.data).toMatchObject({
				source: "file",
			});
			expect(finishedSetup(fixture, session.id)?.message).toBeTruthy();
			expect(setupOutput(fixture, session.id)).toBe("");
			await browser.view(session.id);
			const parts = (await browser.history(session.id))
				.flatMap((message) => message.parts ?? [])
				.filter((part) => part.type === "setup");
			expect(parts).toHaveLength(1);
			expect(parts[0]).toMatchObject({
				type: "setup",
				text: "",
				setup: {
					source: "file",
					status: "skipped",
					message: expect.stringMatching(/conduit\.json/i),
				},
			});
			expect(
				(
					await browser.send(session.id, "project-setup-read", 120_000)
				).chunks.join(""),
			).toBe("absent");
		}
	}, 300_000);

	it("makes interrupted setup terminal after an abrupt daemon restart and still runs a turn", async () => {
		const { fixture, save, create } = await start(
			"interrupted-restart",
			30_000,
		);
		const release = join(fixture.root, "release-interrupted-setup");
		const pidFile = join(fixture.root, "interrupted-setup-pid");
		releaseFiles.add(release);
		await save(
			`printf '%s\\n' "$$" > ${shellQuote(pidFile)}; printf 'setup before restart\\n'; while [ ! -e ${shellQuote(release)} ]; do sleep 0.05; done`,
		);
		const session = await create("interrupted");
		await vi.waitFor(
			() =>
				expect(setupOutput(fixture, session.id)).toContain(
					"setup before restart",
				),
			{ timeout: 10_000 },
		);
		const setupPid = Number(readFileSync(pidFile, "utf8").trim());
		expect(Number.isSafeInteger(setupPid) && setupPid > 0).toBe(true);
		expect(finishedSetup(fixture, session.id)).toBeUndefined();
		evidence["interruptedProcess"] = {
			pid: "<setup-pid>",
			stoppedBeforeTurn: false,
			releaseUsedToStop: false,
		};
		await fixture.kill();
		await vi.waitFor(() => expect(processExists(setupPid)).toBe(false), {
			timeout: 10_000,
		});
		evidence["interruptedProcess"] = {
			pid: "<setup-pid>",
			stoppedBeforeTurn: true,
			releaseUsedToStop: false,
		};
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
		});
		await vi.waitFor(
			() =>
				expect(finishedSetup(fixture, session.id)).toMatchObject({
					status: "failed",
					message: expect.stringMatching(/restart|interrupt/i),
				}),
			{ timeout: 10_000 },
		);
		expect(
			setupEvents(fixture, session.id).filter(
				({ type }) => type === "session.setup_finished",
			),
		).toHaveLength(1);
		expect(setupOutput(fixture, session.id)).toContain("setup before restart");
		const browser = await fixture.connect();
		await browser.view(session.id);
		const recoveredParts = (await browser.history(session.id))
			.flatMap((message) => message.parts ?? [])
			.filter((part) => part.type === "setup");
		expect(recoveredParts).toHaveLength(1);
		expect(recoveredParts[0]).toMatchObject({
			type: "setup",
			text: expect.stringContaining("setup before restart"),
			setup: {
				source: "daemon",
				status: "failed",
				message: expect.stringMatching(/restart|interrupt/i),
			},
		});
		expect(
			(
				await browser.send(session.id, "project-setup-read", 120_000)
			).chunks.join(""),
		).toBe("absent");
	}, 300_000);
});
