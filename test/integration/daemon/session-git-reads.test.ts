import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	DaemonWsRpcHandlersLive,
	DaemonWsRpcHandlersTag,
} from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { OwnerScopesLive } from "../../../src/lib/domain/daemon/Layers/owner-scopes-layer.js";
import { RelayCacheTag } from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import {
	SessionGit,
	SessionGitLive,
} from "../../../src/lib/domain/daemon/Services/session-git.js";
import {
	makeSubprocess,
	Subprocess,
} from "../../../src/lib/domain/daemon/Services/subprocess.js";
import { makePersistenceDaemonLayer } from "../../../src/lib/persistence/effect/live.js";
import { refreshSidebar } from "../../../src/lib/persistence/effect/sidebar-projection.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

// Failures: list decoration reads disk instead of the publication; a cold project
// starts a relay or git; a missing workspace triggers recovery on a read; repeat
// reads change git without changing the row version; the shell has its own reader.
const temporaryRoots: string[] = [];

const git = (directory: string, ...args: string[]) => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "Session git read test",
		GIT_AUTHOR_EMAIL: "git@example.test",
		GIT_COMMITTER_NAME: "Session git read test",
		GIT_COMMITTER_EMAIL: "git@example.test",
	};
	for (const name of [
		"GIT_DIR",
		"GIT_INDEX_FILE",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
	])
		delete env[name];
	return execFileSync("git", ["-C", directory, ...args], {
		encoding: "utf8",
		stdio: "pipe",
		env,
	}).trim();
};

