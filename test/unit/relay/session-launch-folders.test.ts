import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
				Effect.provide(AlertsLive),
			),
		);
		expect(result).toEqual({
			workspaceRoot: alias,
			extraFolders: [extra, alias],
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
