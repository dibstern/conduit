/*
 * Removing a project tears down exactly its work (82tn.14). Failure modes, written before the code
 * (numbering from the lane audit):
 * 1. A live Claude turn of the removed project keeps its runner.
 * 2. A live OpenCode turn of the removed project keeps working on the shared OpenCode.
 * 3. A pending approval or question of the removed project stays open, or its card stays in a tab.
 * 4. The other project's Claude and OpenCode turns on the same shared OpenCode are aborted, stall,
 *    or lose their card, row or terminal; the managed OpenCode stops.
 * 6. A re-add of the same folder brings back a terminal or a turn of the old registration.
 * 7. A tab showing the removed project, or one on the other project, keeps its asks or rows.
 * 8. A terminal open in two tabs keeps running in the PTY host.
 * 9. A poller keeps reading the removed project's sessions.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/provider-instance.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const gitEnv = { ...process.env };
for (const key of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"])
	delete gitEnv[key];

function seedRepository(directory: string): void {
	mkdirSync(directory, { recursive: true });
	for (const args of [
		["init", "-b", "main", directory],
		[
			"-C",
			directory,
			"-c",
			"user.name=Project removal test",
			"-c",
			"user.email=removal@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"-m",
			"Fixture",
		],
	])
		execFileSync("git", args, { env: gitEnv, stdio: "pipe" });
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** What a tab holds now, replayed from one feed's envelopes: id to owner. */
function held(
	browser: ProcessBrowser,
	feed: "shell" | "approvals" | "pty",
	owner: (item: Record<string, unknown>) => string,
	key: (item: Record<string, unknown>) => string,
): Map<string, string> {
	const items = new Map<string, string>();
	for (const { message } of browser.frames) {
		if (message["type"] !== feed) continue;
		const tag = message["_tag"];
		if (tag === "snapshot") {
			items.clear();
			for (const row of message["rows"] as Record<string, unknown>[])
				items.set(key(row), owner(row));
		} else if (tag === "upsert") {
			const item = message["item"] as Record<string, unknown>;
			items.set(key(item), owner(item));
		} else if (tag === "remove") items.delete(String(message["id"]));
	}
	return items;
}