afterEach(() => {
	for (const root of temporaryRoots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("session git publication through daemon RPC reads", () => {
	for (const initialRead of [
		"sessions",
		"projects",
		"shell",
		"module",
	] as const)
		it.live(
			`serves ${initialRead} before other lists with zero subprocesses`,
			() => {
				const root = realpathSync(
					mkdtempSync(join(tmpdir(), "conduit-git-reads-")),
				);
				temporaryRoots.push(root);
				const main = join(root, "main");
				const cold = join(root, "cold");
				const missing = join(root, "missing-worktree");
				for (const directory of [main, cold]) {
					mkdirSync(directory);
					git(directory, "init", "-b", "disk-current");
					git(
						directory,
						"-c",
						"commit.gpgsign=false",
						"commit",
						"--allow-empty",
						"-m",
						"Initial",
					);
				}
				git(main, "worktree", "add", "-b", "missing-branch", missing);
				rmSync(missing, { recursive: true });
				const published = {
					branch: "published-before-disk-change",
					head: git(main, "rev-parse", "HEAD"),
					dirty: false,
				};
				const projects = [
					{
						slug: "main",
						title: "Main",
						folders: [main] as const,
						repositoryIdentities: {},
					},
					{
						slug: "cold",
						title: "Cold",
						folders: [cold] as const,
						repositoryIdentities: {},
					},
				];
				const owner = makeSubprocess();
				const base = makeDaemonRpcTestLayer(projects);
				const layer =
					initialRead === "module"
						? DaemonWsRpcHandlersLive.pipe(
								Layer.provideMerge(
									SessionGitLive.pipe(
										Layer.provideMerge(
											Layer.merge(
												OwnerScopesLive,
												makePersistenceDaemonLayer(),
											),
										),
									),
								),
								Layer.provideMerge(base),
							)
						: base;
				return Effect.gen(function* () {
					yield* Effect.addFinalizer(() => owner.shutdown);
					const sql = yield* SqlClient.SqlClient;
					for (const [id, projectId, workspace] of [
						["main-session", "main", null],
						["cold-session", "cold", null],
						[
							"missing-session",
							"main",
							JSON.stringify({
								cause: "user",
								origin: "conduit",
								worktrees: { [main]: missing },
							}),
						],
					] as const) {
						yield* sql`INSERT INTO sessions (id, project_id, provider, title, status, root_id, workspace, created_at, updated_at, version)
					VALUES (${id}, ${projectId}, 'opencode', ${id}, 'idle', ${id}, ${workspace}, 1, 1, 71)`;
					}
					for (const directory of [main, cold])
						yield* sql`INSERT INTO session_git_published (directory, git) VALUES (${directory}, ${JSON.stringify(published)})`;
					yield* sql`INSERT INTO session_git_published (directory, git) VALUES (${missing}, NULL)`;
					yield* sql`UPDATE read_model_counter SET value = 71 WHERE id = 1`;
					yield* refreshSidebar(
						["main-session", "cold-session", "missing-session"],
						71,
						["main", "cold"],
					);
					if (initialRead === "module") {
						const service = Option.getOrThrow(
							yield* Effect.serviceOption(SessionGit),
						);
						for (const id of [
							"main-session",
							"cold-session",
							"missing-session",
						])
							yield* service.read(id);
						// Startup has its own queued refresh. Let it complete before
						// measuring only subprocesses caused by the RPC requests.
						yield* Effect.sleep(250);
						for (let attempt = 0; attempt < 100; attempt++) {
							const metrics = yield* owner.metrics;
							if (metrics.active === 0 && metrics.queued === 0) break;
							yield* Effect.sleep(20);
						}
						expect(yield* owner.metrics).toMatchObject({
							active: 0,
							queued: 0,
						});
					}
					const expectedGit =
						initialRead === "module"
							? { branch: "disk-current", dirty: false }
							: published;
					const versions = yield* sql<{
						id: string;
						version: number;
					}>`SELECT id, version FROM sessions ORDER BY id`;
					const [counter] = yield* sql<{
						value: number;
					}>`SELECT value FROM read_model_counter WHERE id = 1`;
					const cache = yield* RelayCacheTag;
					expect(Option.isNone(yield* cache.peek("cold"))).toBe(true);
					const handlers = yield* DaemonWsRpcHandlersTag;
					const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
						Effect.provide(
							makeRoutedWsRpcServerLayer(
								() => Effect.die("A list read started a relay"),
								handlers,
							),
							{ local: true },
						),
					);
					const deltas: Record<string, number> = {};
					const measure = <A, E, R>(
						name: string,
						read: Effect.Effect<A, E, R>,
					) =>
						Effect.gen(function* () {
							const before = (yield* owner.metrics).spawnCount;
							const value = yield* read;
							deltas[name] = (yield* owner.metrics).spawnCount - before;
							return value;
						});
					if (initialRead === "projects")
						yield* measure("coldProjectList", client.GetProjects({}));
					if (initialRead === "shell")
						yield* measure(
							"coldShellSessionList",
							client.SubscribeShell({}).pipe(
								Stream.filter((frame) => frame._tag === "snapshot"),
								Stream.take(1),
								Stream.runCollect,
							),
						);
					const first = yield* measure(
						"sessionList",
						client.ListDaemonSessions({ scope: "main" }),
					);
					const repeated = yield* measure(
						"warmSessionList",
						client.ListDaemonSessions({ scope: "main" }),
					);
					const coldList = yield* measure(
						"coldProjectSessionList",
						client.ListDaemonSessions({ scope: "cold" }),
					);
					const listedProjects = yield* measure(
						"projectList",
						client.GetProjects({}),
					);
					const shell = yield* measure(
						"shellSessionList",
						client.SubscribeShell({}).pipe(
							Stream.filter((frame) => frame._tag === "snapshot"),
							Stream.take(1),
							Stream.runCollect,
						),
					);
					const afterVersions = yield* sql<{
						id: string;
						version: number;
					}>`SELECT id, version FROM sessions ORDER BY id`;
					mkdirSync("test-results", { recursive: true });
					writeFileSync(
						`test-results/session-git-read-budget-${initialRead}.json`,
						`${JSON.stringify({ deltas, versions: afterVersions }, null, 2)}\n`,
					);
					expect(deltas).toEqual({
						...(initialRead === "projects" && { coldProjectList: 0 }),
						...(initialRead === "shell" && { coldShellSessionList: 0 }),
						sessionList: 0,
						warmSessionList: 0,
						coldProjectSessionList: 0,
						projectList: 0,
						shellSessionList: 0,
					});
					expect(afterVersions).toEqual(versions);
					expect(
						first.sessions.find(({ id }) => id === "main-session"),
					).toMatchObject({
						git: expectedGit,
					});
					expect(
						first.sessions.find(({ id }) => id === "missing-session")?.git
							?.branch,
					).toBeUndefined();
					expect(repeated.sessions).toEqual(first.sessions);
					expect(coldList.sessions).toMatchObject([
						{
							id: "cold-session",
							git: expectedGit,
						},
					]);
					expect(listedProjects.projects).toHaveLength(2);
					for (const project of listedProjects.projects)
						expect(project.git).toMatchObject({ branch: expectedGit.branch });
					expect(shell[0]).toMatchObject({
						_tag: "snapshot",
						sequence: counter?.value,
						rows: expect.arrayContaining([
							expect.objectContaining({
								id: "main-session",
								git: expect.objectContaining(expectedGit),
							}),
							expect.objectContaining({
								id: "cold-session",
								git: expect.objectContaining(expectedGit),
							}),
						]),
					});
					expect(Option.isNone(yield* cache.peek("cold"))).toBe(true);
				}).pipe(
					Effect.provide(layer, { local: true }),
					Effect.provideService(Subprocess, owner),
					Effect.scoped,
				);
			},
		);
});
