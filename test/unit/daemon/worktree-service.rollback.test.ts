import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	Cause,
	Effect,
	Option as Effect4PollOption,
	Result as Either,
	Exit,
	Fiber,
} from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	makeWorktreeLive,
	ownedWorktreePath,
} from "../../../src/lib/domain/daemon/Layers/worktree-layer.js";
import { WorktreeServiceTag } from "../../../src/lib/domain/daemon/Services/worktree-service.js";
import { worktreeFixture } from "./worktree-service-fixture.js";

describe("daemon Worktree service", () => {
	const context = worktreeFixture();
	const {
		repositoryState,
		secondGitFolder,
		createEffect,
		creationError,
		gitWrapper,
		runRealGit,
		waitForGitTimeout,
		assertUnchanged,
	} = context;

	it("rolls back both refs when the second Git rename writes then fails", async () => {
		const second = secondGitFolder();
		const created = await Effect.runPromise(
			createEffect("owned", undefined, [context.folder, second]),
		);
		const secondOwned = created.ownership.find(
			(owned) => owned.folder === second.path,
		);
		if (!secondOwned) throw new Error("Missing second ownership");
		const marker = join(context.fixture, "rename-failed");
		const executable = gitWrapper(`${runRealGit}
if (args.includes("branch") && args.includes("-m") && args.at(-1) === "renamed" && process.cwd() === ${JSON.stringify(secondOwned.path)} && result.status === 0) {
  writeFileSync(${JSON.stringify(marker)}, "failed after rename");
  process.stderr.write("forced second rename failure");
  process.exit(42);
}
process.exit(result.status ?? 1);`);
		const before = [repositoryState(), repositoryState(second.path)];
		const result = await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.renameBranch(created.ownership, "renamed"),
			).pipe(
				Effect.result,
				Effect.provide(
					makeWorktreeLive(context.configDir, { gitExecutable: executable }),
				),
			),
		);
		if (Either.isSuccess(result)) throw new Error("Expected rename to fail");
		expect(result.failure).toMatchObject({
			folder: second.path,
			reason: "git-failed",
		});
		expect(result.failure.message).toContain("forced second rename failure");
		expect(existsSync(marker)).toBe(true);
		expect([repositoryState(), repositoryState(second.path)]).toEqual(before);
	});

	it("rolls back the first repository when the second worktree fails after being added", async () => {
		const second = secondGitFolder();
		const before = [repositoryState(), repositoryState(second.path)];
		const firstAdded = join(context.fixture, "first-added");
		const executable = gitWrapper(
			`${runRealGit}
if (args.includes("worktree") && args.includes("add") && result.status === 0) {
  if (process.cwd() === ${JSON.stringify(context.repository)}) writeFileSync(${JSON.stringify(firstAdded)}, "added");
  if (process.cwd() === ${JSON.stringify(second.path)}) { console.error("forced second worktree failure"); process.exit(42); }
}
process.exit(result.status ?? 1);`,
		);
		const error = await creationError(
			"feature/together",
			{ gitExecutable: executable },
			[context.folder, second],
		);
		expect(error.path).toBe(second.path);
		expect(error.message).toContain("forced second worktree failure");
		expect(existsSync(firstAdded)).toBe(true);
		expect([repositoryState(), repositoryState(second.path)]).toEqual(before);
		for (const entry of [context.folder, second])
			expect(existsSync(ownedWorktreePath(context.configDir, entry))).toBe(
				false,
			);
	});

	it.each([
		"failure",
		"timeout",
	])("rolls back a ref written before git reports %s", async (mode) => {
		const before = repositoryState();
		const marker = join(context.fixture, "ref-written");
		const timeoutMarker = join(context.fixture, "ref-timeout-observed");
		const executable = gitWrapper(
			`${runRealGit}\nif (((args.includes("branch") && args.includes("--")) || args.includes("--create-reflog")) && result.status === 0) { writeFileSync(${JSON.stringify(marker)}, "written"); ${mode === "timeout" ? waitForGitTimeout(timeoutMarker) : 'console.error("forced post-ref failure"); process.exit(42);'} } else process.exit(result.status ?? 1);`,
		);
		const error = await creationError(undefined, {
			gitExecutable: executable,
			gitTimeoutMs: 5_000,
		});
		expect(error.reason).toBe("git-failed");
		expect(existsSync(marker)).toBe(true);
		if (mode === "failure")
			expect(error.message).toContain("forced post-ref failure");
		else expect(existsSync(timeoutMarker)).toBe(true);
		assertUnchanged(before);
	}, 30_000);

	it("rolls back a worktree add that succeeded before reporting failure", async () => {
		const before = repositoryState();
		const executable = gitWrapper(
			`${runRealGit}\nif (args.includes("worktree") && args.includes("add") && result.status === 0) { console.error("forced post-add failure"); process.exit(42); }\nprocess.exit(result.status ?? 1);`,
		);
		const error = await creationError(undefined, { gitExecutable: executable });
		expect(error.reason).toBe("git-failed");
		expect(error.message).toContain("forced post-add failure");
		assertUnchanged(before);
	});

	it("rolls back when a git worktree add times out after creating the checkout", async () => {
		const before = repositoryState();
		const marker = join(context.fixture, "added-before-timeout");
		const timeoutMarker = join(context.fixture, "add-timeout-observed");
		const executable = gitWrapper(
			`${runRealGit}\nif (args.includes("worktree") && args.includes("add") && result.status === 0) { writeFileSync(${JSON.stringify(marker)}, "added"); ${waitForGitTimeout(timeoutMarker)} } else process.exit(result.status ?? 1);`,
		);
		const error = await creationError(undefined, {
			gitExecutable: executable,
			gitTimeoutMs: 5_000,
		});
		expect(error.reason).toBe("git-failed");
		expect(existsSync(timeoutMarker)).toBe(true);
		expect(existsSync(marker)).toBe(true);
		assertUnchanged(before);
	}, 30_000);

	it.each([
		false,
		true,
	])("rolls back creation interrupted while git is finishing, delayed startup=%s", async (delayedStartup) => {
		const before = repositoryState();
		const marker = join(context.fixture, "added");
		const release = join(context.fixture, "release-git");
		const executable = gitWrapper(
			`${delayedStartup ? 'if (args.includes("--show-toplevel")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);' : ""}\n${runRealGit}\nif (args.includes("worktree") && args.includes("add") && result.status === 0) {
const { existsSync } = require("node:fs");
const finish = () => { if (existsSync(${JSON.stringify(release)})) { clearInterval(gate); process.exit(0); } };
const gate = setInterval(finish, 25);
writeFileSync(${JSON.stringify(marker)}, "added");
finish();
} else process.exit(result.status ?? 1);`,
		);
		const fiber = Effect.runFork(
			createEffect(undefined, { gitExecutable: executable }),
		);
		try {
			await vi.waitFor(() => expect(existsSync(marker)).toBe(true), {
				timeout: 8_000,
			});
			expect(
				(
					await Effect.runPromise(
						Effect.sync(() =>
							Effect4PollOption.fromUndefinedOr(fiber.pollUnsafe()),
						),
					)
				)._tag,
			).toBe("None");
		} finally {
			// Request interruption before allowing Git to return and transfer ownership.
			fiber.interruptUnsafe();
			writeFileSync(release, "release");
			const exit = await Effect.runPromise(Fiber.await(fiber));
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit))
				expect(Cause.hasInterrupts(exit.cause)).toBe(true);
		}
		assertUnchanged(before);
	}, 30_000);
});
