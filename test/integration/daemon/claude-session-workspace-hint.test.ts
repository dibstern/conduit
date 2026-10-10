import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionInfoSchema } from "../../../src/lib/shared-types.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const gitVariables = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
] as const;
const gitEnv = { ...process.env };
for (const key of gitVariables) delete gitEnv[key];

function git(directory: string, ...args: string[]) {
	return execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function shellRows(
	browser: Awaited<ReturnType<ProcessHarness["connect"]>>,
	sessionId: string,
	after = 0,
	feed: "shell" | "family" = "shell",
) {
	return browser.frames.slice(after).flatMap(({ message }) => {
		if (message["type"] !== feed) return [];
		const items =
			message["_tag"] === "snapshot"
				? (message["rows"] as readonly unknown[])
				: message["_tag"] === "upsert"
					? [message["item"]]
					: [];
		return items
			.map((item) => Schema.decodeUnknownSync(SessionInfoSchema)(item))
			.filter(({ id }) => id === sessionId);
	});
}

function storedEvents(fixture: ProcessHarness) {
	const db = new Database(fixture.projectStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT type, data FROM events WHERE type IN ('session.workspace_hint_changed', 'session.workspace_changed', 'tool.started', 'tool.running', 'tool.completed', 'turn.completed', 'turn.error', 'turn.interrupted') ORDER BY sequence",
			)
			.all()
			.map((row) => {
				const event = row as { type: string; data: string };
				return {
					type: event.type,
					data: JSON.parse(event.data) as Record<string, unknown>,
				};
			});
	} finally {
		db.close();
	}
}

function toolTurn(
	writes: readonly string[],
	options: {
		readonly reads?: readonly string[];
		readonly declareWorkspace?: string;
		readonly holdBeforeResult?: boolean;
		readonly failAfterTools?: boolean;
	} = {},
) {
	return `workspace-hint-tools ${JSON.stringify({ writes, ...options })}`;
}

function threePaths(directory: string) {
	return ["one.txt", "two.txt", "three.txt"].map((file) =>
		join(directory, file),
	);
}

