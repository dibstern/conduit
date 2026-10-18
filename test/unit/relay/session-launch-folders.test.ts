import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { AlertsLive } from "../../../src/lib/domain/relay/Services/alerts.js";
import { resolveSessionFolders } from "../../../src/lib/domain/relay/Services/provider-turn-dispatch.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makeMockConfig } from "../../helpers/mock-factories.js";

// Failure modes: a non-git primary starts in a secondary worktree; unmapped
// folders lose their shared flag; existing user moves lose their cwd fallback.
it.each([
	"conduit",
	"existing",
] as const)("resolves a non-git primary and secondary worktree with origin %s", async (origin) => {
	const root = mkdtempSync(join(tmpdir(), "conduit-launch-folders-"));
	try {
		const primary = join(root, "scratch");
		const secondary = join(root, "api");
		const worktree = join(root, "api-worktree");
		const attached = join(root, "late");
		for (const directory of [primary, secondary, worktree, attached])
			mkdirSync(directory);
		// A present checkout has a worktree `.git` file; turns refuse missing ones.
		writeFileSync(join(worktree, ".git"), "gitdir: elsewhere\n");
		const result = await Effect.runPromise(
			resolveSessionFolders({
				id: "worktree",
				workspace: JSON.stringify({
					cause: "launch",
					origin,
					worktrees: { [secondary]: worktree },
				}),
			}).pipe(
				Effect.provideService(
					ConfigTag,
					makeMockConfig({
						projectDir: primary,
						extraFolders: [secondary, attached],
					}),
				),
				Effect.provideService(LoggerTag, createSilentLogger()),
				Effect.provide(AlertsLive, { local: true }),
			),
		);
		expect(result).toEqual({
			workspaceRoot: origin === "conduit" ? primary : worktree,
			extraFolders:
				origin === "conduit" ? [worktree, attached] : [primary, attached],
			effectiveFolders: [
				{
					root: primary,
					directory: primary,
					...(origin === "conduit" ? { shared: true } : {}),
				},
				{ root: secondary, directory: worktree },
				{
					root: attached,
					directory: attached,
					...(origin === "conduit" ? { shared: true } : {}),
				},
			],
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("preserves main's launch-folder order, paths and duplicates for an unmoved session", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-launch-folders-"));
	try {
		const primary = join(root, "primary");
		const alias = join(root, "alias");
		const extra = join(root, "extra");
		mkdirSync(primary);
		mkdirSync(extra);
		symlinkSync(primary, alias);
		const result = await Effect.runPromise(
			resolveSessionFolders({ id: "unmoved", workspace: null }).pipe(
				Effect.provideService(
					ConfigTag,
					makeMockConfig({ projectDir: alias, extraFolders: [extra, alias] }),
				),
				Effect.provideService(LoggerTag, createSilentLogger()),
				Effect.provide(AlertsLive, { local: true }),
			),
		);
		expect(result).toEqual({
			workspaceRoot: alias,
			extraFolders: [extra, alias],
			effectiveFolders: [
				{ root: alias, directory: alias },
				{ root: extra, directory: extra },
				{ root: alias, directory: alias },
			],
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
