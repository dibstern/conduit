// Failure modes: reads counted as writes; lifecycle events counted repeatedly;
// stale inputs or the wrong turn folder used; ambiguous cd targets guessed;
// short trailing runs replacing hints; trailing home writes ignored; unrelated
// repositories counted; aliases split one worktree; deleted paths lost;
// committed dismissals undone by interruption; failed commits lose dismissals.
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { SqlError } from "@effect/sql/SqlError";
import { Deferred, Effect, Fiber, Layer, Logger, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionWorkspaceLive } from "../../../src/lib/domain/relay/Layers/session-workspace-layer.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { SessionWorkspaceTag } from "../../../src/lib/domain/relay/Services/session-workspace.js";
import {
	dismissWorkspaceHint,
	SessionWorkspaceHintReactorLive,
} from "../../../src/lib/domain/relay/Services/session-workspace-hint.js";
import {
	SessionWorkspaceHintStateLive,
	type SessionWorkspaceHintStateTag,
} from "../../../src/lib/domain/relay/Services/session-workspace-hint-state.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import {
	ReadQueryEffectTag,
	sessionRowsToSessionInfoList,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalToolInput,
	canonicalEvent,
	type EventPayloadMap,
	type LiveEventType,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";
import {
	collectWorkspaceHintPaths,
	resolveWorkspaceHint,
} from "../../../src/lib/session/workspace-hint.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

const stored = <K extends LiveEventType>(
	type: K,
	data: EventPayloadMap[K],
	sequence: number,
): StoredEvent => ({
	...canonicalEvent(type, "s1", data, {
		provider: "claude",
		createdAt: sequence,
	}),
	projectId: "test-project",
	sequence,
	streamVersion: sequence,
});

const tools = (
	inputs: readonly CanonicalToolInput[],
	offset = 0,
): StoredEvent[] =>
	inputs.map((input, index) =>
		stored(
			"tool.started",
			{
				messageId: "m1",
				partId: `p${offset + index}`,
				callId: `c${offset + index}`,
				toolName: "provider-specific-name",
				input,
			},
			offset + index + 1,
		),
	);

const hintCandidates = (paths: readonly string[], recordedWorkspace: string) =>
	paths.map((path) => ({ path, recordedWorkspace }));

