import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, "src");

// The session command seam. Every direct provider session mutation lives here:
// the upstream sync adapter, which is reached only after the canonical event
// has been appended and projected, and the create call, which is id-generating
// and so cannot be expressed as a command on its own.
const SESSION_COMMAND_SEAM = "src/lib/domain/relay/Services/session-command.ts";

function productionSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...productionSourceFiles(path));
		} else if (path.endsWith(".ts") || path.endsWith(".svelte")) {
			files.push(path);
		}
	}
	return files;
}

describe("session mutation boundary grep", () => {
	it("confines direct provider session mutations to the command seam", () => {
		const outsideTheSeam = productionSourceFiles(SRC_ROOT)
			.map((file) => ({ file, path: relative(REPO_ROOT, file) }))
			.filter(({ path }) => path !== SESSION_COMMAND_SEAM)
			.flatMap(({ file, path }) =>
				readFileSync(file, "utf8")
					.split("\n")
					.flatMap((line, index) =>
						/api\.session\.(?:create|update|delete)\s*\(/.test(line)
							? [{ path, line: index + 1, source: line.trim() }]
							: [],
					),
			);

		const parityRequirement = `A direct api.session mutation can update the provider without updating Conduit's durable state. listSessions reads the SQLite read model, so a mutation that skips the event store never reaches the UI — that is bug conduit-test-42k7, where deleted sessions reappeared in the sidebar.

Every session create, rename, or delete goes through applySessionCommand in ${SESSION_COMMAND_SEAM}, which appends the canonical event, projects it, and only then tells the provider. Route the mutation through the seam rather than adding an exception here.

See docs/adr/0004-session-mutations-are-canonical-events.md.`;

		expect(outsideTheSeam, parityRequirement).toEqual([]);
	});

	it("keeps the seam itself honest: the mutations are still there to confine", () => {
		// Without this, deleting the adapter would make the rule above pass
		// vacuously — a guard that cannot fail is not a guard.
		const seam = readFileSync(join(REPO_ROOT, SESSION_COMMAND_SEAM), "utf8");
		const mutations = seam.match(
			/api\.session\.(?:create|update|delete)\s*\(/g,
		);

		expect(mutations).toEqual([
			"api.session.delete(",
			"api.session.update(",
			"api.session.create(",
		]);
	});
});
