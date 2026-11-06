/*
 * No-project (scratch) sessions through the built daemon (m379.10). Failure modes, written first:
 * 1. Two scratch sessions writing the same file name collide.
 * 2. A daemon restart loses the scratch project or its sessions' folders.
 * 3. Delete with Keep removes the folder, or with Remove leaves it.
 * 5. A scratch session moves (MoveSessionWorkspace / fork).
 * 6. The hidden project shows in GetProjects, status, daemon.json, folder pickers, or can be saved/removed.
 * 7. A removed scratch folder makes the turn run in the shared scratch root.
 * 8. A new worktree or a provider that cannot launch into a Conduit folder is accepted; the mode is not local.
 * 9. The shell feed omits scratch rows, so a browser cannot follow a turn.
 * 10. Scratch events land under a real project.
 * (4, the draft switch, is the browser's; test/e2e/specs/harness-scratch-session.spec.ts.)
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SCRATCH_PROJECT_SLUG } from "../../../src/lib/contracts/scratch-project.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const real = (path: string) => realpathSync(path);

describe("No-project sessions through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};
	const labels = new Map<string, string>();

	async function start(name: string) {
		scenario = name;
		evidence = {};
		labels.clear();
		harness = ProcessHarness.create();
		const fixture = harness;
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
		});
		const socket = join(fixture.configDir, "relay.sock");
		const root = join(fixture.configDir, "scratch");
		const create = async (label: string, providerId = "claude") => {
			const { sessionId } = await sendRpcRequest(socket, {
				_tag: "CreateSession",
				permissionMode: "ask",
				projectSlug: SCRATCH_PROJECT_SLUG,
				originId: "scratch-test",
				providerId,
				model: { providerId: "claude", modelId: "sonnet" },
				title: label,
			});
			labels.set(sessionId, label);
			return { id: sessionId, folder: join(root, sessionId) };
		};
		const rows = async () =>
			(
				await sendRpcRequest(socket, {
					_tag: "ListDaemonSessions",
					scope: SCRATCH_PROJECT_SLUG,
				})
			).sessions;
		const hidden = async () => {
			const { projects } = await sendRpcRequest(socket, {
				_tag: "GetProjects",
			});
			expect(projects.map(({ slug }) => slug)).toEqual(["process-test"]);
			const status = await sendRpcRequest(socket, { _tag: "GetStatus" });
			expect(status.projects.map(({ slug }) => slug)).toEqual(["process-test"]);
			expect(
				readFileSync(join(fixture.configDir, "daemon.json"), "utf8"),
			).not.toContain(SCRATCH_PROJECT_SLUG);
		};
		return { fixture, socket, root, create, rows, hidden };
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const rootPath = real(fixture.root);
		evidence["result"] = task.result?.state;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			let normalized = JSON.stringify(evidence, null, 2);
			for (const [id, label] of labels)
				normalized = normalized.replaceAll(id, `<${label}>`);
			normalized = normalized
				.replaceAll(rootPath, "<root>")
				.replaceAll(fixture.root, "<root>");
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/m379-10-scratch-${scenario}.json`,
				`${normalized}\n`,
			);
			harness = undefined;
		}
	});

	it("runs each session in its own folder, survives a restart, and deletes with keep or remove", async () => {
		const { fixture, socket, root, create, rows, hidden } =
			await start("lifecycle");
		await hidden();
		expect(
			await sendRpcRequest(socket, {
				_tag: "ResolveSessionMode",
				projectSlug: SCRATCH_PROJECT_SLUG,
			}),
		).toMatchObject({ mode: "local" });
		const alpha = await create("alpha");
		const beta = await create("beta");
		expect(readdirSync(alpha.folder)).toEqual([]);
		expect(readdirSync(beta.folder)).toEqual([]);
		const listed = await rows();
		expect(listed.map(({ id }) => id).sort()).toEqual(
			[alpha.id, beta.id].sort(),
		);
		for (const { id, folder } of [alpha, beta]) {
			const row = listed.find((session) => session.id === id);
			expect(row?.workspace?.origin).toBe("existing");
			expect(Object.values(row?.workspace?.worktrees ?? {}).map(real)).toEqual([
				real(folder),
			]);
		}

		const browser = await fixture.connect(
			undefined,
			undefined,
			SCRATCH_PROJECT_SLUG,
		);
		await browser.view(alpha.id);
		await browser.send(alpha.id, "workspace-isolation-write alpha", 120_000);
		await browser.view(beta.id);
		await browser.send(beta.id, "workspace-isolation-write beta", 120_000);
		const file = (folder: string) =>
			readFileSync(join(folder, "session-only.txt"), "utf8");
		expect(file(alpha.folder)).toBe("workspace-isolation-write alpha");
		expect(file(beta.folder)).toBe("workspace-isolation-write beta");
		expect(existsSync(join(root, "session-only.txt"))).toBe(false);
		expect(existsSync(join(fixture.projectDir, "session-only.txt"))).toBe(
			false,
		);
		for (const { id, folder } of [alpha, beta])
			expect(
				sessionQueries(fixture, id).map(({ options }) =>
					real(String(options["cwd"])),
				),
			).toEqual([real(folder)]);
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			expect(
				db
					.prepare(
						"SELECT DISTINCT project_id FROM events WHERE session_id IN (?, ?)",
					)
					.all(alpha.id, beta.id),
			).toEqual([{ project_id: SCRATCH_PROJECT_SLUG }]);
		} finally {
			db.close();
		}

		await fixture.shutdown();
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
		});
		await hidden();
		expect((await rows()).map(({ id }) => id).sort()).toEqual(
			[alpha.id, beta.id].sort(),
		);
		const restarted = await fixture.connect(
			undefined,
			undefined,
			SCRATCH_PROJECT_SLUG,
		);
		await restarted.view(alpha.id);
		await restarted.send(alpha.id, "workspace-isolation-write gamma", 120_000);
		expect(file(alpha.folder)).toBe("workspace-isolation-write gamma");
		expect(file(beta.folder)).toBe("workspace-isolation-write beta");
		evidence["folders"] = Object.fromEntries(
			[alpha, beta].map(({ id, folder }) => [
				labels.get(id),
				{ path: folder, files: readdirSync(folder), text: file(folder) },
			]),
		);

		const inspection = await sendRpcRequest(socket, {
			_tag: "InspectSessionWorktrees",
			sessionId: alpha.id,
		});
		expect(inspection).toMatchObject({
			onDelete: "ask",
			removeWorktrees: false,
			worktrees: [{ path: alpha.folder, inUse: false }],
		});
		evidence["inspection"] = inspection;
		await sendRpcRequest(socket, {
			_tag: "DeleteSession",
			sessionId: alpha.id,
			removeWorktrees: false,
		});
		await sendRpcRequest(socket, {
			_tag: "DeleteSession",
			sessionId: beta.id,
			removeWorktrees: true,
		});
		expect(file(alpha.folder)).toBe("workspace-isolation-write gamma");
		expect(existsSync(beta.folder)).toBe(false);
		expect(await rows()).toEqual([]);
		evidence["afterDelete"] = { kept: readdirSync(root).length === 1 };
	});

	it("refuses moves, worktrees, other providers, project edits and a missing folder", async () => {
		const { fixture, socket, root, create, rows, hidden } =
			await start("refusals");
		const session = await create("refused");
		const refusals: Record<string, unknown> = {};
		const refused = async (label: string, request: Promise<unknown>) => {
			const error = await request.then(
				() => undefined,
				(cause: unknown) => cause,
			);
			expect(error, label).toBeDefined();
			const { _tag, message } = error as { _tag?: string; message?: string };
			refusals[label] = { _tag, message };
			return error;
		};
		await refused(
			"new-worktree",
			sendRpcRequest(socket, {
				_tag: "CreateSession",
				permissionMode: "ask",
				projectSlug: SCRATCH_PROJECT_SLUG,
				originId: "scratch-test",
				providerId: "claude",
				model: { providerId: "claude", modelId: "sonnet" },
				newWorktree: true,
			}),
		);
		await refused(
			"existing-worktree",
			sendRpcRequest(socket, {
				_tag: "CreateSession",
				permissionMode: "ask",
				projectSlug: SCRATCH_PROJECT_SLUG,
				originId: "scratch-test",
				providerId: "claude",
				model: { providerId: "claude", modelId: "sonnet" },
				worktreePath: fixture.projectDir,
			}),
		);
		const { addedInstanceId } = await sendRpcRequest(socket, {
			_tag: "AddInstance",
			name: "Cursor",
			driver: "cursor",
		});
		if (!addedInstanceId) throw new Error("Missing registered Cursor account");
		expect(
			await refused("cursor", create("cursor", addedInstanceId)),
		).toMatchObject({
			_tag: "WorkspaceMoveError",
			reason: "unsupported-provider",
		});
		await refused(
			"move",
			sendRpcRequest(socket, {
				_tag: "MoveSessionWorkspace",
				sessionId: session.id,
				path: fixture.projectDir,
			}),
		);
		await refused(
			"fork",
			sendRpcRequest(socket, {
				_tag: "ForkSession",
				originId: "scratch-test",
				sessionId: session.id,
			}),
		);
		expect(
			await refused(
				"save-slug",
				sendRpcRequest(socket, {
					_tag: "SaveProject",
					slug: SCRATCH_PROJECT_SLUG,
					title: "Renamed",
					folders: [fixture.projectDir],
				}),
			),
		).toMatchObject({ _tag: "ProjectSaveRejected" });
		for (const path of [root, session.folder])
			expect(
				await refused(
					`save-folder:${path === root ? "root" : "session"}`,
					sendRpcRequest(socket, { _tag: "SaveProject", folders: [path] }),
				),
			).toMatchObject({
				_tag: "ProjectSaveRejected",
				issues: [{ kind: "conduit-worktree" }],
			});
		await refused(
			"find-folders",
			sendRpcRequest(socket, { _tag: "FindFolders", query: session.folder }),
		);
		await refused(
			"remove",
			sendRpcRequest(socket, {
				_tag: "RemoveProject",
				slug: SCRATCH_PROJECT_SLUG,
			}),
		);
		await hidden();
		expect((await rows()).map(({ id }) => id)).toEqual([session.id]);
		evidence["refusals"] = refusals;
		expect(refusals).toMatchObject({
			"new-worktree": { message: expect.stringContaining("not a worktree") },
			"existing-worktree": {
				message: expect.stringContaining("not a worktree"),
			},
			move: { message: expect.stringContaining("stays in its own folder") },
			fork: { message: expect.stringContaining("cannot be forked") },
			remove: { message: expect.stringContaining(SCRATCH_PROJECT_SLUG) },
		});

		rmSync(session.folder, { recursive: true });
		const browser = await fixture.connect(
			undefined,
			undefined,
			SCRATCH_PROJECT_SLUG,
		);
		await browser.view(session.id);
		const reply = await browser
			.send(session.id, "workspace-isolation-write leaked", 120_000)
			.catch(String);
		evidence["missingFolder"] = reply;
		expect(reply).toEqual(
			expect.stringContaining(
				`Session folder does not exist: ${session.folder}`,
			),
		);
		expect(existsSync(session.folder)).toBe(false);
		expect(existsSync(join(root, "session-only.txt"))).toBe(false);
		expect(sessionQueries(fixture, session.id)).toEqual([]);
	});
});

function sessionQueries(harness: ProcessHarness, sessionId: string) {
	const pids = new Set(
		harness.marks.flatMap((mark) =>
			mark.kind === "runner-started" && mark.sessionId === sessionId
				? [mark.pid]
				: [],
		),
	);
	return harness.claudeOptions().filter(({ pid }) => pids.has(pid));
}
