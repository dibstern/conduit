/*
 * Default-account RPC failure modes:
 * - Moving the default must persist before replying and update both clients.
 * - Session-list subscribers must be invalidated by the same mutation.
 * - Deleted and legacy bindings must show the effective account on every read.
 * - A live former default must stay on itself after moving the pointer.
 * - Zero Claude accounts must keep history visible with no invented account.
 * - Adding an account must refresh previously unroutable session lists.
 * - Unknown and OpenCode accounts must fail with a typed rejection.
 * All config, account folders and environment variables are fixture-owned.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Either, Layer, Queue, Stream } from "effect";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { AccountChangeRejected } from "../../../src/lib/contracts/account.js";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { accountsStateFromInstances } from "../../../src/lib/daemon/account-directory.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import {
	ConfigPersistenceLive,
	ConfigSnapshotFromEffectStateLive,
	makeConfigWriterLive,
} from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import type { DaemonInstanceConfig } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import { projectEventsDbPath } from "../../../src/lib/persistence/project-storage.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import type { StoredProject } from "../../../src/lib/types.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";
import { writeEventStore } from "../../helpers/persistence-factories.js";

let root: string;
const evidence: Array<{ name: string; result: string | undefined }> = [];
const accountObservations: Array<Record<string, string | null>> = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "conduit-default-account-"));
	for (const folder of ["home", "launch", "original", "personal", "work"]) {
		mkdirSync(join(root, folder));
	}
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "launch"));
	vi.stubEnv("CONDUIT_CONFIG_DIR", root);
});
afterEach(({ task }) => {
	vi.unstubAllEnvs();
	evidence.push({ name: task.name, result: task.result?.state });
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/g4zp-8-rpc.json",
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	writeFileSync(
		"test-results/g4zp-9-rpc.json",
		`${JSON.stringify({ tests: evidence, accountObservations }, null, 2)}\n`,
	);
	rmSync(root, { recursive: true, force: true });
});

const fixture = (
	projects: ReadonlyArray<StoredProject> = [],
	claudeAccounts: "all" | "noOriginal" | "none" = "all",
) => {
	const instances = (
		[
			{
				id: "claude",
				name: "Claude",
				driver: "claude",
				configDir: join(root, "original"),
				port: 0,
				managed: false,
			},
			{
				id: "personal",
				name: "Personal",
				driver: "claude",
				configDir: join(root, "personal"),
				port: 0,
				managed: false,
			},
			{
				id: "opencode",
				name: "OpenCode",
				driver: "opencode",
				port: 4099,
				managed: false,
			},
		] satisfies ReadonlyArray<DaemonInstanceConfig>
	).filter(
		(instance) =>
			instance.driver !== "claude" ||
			(claudeAccounts !== "none" &&
				(claudeAccounts !== "noOriginal" || instance.id !== "claude")),
	);
	const launchLogin = configuredClaudeConfigDir(join(root, "launch"));
	return makeDaemonRpcTestLayer(projects, undefined, {
		configDir: root,
		launchLogin,
		instances,
		accountsState: accountsStateFromInstances(instances, launchLogin, 5, {
			deleted: [
				{ id: AccountIdSchema.make("deleted-claude"), driver: "claude" },
			],
		}),
		persistence: ConfigPersistenceLive.pipe(
			Layer.provide(
				Layer.merge(
					ConfigSnapshotFromEffectStateLive,
					makeConfigWriterLive(root),
				),
			),
		),
	});
};

const sessionFixture = () => {
	const project: StoredProject = {
		slug: "project",
		title: "Project",
		folders: [join(root, "project")],
	};
	mkdirSync(project.folders[0]);
	const database = projectEventsDbPath({ configDir: root, ...project });
	mkdirSync(join(root, "projects", project.slug), { recursive: true });
	writeEventStore(
		database,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			for (const accountId of [
				"deleted-claude",
				"claude-sdk",
				"claude",
				"opencode",
				"unknown",
			]) {
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES (${accountId}, 'opencode', ${accountId}, 'idle', 1, 1)`;
				yield* sql`INSERT INTO session_providers (id, session_id, provider, status, activated_at)
				VALUES (${`binding-${accountId}`}, ${accountId}, ${accountId}, 'active', 1)`;
			}
		}),
	);
	return project;
};

const makeClient = Effect.gen(function* () {
	const handlers = yield* DaemonWsRpcHandlersTag;
	return yield* RpcTest.makeClient(WsRpcGroup).pipe(
		Effect.provide(
			makeRoutedWsRpcServerLayer(
				() => Effect.die("Unexpected project routing"),
				handlers,
			),
		),
	);
});

describe("default Claude account through daemon RPC", () => {
	it.scoped(
		"resolves deleted bindings and refreshes effective accounts when the default moves",
		() => {
			const project = sessionFixture();
			return Effect.gen(function* () {
				const client = yield* makeClient;
				const revisions = yield* Queue.unbounded<number>();
				yield* Stream.runForEach(client.SubscribeServerStatus({}), (status) =>
					Queue.offer(revisions, status.sessionsRevision),
				).pipe(Effect.forkScoped);
				let revision = yield* Queue.take(revisions);
				const readAccounts = Effect.gen(function* () {
					const result = yield* client.ListDaemonSessions({
						projectSlug: project.slug,
					});
					expect(result.availability).toEqual([
						{ projectSlug: project.slug, available: true },
					]);
					const accounts = Object.fromEntries(
						result.sessions.map((session) => [session.id, session.accountId]),
					);
					accountObservations.push(accounts);
					return accounts;
				});
				expect(yield* readAccounts).toEqual({
					"deleted-claude": "claude",
					"claude-sdk": "claude",
					claude: "claude",
					opencode: "opencode",
					unknown: null,
				});
				yield* client.SetDefault({ instanceId: "personal" });
				const changed = yield* Queue.take(revisions);
				expect(changed).toBeGreaterThan(revision);
				revision = changed;
				expect(yield* readAccounts).toEqual({
					"deleted-claude": "personal",
					"claude-sdk": "personal",
					claude: "claude",
					opencode: "opencode",
					unknown: null,
				});
				yield* client.UpdateInstance({
					instanceId: "personal",
					name: "Personal login",
				});
				expect(yield* Queue.take(revisions)).toBeGreaterThan(revision);
			}).pipe(Effect.provide(fixture([project])), Effect.timeout("10 seconds"));
		},
	);

	it.scoped(
		"keeps legacy history visible without a built-in account and after adding the first account",
		() => {
			const project = sessionFixture();
			return Effect.gen(function* () {
				const client = yield* makeClient;
				const revisions = yield* Queue.unbounded<number>();
				yield* Stream.runForEach(client.SubscribeServerStatus({}), (status) =>
					Queue.offer(revisions, status.sessionsRevision),
				).pipe(Effect.forkScoped);
				const initialRevision = yield* Queue.take(revisions);
				const initial = yield* client.ListDaemonSessions({
					projectSlug: project.slug,
				});
				expect(initial.sessions).toHaveLength(5);
				for (const session of initial.sessions)
					expect(session.accountId).toBe(
						session.id === "opencode" ? "opencode" : null,
					);
				const added = yield* client.AddInstance({
					name: "Personal",
					driver: "claude",
					configDir: join(root, "personal"),
				});
				expect(yield* Queue.take(revisions)).toBeGreaterThan(initialRevision);
				const refreshed = yield* client.ListDaemonSessions({
					projectSlug: project.slug,
				});
				const accounts = Object.fromEntries(
					refreshed.sessions.map((session) => [session.id, session.accountId]),
				);
				accountObservations.push(accounts);
				expect(accounts).toEqual({
					"deleted-claude": added.addedInstanceId,
					"claude-sdk": added.addedInstanceId,
					claude: added.addedInstanceId,
					opencode: "opencode",
					unknown: null,
				});
			}).pipe(
				Effect.provide(fixture([project], "none")),
				Effect.timeout("10 seconds"),
			);
		},
	);

	it.scoped("follows a new default when no live claude id remains", () => {
		const project = sessionFixture();
		return Effect.gen(function* () {
			const client = yield* makeClient;
			const before = yield* client.ListDaemonSessions({
				projectSlug: project.slug,
			});
			for (const session of before.sessions.filter(
				(session) => session.id !== "opencode" && session.id !== "unknown",
			))
				expect(session.accountId).toBe("personal");
			const added = yield* client.AddInstance({
				name: "Work",
				driver: "claude",
				configDir: join(root, "work"),
			});
			if (!added.addedInstanceId) throw new Error("Missing added account id");
			yield* client.SetDefault({ instanceId: added.addedInstanceId });
			const after = yield* client.ListDaemonSessions({
				projectSlug: project.slug,
			});
			const accounts = Object.fromEntries(
				after.sessions.map((session) => [session.id, session.accountId]),
			);
			accountObservations.push(accounts);
			expect(accounts).toEqual({
				"deleted-claude": added.addedInstanceId,
				"claude-sdk": added.addedInstanceId,
				claude: added.addedInstanceId,
				opencode: "opencode",
				unknown: null,
			});
		}).pipe(
			Effect.provide(fixture([project], "noOriginal")),
			Effect.timeout("10 seconds"),
		);
	});

	it.scoped(
		"persists the pointer and refreshes two clients and session subscribers",
		() =>
			Effect.gen(function* () {
				const first = yield* makeClient;
				const second = yield* makeClient;
				const lists = [
					yield* Queue.unbounded<
						readonly {
							readonly id: string;
							readonly isDefault?: boolean | undefined;
						}[]
					>(),
					yield* Queue.unbounded<
						readonly {
							readonly id: string;
							readonly isDefault?: boolean | undefined;
						}[]
					>(),
				];
				for (const [client, list] of [
					[first, lists[0]],
					[second, lists[1]],
				] as const) {
					if (!list) throw new Error("Missing client queue");
					yield* Stream.runForEach(client.SubscribeInstances({}), (snapshot) =>
						Queue.offer(list, snapshot.instances),
					).pipe(Effect.forkScoped);
					expect(
						(yield* Queue.take(list))
							.filter((item) => item.isDefault)
							.map((item) => item.id),
					).toEqual(["claude", "opencode"]);
				}
				const statuses = yield* Queue.unbounded<void>();
				yield* Stream.runForEach(second.SubscribeServerStatus({}), () =>
					Queue.offer(statuses, undefined),
				).pipe(Effect.forkScoped);
				yield* Queue.take(statuses);
				const reply = yield* first.SetDefault({ instanceId: "personal" });
				expect(
					reply.instances
						.filter((item) => item.driver === "claude" && item.isDefault)
						.map((item) => item.id),
				).toEqual(["personal"]);
				for (const list of lists) {
					if (!list) throw new Error("Missing client queue");
					expect(
						(yield* Queue.take(list))
							.filter((item) => item.isDefault)
							.map((item) => item.id),
					).toEqual(["personal", "opencode"]);
				}
				yield* Queue.take(statuses);
				const stored = Either.getOrThrowWith(
					loadDaemonConfigResult(root),
					(error) => error,
				);
				expect(stored?.accountDefaults?.claude).toBe("personal");
			}).pipe(Effect.provide(fixture()), Effect.timeout("10 seconds")),
	);

	it.scoped(
		"rejects unknown and OpenCode defaults without moving the pointer",
		() =>
			Effect.gen(function* () {
				const client = yield* makeClient;
				for (const instanceId of ["missing", "opencode"]) {
					const result = yield* Effect.either(
						client.SetDefault({ instanceId }),
					);
					expect(Either.isLeft(result)).toBe(true);
					if (Either.isLeft(result))
						expect(result.left).toBeInstanceOf(AccountChangeRejected);
				}
				const initial = yield* Stream.runHead(client.SubscribeInstances({}));
				expect(
					initial._tag === "Some" &&
						initial.value.instances.find((item) => item.id === "claude")
							?.isDefault,
				).toBe(true);
			}).pipe(Effect.provide(fixture())),
	);
});