describe("workspace hint write collection", () => {
	it("read-only canonical inputs must never count as writes", () => {
		const inputs: CanonicalToolInput[] = [
			{ tool: "Read", filePath: "/other/file.ts" },
			{ tool: "Grep", pattern: "TODO", path: "/other" },
			{ tool: "Glob", pattern: "*.ts", path: "/other" },
			{ tool: "LSP", operation: "goToDefinition", filePath: "/other/file.ts" },
			{ tool: "WebFetch", url: "https://example.test" },
			{ tool: "WebSearch", query: "file" },
			{ tool: "Unknown", name: "list", raw: { path: "/other" } },
		];
		expect(collectWorkspaceHintPaths(tools(inputs), "/recorded")).toEqual([]);
	});

	it("edit, write and patch paths must resolve against the recorded turn folder", () => {
		expect(
			collectWorkspaceHintPaths(
				tools([
					{
						tool: "Edit",
						filePath: "../other/edit.ts",
						oldString: "a",
						newString: "b",
					},
					{ tool: "Write", filePath: "write.ts", content: "b" },
					{
						tool: "Patch",
						patch: "*** Begin Patch\n*** End Patch",
						filePaths: ["patch.ts", "../other/patch.ts"],
					},
				]),
				"/recorded",
			),
		).toEqual(
			hintCandidates(
				[
					"/other/edit.ts",
					"/recorded/write.ts",
					"/recorded/patch.ts",
					"/other/patch.ts",
				],
				"/recorded",
			),
		);
	});

	it("tool lifecycle duplicates must not become several write candidates", () => {
		const input: CanonicalToolInput = {
			tool: "Write",
			filePath: "file.ts",
			content: "b",
		};
		expect(
			collectWorkspaceHintPaths(
				[
					...tools([input]),
					stored("tool.running", { messageId: "m1", partId: "p0", input }, 2),
					stored(
						"tool.completed",
						{ messageId: "m1", partId: "p0", result: "ok", duration: 1, input },
						3,
					),
				],
				"/recorded",
			),
		).toEqual(hintCandidates(["/recorded/file.ts"], "/recorded"));
	});

	it("the latest normalized input must replace streamed partial and earlier inputs", () => {
		const final: CanonicalToolInput = {
			tool: "Write",
			filePath: "final.ts",
			content: "b",
		};
		expect(
			collectWorkspaceHintPaths(
				[
					...tools([{ tool: "Unknown", name: "write", raw: {} }]),
					stored(
						"tool.running",
						{
							messageId: "m1",
							partId: "p0",
							input: { ...final, filePath: "partial.ts" },
						},
						2,
					),
					stored(
						"tool.completed",
						{
							messageId: "m1",
							partId: "p0",
							result: "ok",
							duration: 1,
							input: final,
						},
						3,
					),
				],
				"/recorded",
			),
		).toEqual(hintCandidates(["/recorded/final.ts"], "/recorded"));
	});

	it("reused part ids in different messages must remain different writes", () => {
		const inputs = tools([
			{ tool: "Write", filePath: "first.ts", content: "b" },
		]);
		inputs.push(
			stored(
				"tool.started",
				{
					messageId: "m2",
					partId: "p0",
					callId: "c2",
					toolName: "write",
					input: { tool: "Write", filePath: "second.ts", content: "b" },
				},
				2,
			),
		);
		expect(collectWorkspaceHintPaths(inputs, "/recorded")).toEqual(
			hintCandidates(
				["/recorded/first.ts", "/recorded/second.ts"],
				"/recorded",
			),
		);
	});

	it.each([
		"cd ../other",
		"cd ../other && printf ok",
		"cd ../other; printf ok",
	])("a plain leading cd must be collected: %s", (command) =>
		expect(
			collectWorkspaceHintPaths(
				tools([{ tool: "Bash", command }]),
				"/recorded",
			),
		).toEqual(hintCandidates(["/other"], "/recorded")));

	it.each([
		"printf ok && cd ../other",
		"cd $DEST",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Shell variable syntax is deliberately ambiguous.
		"cd ${DEST}",
		"cd ~other/worktree",
		"cd $(pwd)",
		"cd `pwd`",
		"(cd ../other)",
		"cd -",
		"cd ../worktree-*",
		"cd ../other || printf ok",
		"cd ../other | cat",
		"cd ../other > log",
		"cd ../other & printf ok",
		"cd ../other extra",
		"cd -- ../other",
		"cd ../other\nprintf ok",
	])("an ambiguous cd must never be guessed: %s", (command) => {
		expect(
			collectWorkspaceHintPaths(
				tools([{ tool: "Bash", command }]),
				"/recorded",
			),
		).toEqual([]);
	});

	it("an explicit bash working directory must be a candidate even without cd", () => {
		expect(
			collectWorkspaceHintPaths(
				tools([
					{ tool: "Bash", command: "printf ok", workingDirectory: "../other" },
				]),
				"/recorded",
			),
		).toEqual(hintCandidates(["/other"], "/recorded"));
	});

	it.each([
		"agent",
		"user",
	] as const)("a %s move must apply relative paths only when it takes effect during this turn", (cause) => {
		const events = [
			...tools([{ tool: "Write", filePath: "before.ts", content: "b" }]),
			stored(
				"session.workspace_changed",
				{
					sessionId: "s1",
					path: "/other",
					cause,
					worktrees: { "/recorded": "/other" },
					origin: "existing",
				},
				2,
			),
			stored(
				"tool.started",
				{
					messageId: "m1",
					partId: "p1",
					callId: "c1",
					toolName: "write",
					input: { tool: "Write", filePath: "after.ts", content: "b" },
				},
				3,
			),
		];
		expect(collectWorkspaceHintPaths(events, "/recorded")).toEqual([
			{ path: "/recorded/before.ts", recordedWorkspace: "/recorded" },
			{
				path: `${cause === "agent" ? "/other" : "/recorded"}/after.ts`,
				recordedWorkspace: cause === "agent" ? "/other" : "/recorded",
			},
		]);
	});
});

