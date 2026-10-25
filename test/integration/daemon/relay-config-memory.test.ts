// Adding a project must retain shared daemon settings even if disk config breaks.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { ProjectManagementServiceTag } from "../../../src/lib/domain/relay/Services/project-management-service.js";
import { createRelayHarness } from "../helpers/relay-harness.js";

it("adds a project from shared memory after daemon.json is corrupted", async () => {
	const root = mkdtempSync(join(tmpdir(), "82tn18-shared-config-"));
	const configDir = join(root, "config");
	const projectDir = join(root, "added-project");
	mkdirSync(configDir);
	mkdirSync(projectDir);
	const fixture = await createRelayHarness("chat-simple", { configDir });
	try {
		writeFileSync(join(configDir, "daemon.json"), "{corrupted after startup");
		const result = await fixture.stack.effectRuntime.runtime.runPromise(
			Effect.flatMap(ProjectManagementServiceTag, (projects) =>
				projects.save({ folders: [projectDir] }),
			),
		);
		expect(result.project.folders).toEqual([projectDir]);
		expect(result.projects.map(({ slug }) => slug)).toContain(
			result.project.slug,
		);
		mkdirSync("test-results/82tn18-fix4", { recursive: true });
		writeFileSync(
			"test-results/82tn18-fix4/shared-context.json",
			JSON.stringify({
				bead: "conduit-test-82tn.18",
				corruptedConfigAfterStartup: true,
				addedProject: result.project,
			}),
		);
	} finally {
		await fixture.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