describe("82tn.14: removing a project tears down exactly its work", () => {
	let harness: ProcessHarness | undefined;
	const evidence: Record<string, unknown> = { bead: "conduit-test-82tn.14" };

	afterEach(async ({ task }) => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			harness = undefined;
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn-14-project-removal.json",
				`${JSON.stringify({ result: task.result?.state, failures: task.result?.errors?.map(({ message }) => message), ...evidence }, null, 2)}\n`,
			);
		}
	});

	// test-waits-allow timeout-override: two projects, five sessions, terminals and a re-add exceed 30 s.
	it(
		"removes one project during live turns, asks and terminals while the other project's turns on the same OpenCode continue",
		{
			timeout: 180_000,
		},
		async () => {
			const fixture = ProcessHarness.create({
				dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
				foregroundCli: true,
				restartProof: true,
				autoStartOpenCode: true,
				runnerLifecycle: { idleTimeoutMs: null },
				logLevel: "info",
			});
			harness = fixture;
			const folderB = join(fixture.root, "project-b");
			seedRepository(fixture.projectDir);
			seedRepository(folderB);
			await fixture.restart({
				opencodeIdleTimeoutMs: 120_000,
				startupTimeoutMs: 120_000,
			});
			const { savedSlug: slugB } = await fixture.requestRpc({
				_tag: "SaveProject",
				folders: [folderB],
			});
			const slugA = "process-test";
			const folders = {
				A: realpathSync(fixture.projectDir),
				B: realpathSync(folderB),
			};
			const create = async (
				projectSlug: string,
				title: string,
				provider: "claude" | "opencode",
			) =>
				(
					await fixture.requestRpc({
						_tag: "CreateSession",
						permissionMode: "ask",
						projectSlug,
						originId: "project-removal",
						title,
						providerId: provider,
						...(provider === "opencode"
							? {
									instanceId: MANAGED_OPENCODE_ACCOUNT_ID,
									model: { providerId: "fake", modelId: "fake-model" },
								}
							: { model: { providerId: "claude", modelId: "sonnet" } }),
					} as Parameters<ProcessHarness["requestRpc"]>[0] & {
						_tag: "CreateSession";
					})
				).sessionId;
			const sessions = {
				A: {
					claude: await create(slugA, "A Claude turn", "claude"),
					ask: await create(slugA, "A Claude ask", "claude"),
					opencode: await create(slugA, "A OpenCode turn", "opencode"),
				},
				B: {
					claude: await create(slugB, "B Claude turn", "claude"),
					opencode: await create(slugB, "B OpenCode turn", "opencode"),
				},
			};
			const project = (sessionId: string) =>
				Object.values(sessions.A).includes(sessionId) ? "A" : "B";

			// Two tabs on A share a terminal; one of them holds A's ask. A tab on B.
			const tabA = await fixture.connect(sessions.A.ask, undefined, slugA);
			const tabA2 = await fixture.connect(undefined, undefined, slugA);
			const tabB = await fixture.connect(sessions.B.claude, undefined, slugB);
			const tabs = { tabA, tabA2, tabB };
			const ptyA = await tabA.createPty();
			await tabA2.waitFor(
				(message) =>
					message["type"] === "pty" &&
					message["_tag"] === "upsert" &&
					(message["item"] as { id: string }).id === ptyA.id,
			);
			const ptyB = await tabB.createPty();

			const submit = (
				browser: ProcessBrowser,
				sessionId: string,
				text: string,
			) =>
				Effect.runPromise(
					browser.rpc["input.submit"]({
						sessionId,
						originId: browser.originId,
						inputId: randomUUID(),
						delivery: "queue",
						text,
					}),
				);
			// Claude: a held turn in each project, and an approval left pending in A.
			await submit(tabA, sessions.A.claude, "upgrade-long-turn");
			await submit(tabB, sessions.B.claude, "upgrade-long-turn");
			// test-waits-allow polling: the fake SDK's proof file has no event.
			await vi.waitFor(
				() =>
					expect(
						fixture.marks.filter(
							(mark) =>
								mark.kind === "enqueue" && mark.request === "upgrade-long-turn",
						),
					).toHaveLength(2),
				{ timeout: 30_000 },
			);
			await submit(tabA, sessions.A.ask, "approval-project-removal");
			await tabA.waitFor(
				(message) =>
					message["type"] === "permission_pending" &&
					message["sessionId"] === sessions.A.ask,
				0,
				60_000,
			);

			// OpenCode: a held turn in each project on the one managed instance; A's asks a question.
			writeFileSync(join(fixture.configDir, "fake-opencode-hold-turn"), "hold");
			const promptAsync = (sessionId: string) =>
				fixture
					.opencodeRequests()
					.filter(({ url }) =>
						url.includes(`/session/${sessionId}/prompt_async`),
					);
			const userIds = new Map<string, string>();
			for (const [tab, sessionId, directory] of [
				[tabA, sessions.A.opencode, folders.A],
				[tabB, sessions.B.opencode, folders.B],
			] as const) {
				await submit(tab, sessionId, `opencode-turn ${sessionId}`);
				// test-waits-allow polling: the fake OpenCode request log has no event.
				await vi.waitFor(() => expect(promptAsync(sessionId)).toHaveLength(1), {
					timeout: 15_000,
				});
				// Real OpenCode echoes the user message at once; the held fake does not.
				const { messageID } = JSON.parse(
					fixture
						.opencodeRequestBodies()
						.find(({ path }) => path === `/session/${sessionId}/prompt_async`)
						?.body ?? "{}",
				) as { messageID?: string };
				if (!messageID) throw new Error("prompt_async without a message id");
				userIds.set(sessionId, messageID);
				await fixture.emitOpenCodeEvent({
					directory,
					payload: {
						id: `evt_${randomUUID()}`,
						type: "message.updated",
						properties: {
							info: {
								id: messageID,
								sessionID: sessionId,
								role: "user",
								time: { created: Date.now() },
							},
						},
					},
				});
			}
			await fixture.addOpenCodePrompt("question", folders.A, {
				id: "removal-question",
				sessionID: sessions.A.opencode,
				questions: [
					{
						question: "Proceed?",
						header: "Proceed",
						options: [{ label: "Yes" }],
					},
				],
			});
			await tabA.waitFor(
				(message) =>
					message["type"] === "question_pending" &&
					message["sessionId"] === sessions.A.opencode,
				0,
				60_000,
			);
			await tabB.waitFor(
				(message) =>
					message["type"] === "question_pending" &&
					message["sessionId"] === sessions.A.opencode,
				0,
				60_000,
			);

			const runnerPids = (sessionId: string) => [
				...new Set(
					fixture.marks.flatMap((mark) =>
						mark.kind === "runner-started" && mark.sessionId === sessionId
							? [mark.pid]
							: [],
					),
				),
			];
			const opencodeCalls = (sessionId: string, since: number) =>
				fixture
					.opencodeRequests()
					.filter(
						({ url, at }) =>
							at >= since &&
							new URL(url, "http://fake").pathname.startsWith(
								`/session/${sessionId}`,
							),
					)
					.map(
						({ method, url }) =>
							`${method} ${new URL(url, "http://fake").pathname}`,
					);
			const storeOf = (ids: readonly string[]) => {
				const db = new Database(fixture.daemonStorePath(), { readonly: true });
				try {
					return {
						runs: db
							.prepare(
								`SELECT session_id AS sessionId, status FROM provider_runs
								WHERE session_id IN (${ids.map(() => "?").join(",")}) AND status IN ('pending', 'running')`,
							)
							.all(...ids),
						interactions: db
							.prepare(
								`SELECT session_id AS sessionId, id FROM pending_approvals
								WHERE session_id IN (${ids.map(() => "?").join(",")}) AND status = 'pending'`,
							)
							.all(...ids),
					};
				} finally {
					db.close();
				}
			};
			const ptys = { A: ptyA, B: ptyB };
			const census = (since: number) =>
				Object.fromEntries(
					(["A", "B"] as const).map((key) => {
						const ids = Object.values(sessions[key]);
						const inTabs = (
							feed: "shell" | "approvals" | "pty",
							owner: (item: Record<string, unknown>) => string,
							id: (item: Record<string, unknown>) => string,
						) =>
							Object.fromEntries(
								Object.entries(tabs).map(([name, tab]) => [
									name,
									[...held(tab, feed, owner, id)]
										.filter(([, owned]) => owned === key)
										.map(([itemId]) => itemId)
										.sort(),
								]),
							);
						return [
							key,
							{
								liveRunners: ids.flatMap(runnerPids).filter(alive),
								openCodeCalls: opencodeCalls(sessions[key].opencode, since),
								pty: { id: ptys[key].id, alive: alive(ptys[key].pid) },
								...storeOf(ids),
								askCards: inTabs(
									"approvals",
									(item) => project(String(item["sessionId"])),
									(item) =>
										String(
											item["_tag"] === "permission"
												? item["requestId"]
												: item["toolId"],
										),
								),
								sidebarRows: inTabs(
									"shell",
									(item) => project(String(item["id"])),
									(item) => String(item["id"]),
								),
								terminalRows: inTabs(
									"pty",
									(item) =>
										(item["pty"] as { id: string } | undefined)?.id ===
											ptyA.id || item["id"] === ptyA.id
											? "A"
											: "B",
									(item) =>
										String(
											(item["pty"] as { id: string } | undefined)?.id ??
												item["id"],
										),
								),
							},
						];
					}),
				);

			const removedAt = Date.now();
			const before = census(0);
			evidence["before"] = before;
			expect(before["B"]?.["liveRunners"]).toHaveLength(1);
			expect(before["A"]?.["liveRunners"]).toHaveLength(2);
			expect(before["A"]?.["pty"]).toEqual({ id: ptyA.id, alive: true });

			const openCodePid = fixture.opencodeRequests().at(-1)?.pid;
			await fixture.requestRpc({ _tag: "RemoveProject", slug: slugA });

			// B's turns continue on the same OpenCode and finish.
			const cursorB = tabB.frames.length;
			writeFileSync(join(fixture.root, "release-upgrade-turn"), "release");
			const reply = `msg_reply_${sessions.B.opencode}`;
			await Promise.all([
				fixture.emitOpenCodeEvent({
					directory: folders.B,
					payload: {
						id: `evt_${randomUUID()}`,
						type: "message.updated",
						properties: {
							info: {
								id: reply,
								sessionID: sessions.B.opencode,
								role: "assistant",
								parentID: userIds.get(sessions.B.opencode),
								time: { created: Date.now(), completed: Date.now() },
								finish: "stop",
							},
						},
					},
				}),
				fixture.emitOpenCodeEvent({
					directory: folders.B,
					payload: {
						id: `evt_${randomUUID()}`,
						type: "message.part.updated",
						properties: {
							part: {
								id: `prt_reply_${sessions.B.opencode}`,
								sessionID: sessions.B.opencode,
								messageID: reply,
								type: "text",
								text: "B finished after A was removed",
							},
						},
					},
				}),
			]);
			await fixture.setOpenCodeStatus(folders.B, sessions.B.opencode, {
				type: "idle",
			});
			await Promise.all([
				tabB.waitForTurnEnd(sessions.B.claude, cursorB, 60_000),
				tabB.waitForTurnEnd(sessions.B.opencode, cursorB, 60_000),
			]);

			// Nothing of A survives; B keeps all of its own.
			// test-waits-allow polling: runner exits, host shells and the OpenCode request log have no frame.
			await vi.waitFor(
				() => {
					const now = census(removedAt);
					evidence["after"] = now;
					expect(now["A"]).toMatchObject({
						liveRunners: [],
						openCodeCalls: [`POST /session/${sessions.A.opencode}/abort`],
						// Closed in the host. An open tab's terminal list is not asserted: once the shell drops
						// the project, its project feeds no longer reach the tab (event-audiences.ts allowed()).
						pty: { alive: false },
						interactions: [],
						askCards: { tabA: [], tabA2: [], tabB: [] },
						sidebarRows: { tabA: [], tabA2: [], tabB: [] },
					});
					// The aborted OpenCode Run ends by its deadlines or at a re-add, as no relay reads its
					// evidence (CONTRACT.md 6754-6758); every other Run of A has ended.
					expect(
						(now["A"]?.["runs"] as { sessionId: string }[]).filter(
							({ sessionId }) => sessionId !== sessions.A.opencode,
						),
					).toEqual([]);
				},
				{ timeout: 30_000, interval: 250 },
			);
			const after = census(removedAt);
			evidence["after"] = after;
			expect(after["B"]).toMatchObject({
				liveRunners: before["B"]?.["liveRunners"],
				pty: { id: ptyB.id, alive: true },
				runs: [],
				interactions: [],
				askCards: { tabA: [], tabA2: [], tabB: [] },
				sidebarRows: before["B"]?.["sidebarRows"],
				terminalRows: before["B"]?.["terminalRows"],
			});
			expect(
				(after["B"]?.["openCodeCalls"] as string[]).filter((call) =>
					call.endsWith("/abort"),
				),
			).toEqual([]);
			// The managed OpenCode keeps serving (CONTRACT 3.11).
			expect(alive(Number(openCodePid))).toBe(true);

			// 6: a re-add of the same folder brings back the sessions, not the old work.
			const { savedSlug: readded } = await fixture.requestRpc({
				_tag: "SaveProject",
				folders: [fixture.projectDir],
			});
			const tabReadded = await fixture.connect(undefined, undefined, readded);
			const readd = {
				slug: readded,
				terminals: (await tabReadded.listPtys()).map(({ id }) => id),
				liveRunners: Object.values(sessions.A)
					.flatMap(runnerPids)
					.filter(alive),
				rows: [
					...held(
						tabReadded,
						"shell",
						(item) => String(item["projectSlug"]),
						(item) => String(item["id"]),
					),
				]
					.filter(([id]) => project(id) === "A")
					.map(([id]) => id)
					.sort(),
			};
			evidence["readd"] = readd;
			expect(readd).toEqual({
				slug: readded,
				terminals: [],
				liveRunners: [],
				rows: Object.values(sessions.A).sort(),
			});
		},
	);
});