describe("workspace hint resolution against real worktrees", () => {
	let folders: {
		root: string;
		main: string;
		b: string;
		c: string;
		nestedWorktreeB: string;
		aliasB: string;
		outside: string;
		nestedRepo: string;
		otherRepo: string;
	};
	let observe: (
		paths: readonly string[],
		recorded?: string,
	) => Promise<string | null | undefined>;
	let observeCandidates: (
		candidates: readonly { path: string; recordedWorkspace: string }[],
	) => Promise<string | null | undefined>;
	let runWorkspaceTest: <A, E>(
		test: Effect.Effect<
			A,
			E,
			| SessionWorkspaceTag
			| SessionWorkspaceHintStateTag
			| PersistenceEffectContext
			| ConfigTag
		>,
	) => Promise<A>;
	let dispose = async () => {};
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 16_000,
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
		});
	const initialize = (directory: string) => {
		mkdirSync(directory, { recursive: true });
		git(directory, "init", "--initial-branch=main");
		git(
			directory,
			"-c",
			"user.name=Hint Test",
			"-c",
			"user.email=hint@example.test",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			"Initial",
		);
	};
	const writes = (folder: string, count = 3) =>
		Array.from({ length: count }, (_, index) =>
			join(folder, `write-${index}.ts`),
		);

	beforeAll(async () => {
		const root = realpathSync(
			mkdtempSync(
				join(
					process.platform === "darwin" ? "/tmp" : tmpdir(),
					"conduit-workspace-hint-",
				),
			),
		);
		folders = {
			root,
			main: join(root, "main"),
			b: join(root, "worktree-b"),
			c: join(root, "worktree-c"),
			nestedWorktreeB: join(root, "main", ".claude", "worktrees", "B"),
			aliasB: join(root, "alias-b"),
			outside: join(root, "outside"),
			nestedRepo: join(root, "main", "nested-repo"),
			otherRepo: join(root, "other-repo"),
		};
		initialize(folders.main);
		git(folders.main, "worktree", "add", "-b", "branch-b", folders.b);
		git(folders.main, "worktree", "add", "-b", "branch-c", folders.c);
		git(
			folders.main,
			"worktree",
			"add",
			"-b",
			"nested-branch-b",
			folders.nestedWorktreeB,
		);
		symlinkSync(folders.b, folders.aliasB, "dir");
		mkdirSync(folders.outside);
		initialize(folders.nestedRepo);
		initialize(folders.otherRepo);
		const dependencies = Layer.mergeAll(
			Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
			makePersistenceEffectLayer(join(root, "events.db"), "test-project").pipe(
				Layer.provideMerge(SessionWorkspaceHintStateLive),
			),
			Layer.succeed(
				ConfigTag,
				makeMockConfig({
					projectDir: folders.main,
					configDir: join(root, "config"),
				}),
			),
			Layer.succeed(LoggerTag, makeMockLogger()),
			Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
		);
		const runtime = ManagedRuntime.make(
			SessionWorkspaceLive.pipe(Layer.provideMerge(dependencies)),
		);
		runWorkspaceTest = (test) => runtime.runPromise(test);
		dispose = () => runtime.dispose();
		await runtime.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "s1", {
						sessionId: "s1",
						title: "Hint",
						provider: "claude",
					}),
				]);
			}),
		);
		const resolver = await runtime.runPromise(
			Effect.map(SessionWorkspaceTag, (workspace) => workspace.resolve),
		);
		observeCandidates = (candidates) =>
			runtime.runPromise(resolveWorkspaceHint("s1", candidates, resolver));
		observe = (paths, recorded = folders.main) =>
			observeCandidates(hintCandidates(paths, recorded));
	});

	afterAll(async () => {
		await dispose();
		if (folders) rmSync(folders.root, { recursive: true, force: true });
	});

	it("a short trailing run gives no opinion", async () => {
		expect(
			await observe([...writes(folders.b), ...writes(folders.c, 1)]),
		).toBeUndefined();
	});

	it("three trailing writes produce a hint after writes in another worktree", async () => {
		expect(await observe([...writes(folders.c, 1), ...writes(folders.b)])).toBe(
			folders.b,
		);
	});

	it.each([
		0, 1, 2,
	])("fewer than three writes must not produce a hint: %s", async (count) => {
		expect(await observe(writes(folders.b, count))).toBeUndefined();
	});

	it("a trailing home write clears a hint", async () => {
		expect(
			await observe([...writes(folders.b), ...writes(folders.main, 1)]),
		).toBeNull();
	});

	it("three trailing writes produce a hint after creating a worktree from home", async () => {
		expect(
			await observe([...writes(folders.main, 1), ...writes(folders.b)]),
		).toBe(folders.b);
	});

	it("a write in an unrelated nested repository inside the recorded workspace must cancel a hint", async () => {
		expect(
			await observe([...writes(folders.b), ...writes(folders.nestedRepo, 1)]),
		).toBeNull();
	});

	it("a linked worktree nested under the recorded checkout must not be mistaken for a write in that checkout", async () => {
		expect(await observe(writes(folders.nestedWorktreeB))).toBe(
			folders.nestedWorktreeB,
		);
	});

	it("three main-checkout writes after an agent declaration of another workspace must hint the main checkout", async () => {
		const events = [
			stored(
				"session.workspace_changed",
				{
					sessionId: "s1",
					path: folders.b,
					cause: "agent",
					worktrees: { [folders.main]: folders.b },
					origin: "existing",
				},
				1,
			),
			...tools(
				writes(folders.main).map((filePath) => ({
					tool: "Write" as const,
					filePath,
					content: "b",
				})),
				1,
			),
		];
		const collected = collectWorkspaceHintPaths(events, folders.main);
		expect(collected).toEqual(hintCandidates(writes(folders.main), folders.b));
		expect(await observeCandidates(collected)).toBe(folders.main);
	});

	it("main-checkout writes before an agent declaration must not become an incorrect reverse hint", async () => {
		const events = [
			...tools(
				writes(folders.main).map((filePath) => ({
					tool: "Write" as const,
					filePath,
					content: "b",
				})),
			),
			stored(
				"session.workspace_changed",
				{
					sessionId: "s1",
					path: folders.b,
					cause: "agent",
					worktrees: { [folders.main]: folders.b },
					origin: "existing",
				},
				4,
			),
		];
		const collected = collectWorkspaceHintPaths(events, folders.main);
		expect(collected).toEqual(
			hintCandidates(writes(folders.main), folders.main),
		);
		expect(await observeCandidates(collected)).toBeNull();
	});

	it("home and away writes at the same path form one run across an agent declaration", async () => {
		const before = join(folders.main, "before.ts");
		const events = [
			...tools([{ tool: "Write", filePath: before, content: "b" }]),
			stored(
				"session.workspace_changed",
				{
					sessionId: "s1",
					path: folders.b,
					cause: "agent",
					worktrees: { [folders.main]: folders.b },
					origin: "existing",
				},
				2,
			),
			...tools(
				writes(folders.main).map((filePath) => ({
					tool: "Write" as const,
					filePath,
					content: "b",
				})),
				2,
			),
		];
		const collected = collectWorkspaceHintPaths(events, folders.main);
		expect(collected).toEqual([
			...hintCandidates([before], folders.main),
			...hintCandidates(writes(folders.main), folders.b),
		]);
		expect(await observeCandidates(collected)).toBe(folders.main);
	});

	it("paths outside the project's repository must neither count nor cancel a hint", async () => {
		expect(
			await observe([
				...writes(folders.b),
				...writes(folders.outside, 1),
				...writes(folders.otherRepo, 1),
			]),
		).toBe(folders.b);
		expect(
			await observe([...writes(folders.b, 2), ...writes(folders.otherRepo)]),
		).toBeUndefined();
	});

	it("relative paths must use the recorded workspace instead of the process cwd", async () => {
		const paths = collectWorkspaceHintPaths(
			tools(
				[0, 1, 2].map((index) => ({
					tool: "Write" as const,
					filePath: `../worktree-b/write-${index}.ts`,
					content: "b",
				})),
			),
			folders.main,
		);
		expect(paths).toEqual(hintCandidates(writes(folders.b), folders.main));
		expect(await observeCandidates(paths)).toBe(folders.b);
	});

	it("symlink aliases must resolve as one worktree", async () => {
		expect(
			await observe([
				join(folders.b, "one.ts"),
				join(folders.aliasB, "two.ts"),
				join(folders.b, "three.ts"),
			]),
		).toBe(folders.b);
	});

	it.skipIf(process.platform !== "darwin")(
		"/tmp and /private/tmp aliases must resolve as one worktree",
		async () => {
			const alias = folders.b.replace(/^\/private\/tmp\//, "/tmp/");
			expect(alias).not.toBe(folders.b);
			expect(
				await observe([
					join(folders.b, "one.ts"),
					join(alias, "two.ts"),
					join(folders.aliasB, "three.ts"),
				]),
			).toBe(folders.b);
		},
	);

	it("a deleted file must still resolve through its nearest existing ancestor", async () => {
		const deleted = join(folders.b, "deleted.ts");
		writeFileSync(deleted, "gone");
		rmSync(deleted);
		expect(await observe([...writes(folders.b, 2), deleted])).toBe(folders.b);
	});

	it("three lifecycle events for one write must never reach the threshold", async () => {
		const input: CanonicalToolInput = {
			tool: "Write",
			filePath: join(folders.b, "one.ts"),
			content: "b",
		};
		const paths = collectWorkspaceHintPaths(
			[
				...tools([input]),
				stored("tool.running", { messageId: "m1", partId: "p0", input }, 2),
				stored(
					"tool.completed",
					{ messageId: "m1", partId: "p0", result: "ok", duration: 1, input },
					3,
				),
			],
			folders.main,
		);
		expect(await observeCandidates(paths)).toBeUndefined();
	});

	it("three writes back to the main checkout must produce the reverse hint", async () => {
		expect(await observe(writes(folders.main), folders.b)).toBe(folders.main);
	});

	it("a dismissed generation must not hide a later hint for the same folder", async () => {
		await runWorkspaceTest(
			Effect.gen(function* () {
				const sessionId = "s-hint-generation";
				const commit = yield* makeCommitAndSignal;
				const read = yield* ReadQueryEffectTag;
				yield* commit([
					canonicalEvent("session.created", sessionId, {
						sessionId,
						title: "Hint generation",
						provider: "claude",
					}),
					canonicalEvent("session.workspace_hint_changed", sessionId, {
						path: folders.b,
					}),
				]);
				const first = yield* read.getSession(sessionId);
				expect(first?.workspace_hint_sequence).toEqual(expect.any(Number));
				const hintDismissals = new Map([
					[sessionId, first?.workspace_hint_sequence ?? -1],
				]);
				expect(
					sessionRowsToSessionInfoList(first ? [first] : [], {
						hintDismissals,
					})[0]?.workspaceHint,
				).toBeUndefined();
				yield* commit([
					canonicalEvent("session.workspace_hint_changed", sessionId, {
						path: null,
					}),
					canonicalEvent("session.workspace_hint_changed", sessionId, {
						path: folders.b,
					}),
				]);
				const returned = yield* read.getSession(sessionId);
				expect(returned?.workspace_hint_sequence).toBeGreaterThan(
					first?.workspace_hint_sequence ?? -1,
				);
				expect(
					sessionRowsToSessionInfoList(returned ? [returned] : [], {
						hintDismissals,
					})[0]?.workspaceHint,
				).toBe(folders.b);
				expect(hintDismissals.get(sessionId)).toBe(
					first?.workspace_hint_sequence,
				);
			}),
		);
	});

	it("interrupting a dismissal after its commit must not restore the visible hint", async () => {
		await runWorkspaceTest(
			Effect.scoped(
				Effect.gen(function* () {
					const sessionId = "s-dismiss-interrupt";
					const commit = yield* makeCommitAndSignal;
					const read = yield* ReadQueryEffectTag;
					const bus = yield* SessionEventBusTag;
					yield* commit([
						canonicalEvent("session.created", sessionId, {
							sessionId,
							title: "Interrupted dismissal",
							provider: "claude",
						}),
						canonicalEvent("session.workspace_hint_changed", sessionId, {
							path: folders.b,
						}),
					]);
					const publishing = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					const dismissal = yield* dismissWorkspaceHint(
						sessionId,
						folders.b,
					).pipe(
						Effect.provideService(SessionEventBusTag, {
							...bus,
							publishAdvance: (advance) =>
								Effect.gen(function* () {
									yield* Deferred.succeed(publishing, undefined);
									yield* Deferred.await(release);
									yield* bus.publishAdvance(advance);
								}),
						}),
						Effect.forkScoped,
					);
					yield* Deferred.await(publishing);
					// The SQL commit has succeeded, but its row notification is held.
					yield* Fiber.interruptFork(dismissal);
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.await(dismissal);
					expect(yield* read.getSession(sessionId)).toMatchObject({
						workspace_hint: folders.b,
					});
					const shellRow = (yield* read.listSessionInfos({
						projectIds: ["test-project"],
					})).find((row) => row.id === sessionId);
					expect(shellRow).toBeDefined();
					expect(shellRow?.workspaceHint).toBeUndefined();
					const familyRow = (yield* read.readSessionList({
						projectIds: ["test-project"],
					})).rows.find((row) => row.item.id === sessionId);
					expect(familyRow).toBeDefined();
					expect(familyRow?.item.workspaceHint).toBeUndefined();
				}),
			).pipe(Effect.provide(SessionEventBusLive)),
		);
	});

	it("a failed hint COMMIT must roll back the event and preserve the previous dismissal", async () => {
		await runWorkspaceTest(
			Effect.scoped(
				Effect.gen(function* () {
					const sessionId = "s-hint-commit-rollback";
					const messageId = "m-hint-commit-rollback";
					const commit = yield* makeCommitAndSignal;
					const read = yield* ReadQueryEffectTag;
					const sql = yield* SqlClient.SqlClient;
					yield* commit([
						canonicalEvent("session.created", sessionId, {
							sessionId,
							title: "Rolled-back hint",
							provider: "claude",
						}),
						canonicalEvent("session.workspace_hint_changed", sessionId, {
							path: folders.b,
						}),
					]);
					yield* dismissWorkspaceHint(sessionId, folders.b);
					expect(
						(yield* read.listSessionInfos({
							projectIds: ["test-project"],
						})).find((row) => row.id === sessionId)?.workspaceHint,
					).toBeUndefined();
					yield* sql`CREATE TABLE hint_guard_parent (id INTEGER PRIMARY KEY)`;
					yield* sql`CREATE TABLE hint_guard_child (
						parent_id INTEGER,
						FOREIGN KEY (parent_id) REFERENCES hint_guard_parent(id)
						DEFERRABLE INITIALLY DEFERRED
					)`;
					yield* sql`CREATE TRIGGER fail_workspace_hint_commit
						AFTER UPDATE OF workspace_hint ON sessions
						WHEN NEW.id = 's-hint-commit-rollback'
							AND OLD.workspace_hint IS NOT NEW.workspace_hint
						BEGIN INSERT INTO hint_guard_child (parent_id) VALUES (-1); END`;
					const failed = yield* Deferred.make<void>();
					const realTransaction = sql.withTransaction;
					const withTransaction: typeof realTransaction = (body) => {
						let bodyCompleted = false;
						return realTransaction(
							body.pipe(
								Effect.tap(() =>
									Effect.sync(() => {
										bodyCompleted = true;
									}),
								),
							),
						).pipe(
							Effect.catchAllDefect((defect) => {
								if (!(defect instanceof SqlError)) return Effect.die(defect);
								expect(bodyCompleted).toBe(true);
								// Effect SQL makes COMMIT errors defects and leaves SQLite's
								// transaction open. Close it and surface the real error to the
								// reactor's normal error path without changing client identity.
								return sql`ROLLBACK`.pipe(Effect.zipRight(Effect.fail(defect)));
							}),
						);
					};
					Object.assign(sql, { withTransaction });
					yield* Effect.gen(function* () {
						yield* Layer.build(SessionWorkspaceHintReactorLive);
						yield* commit([
							canonicalEvent("message.created", sessionId, {
								messageId,
								sessionId,
								role: "assistant",
							}),
							...writes(folders.c).map((filePath, index) =>
								canonicalEvent(
									"tool.started",
									sessionId,
									{
										messageId,
										partId: `rollback-part-${index}`,
										callId: `rollback-call-${index}`,
										toolName: "provider-specific-write",
										input: { tool: "Write", filePath, content: "c" },
									},
									{ provider: "claude" },
								),
							),
							canonicalEvent(
								"turn.completed",
								sessionId,
								{ messageId },
								{
									provider: "claude",
								},
							),
						]);
						yield* Deferred.await(failed);
						expect(yield* read.getSession(sessionId)).toMatchObject({
							workspace_hint: folders.b,
						});
						expect(
							yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM events
								WHERE session_id = ${sessionId}
								AND type = 'session.workspace_hint_changed'`,
						).toEqual([{ count: 1 }]);
						expect(
							yield* sql<{ count: number }>`
								SELECT COUNT(*) AS count FROM hint_guard_child`,
						).toEqual([{ count: 0 }]);
						const shellRow = (yield* read.listSessionInfos({
							projectIds: ["test-project"],
						})).find((row) => row.id === sessionId);
						expect(shellRow).toBeDefined();
						expect(shellRow?.workspaceHint).toBeUndefined();
						const familyRow = (yield* read.readSessionList({
							projectIds: ["test-project"],
						})).rows.find((row) => row.item.id === sessionId);
						expect(familyRow).toBeDefined();
						expect(familyRow?.item.workspaceHint).toBeUndefined();
					}).pipe(
						Effect.provide(
							Logger.replace(
								Logger.defaultLogger,
								Logger.make(({ message }) => {
									if (
										String(message).startsWith(
											"Could not observe workspace hint",
										)
									)
										Deferred.unsafeDone(failed, Effect.void);
								}),
							),
						),
						Effect.ensuring(
							Effect.sync(() =>
								Object.assign(sql, { withTransaction: realTransaction }),
							),
						),
					);
				}),
			).pipe(Effect.provide(SessionEventBusLive)),
		);
	});

	it("an OpenCode user move must accept only the stored hint without enabling worktree launches", async () => {
		await runWorkspaceTest(
			Effect.gen(function* () {
				const workspace = yield* SessionWorkspaceTag;
				const commit = yield* makeCommitAndSignal;
				const read = yield* ReadQueryEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* commit([
					canonicalEvent("session.created", "s-opencode", {
						sessionId: "s-opencode",
						title: "OpenCode hint",
						provider: "opencode",
					}),
				]);
				expect(
					yield* workspace
						.move("s-opencode", folders.b, "user")
						.pipe(Effect.either),
				).toMatchObject({
					_tag: "Left",
					left: { reason: "unsupported-provider" },
				});
				yield* commit([
					canonicalEvent("session.workspace_hint_changed", "s-opencode", {
						path: folders.b,
					}),
				]);
				expect(
					yield* workspace
						.move("s-opencode", folders.c, "user")
						.pipe(Effect.either),
				).toMatchObject({
					_tag: "Left",
					left: { reason: "unsupported-provider" },
				});
				expect(
					yield* workspace
						.resolve("s-opencode", folders.b, "launch")
						.pipe(Effect.either),
				).toMatchObject({
					_tag: "Left",
					left: { reason: "unsupported-provider" },
				});
				expect(yield* workspace.move("s-opencode", folders.b, "user")).toBe(
					folders.b,
				);
				expect(yield* read.getSession("s-opencode")).toMatchObject({
					workspace_hint: null,
				});
				expect(
					yield* sql<{ cause: string }>`
				SELECT json_extract(data, '$.cause') AS cause FROM events
				WHERE session_id = 's-opencode' AND type = 'session.workspace_changed'`,
				).toEqual([{ cause: "user" }]);
			}),
		);
	});
});