describe("Workspace hints through the built daemon and shell subscription", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	let scenario = "setup";

	async function start(
		name: string,
		beforeRestart?: (
			fixture: ProcessHarness,
			paths: { first: string; second: string },
		) => void,
	) {
		for (const key of gitVariables) vi.stubEnv(key, undefined);
		scenario = name;
		evidence = {};
		harness = ProcessHarness.create();
		git(harness.projectDir, "init", "-b", "main");
		git(
			harness.projectDir,
			"-c",
			"user.name=Workspace hint test",
			"-c",
			"user.email=workspace-hint@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"-m",
			"Initial commit",
		);
		const first = join(harness.root, "hint-first");
		const second = join(harness.root, "hint-second");
		git(harness.projectDir, "worktree", "add", "-b", "hint-first", first);
		git(harness.projectDir, "worktree", "add", "-b", "hint-second", second);
		beforeRestart?.(harness, { first, second });
		await harness.restart();
		return {
			fixture: harness,
			main: realpathSync(harness.projectDir),
			first: realpathSync(first),
			second: realpathSync(second),
		};
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["events"] = existsSync(fixture.projectStorePath())
				? storedEvents(fixture)
				: [];
			evidence["errors"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
		} finally {
			writeFileSync(join(fixture.root, "workspace-hint-release"), "release\n");
			writeFileSync(join(fixture.root, "git-resolution-release"), "release\n");
			try {
				await fixture.dispose();
				expect(fixture.remainingRunnerPids()).toEqual([]);
			} finally {
				mkdirSync("test-results", { recursive: true });
				const ids = new Map<string, string>();
				const normalized = JSON.stringify(
					evidence,
					(key, value: unknown) => {
						if (/Id$/.test(key) && typeof value === "string") {
							if (!ids.has(value)) ids.set(value, `id-${ids.size + 1}`);
							return ids.get(value);
						}
						if (key === "head") return "<commit>";
						return value;
					},
					2,
				).replaceAll(fixture.root, "<root>");
				writeFileSync(
					`test-results/q5u6-1-8-${scenario}.json`,
					`${normalized}\n`,
				);
				harness = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	it("does not count reads or repeated lifecycle events as three writes", async () => {
		const { fixture, first } = await start("read-and-tool-count");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Read-only worktree exploration",
		);
		await browser.send(sessionId, toolTurn([], { reads: threePaths(first) }));
		expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBeUndefined();
		await browser.send(sessionId, toolTurn(threePaths(first).slice(0, 2)));
		expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBeUndefined();
		expect(
			storedEvents(fixture).filter(
				({ type }) => type === "session.workspace_hint_changed",
			),
		).toEqual([]);
	});

	it("clears stale dismissal on folder changes, accepts the existing user move, hints on the return trip, and keeps the hint after restart", async () => {
		const { fixture, main, first, second } = await start("lifecycle");
		const browser = await fixture.connect();
		const anotherTab = await fixture.connect();
		const sessionId = await browser.createSession("Undeclared worktree work");
		await anotherTab.view(sessionId);
		await browser.send(sessionId, toolTurn(threePaths(first)));
		await vi.waitFor(() => {
			for (const tab of [browser, anotherTab])
				for (const feed of ["shell", "family"] as const)
					expect(shellRows(tab, sessionId, 0, feed).at(-1)?.workspaceHint).toBe(
						first,
					);
		});
		expect(shellRows(browser, sessionId).at(-1)?.workspace ?? null).toBeNull();
		const dismissedAt = [browser.frames.length, anotherTab.frames.length];
		await Effect.runPromise(
			browser.rpc.DismissWorkspaceHint({
				projectSlug: "process-test",
				sessionId,
				path: first,
			}),
		);
		await vi.waitFor(() => {
			for (const [index, tab] of [browser, anotherTab].entries()) {
				for (const feed of ["shell", "family"] as const) {
					const rows = shellRows(tab, sessionId, dismissedAt[index], feed);
					expect(rows.length).toBeGreaterThan(0);
					expect(rows.at(-1)?.workspaceHint).toBeUndefined();
				}
			}
		});
		evidence["dismissedShellRows"] = [browser, anotherTab].map((tab, index) =>
			shellRows(tab, sessionId, dismissedAt[index]),
		);
		await browser.send(sessionId, toolTurn(threePaths(first)));
		expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBeUndefined();
		await browser.send(sessionId, toolTurn([], { reads: threePaths(first) }));
		expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBeUndefined();
		await vi.waitFor(() =>
			expect(
				storedEvents(fixture)
					.filter(({ type }) => type === "session.workspace_hint_changed")
					.at(-1)?.data["path"],
			).toBeNull(),
		);
		await browser.send(sessionId, toolTurn(threePaths(first)));
		await vi.waitFor(() =>
			expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBe(first),
		);
		await Effect.runPromise(
			browser.rpc.DismissWorkspaceHint({
				projectSlug: "process-test",
				sessionId,
				path: first,
			}),
		);
		await browser.send(sessionId, toolTurn(threePaths(second)));
		await vi.waitFor(() => {
			for (const tab of [browser, anotherTab])
				expect(shellRows(tab, sessionId).at(-1)?.workspaceHint).toBe(second);
		});
		const movedAt = browser.frames.length;
		await Effect.runPromise(
			browser.rpc.MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId,
				path: second,
			}),
		);
		await vi.waitFor(() => {
			const row = shellRows(browser, sessionId, movedAt).at(-1);
			expect(row?.workspaceHint).toBeUndefined();
			expect(row?.workspace).toMatchObject({
				cause: "user",
				worktrees: { [main]: second },
			});
		});
		await browser.send(sessionId, toolTurn(threePaths(main)));
		await vi.waitFor(() =>
			expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBe(main),
		);
		await fixture.kill();
		await fixture.restart();
		const restored = await fixture.connect(sessionId);
		expect(shellRows(restored, sessionId).at(-1)).toMatchObject({
			workspaceHint: main,
			workspace: { cause: "user", worktrees: { [main]: second } },
		});
		evidence["restoredShellRow"] = shellRows(restored, sessionId).at(-1);
		evidence["hintChanges"] = storedEvents(fixture)
			.filter(({ type }) => type === "session.workspace_hint_changed")
			.map(({ data }) => data["path"]);
		expect(evidence["hintChanges"]).toEqual([first, null, first, second, main]);
	});

	it("keeps a null-then-same-folder transition when the next turn finishes during slow hint resolution", async () => {
		const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], {
			env: gitEnv,
			encoding: "utf8",
		}).trim();
		const { fixture, main, first, second } = await start(
			"queued-turn-generations",
			(fixture, { second }) => {
				const bin = join(fixture.root, "git-bin");
				mkdirSync(bin);
				writeFileSync(
					join(bin, "git"),
					`#!/bin/sh
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR
if [ "$PWD" = '${second}' ] && [ "$*" = 'rev-parse --git-common-dir' ] && [ -f '${join(fixture.root, "git-resolution-arm")}' ]; then
  touch '${join(fixture.root, "git-resolution-started")}'
  while [ ! -f '${join(fixture.root, "git-resolution-release")}' ]; do sleep 0.01; done
fi
exec '${realGit}' "$@"
`,
					{ mode: 0o755 },
				);
				vi.stubEnv("PATH", `${bin}:${gitEnv["PATH"] ?? ""}`);
			},
		);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Queued hint generations");
		await browser.send(sessionId, toolTurn(threePaths(first)));
		await vi.waitFor(() =>
			expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBe(first),
		);
		const beforeDismiss = browser.frames.length;
		await Effect.runPromise(
			browser.rpc.DismissWorkspaceHint({
				projectSlug: "process-test",
				sessionId,
				path: first,
			}),
		);
		await vi.waitFor(() => {
			const rows = shellRows(browser, sessionId, beforeDismiss);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.at(-1)?.workspaceHint).toBeUndefined();
		});
		writeFileSync(join(fixture.root, "git-resolution-arm"), "arm\n");
		const clearingTurn = browser.send(
			sessionId,
			toolTurn([...threePaths(second), join(main, "cancel.txt")]),
		);
		void clearingTurn.catch(() => {});
		try {
			await vi.waitFor(
				() =>
					expect(existsSync(join(fixture.root, "git-resolution-started"))).toBe(
						true,
					),
				{ timeout: 15_000 },
			);
			await clearingTurn;
			await browser.send(sessionId, toolTurn(threePaths(first)));
			expect(existsSync(join(fixture.root, "git-resolution-release"))).toBe(
				false,
			);
			expect(
				storedEvents(fixture).filter(({ type }) => type === "turn.completed"),
			).toHaveLength(3);
			evidence["nextTurnCompletedDuringResolution"] = true;
		} finally {
			writeFileSync(join(fixture.root, "git-resolution-release"), "release\n");
		}
		await vi.waitFor(() =>
			expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBe(first),
		);
		expect(
			storedEvents(fixture)
				.filter(({ type }) => type === "session.workspace_hint_changed")
				.map(({ data }) => data["path"]),
		).toEqual([first, null, first]);
		evidence["completedShellRow"] = shellRows(browser, sessionId).at(-1);
	}, 60_000);

	it("resolves relative writes against the workspace recorded during the turn even when a user moves before completion", async () => {
		const { fixture, main, first, second } = await start("turn-workspace");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Turn workspace stays stable",
		);
		const sending = browser.send(
			sessionId,
			toolTurn(
				threePaths(first).map((path) => relative(main, path)),
				{
					holdBeforeResult: true,
				},
			),
		);
		void sending.catch(() => {});
		await vi.waitFor(
			() =>
				expect(
					storedEvents(fixture).filter(({ type }) => type === "tool.completed"),
				).toHaveLength(3),
			{ timeout: 15_000 },
		);
		expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBeUndefined();
		await Effect.runPromise(
			browser.rpc.MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId,
				path: second,
			}),
		);
		writeFileSync(join(fixture.root, "workspace-hint-release"), "release\n");
		await sending;
		await vi.waitFor(() =>
			expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBe(first),
		);
		evidence["completedShellRow"] = shellRows(browser, sessionId).at(-1);
	});

	it("observes writes back in main after an agent declares another workspace during the turn", async () => {
		const { fixture, main, first } = await start("agent-turn-workspace");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Agent declares before writing elsewhere",
		);
		const sending = browser.send(
			sessionId,
			toolTurn(
				threePaths(main).map((path) => relative(first, path)),
				{
					declareWorkspace: first,
					holdBeforeResult: true,
				},
			),
		);
		void sending.catch(() => {});
		await vi.waitFor(
			() => {
				expect(shellRows(browser, sessionId).at(-1)?.workspace).toMatchObject({
					cause: "agent",
					worktrees: { [main]: first },
				});
				expect(
					storedEvents(fixture).filter(({ type }) => type === "tool.completed"),
				).toHaveLength(4);
			},
			{ timeout: 15_000 },
		);
		expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBeUndefined();
		writeFileSync(join(fixture.root, "workspace-hint-release"), "release\n");
		await sending;
		await vi.waitFor(() =>
			expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBe(main),
		);
		evidence["completedShellRow"] = shellRows(browser, sessionId).at(-1);
	});

	it("still observes completed writes when the provider turn fails", async () => {
		const { fixture, first } = await start("turn-error");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Failed turn keeps workspace evidence",
		);
		await browser.send(
			sessionId,
			toolTurn(threePaths(first), { failAfterTools: true }),
		);
		await vi.waitFor(() =>
			expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBe(first),
		);
		expect(
			storedEvents(fixture).some(({ type }) => type === "turn.error"),
		).toBe(true);
	});

	it("still observes completed writes when the user interrupts the provider turn", async () => {
		const { fixture, first } = await start("turn-interrupted");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Interrupted turn keeps workspace evidence",
		);
		await browser.followFamily(sessionId);
		await Effect.runPromise(
			browser.rpc.input.submit({
				projectSlug: "process-test",
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: toolTurn(threePaths(first), { holdBeforeResult: true }),
			}),
		);
		await vi.waitFor(
			() =>
				expect(
					storedEvents(fixture).filter(({ type }) => type === "tool.completed"),
				).toHaveLength(3),
			{ timeout: 15_000 },
		);
		expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBeUndefined();
		await Effect.runPromise(
			browser.rpc.CancelSession({
				projectSlug: "process-test",
				sessionId,
				commandId: randomUUID(),
			}),
		);
		await vi.waitFor(() => {
			expect(shellRows(browser, sessionId).at(-1)?.workspaceHint).toBe(first);
			expect(
				storedEvents(fixture).filter(({ type }) => type === "turn.interrupted"),
			).toHaveLength(1);
		});
	});
});
