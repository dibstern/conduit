import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
// Allowed disk boundaries and their loader call-site counts.
const diskLoaderSites = new Map([
	["src/lib/domain/daemon/Layers/daemon-foreground.ts", 1],
	// The writer validates the destination and retains legacy debug before replacing it.
	["src/lib/domain/daemon/Layers/config-persistence-layer.ts", 1],
	["src/lib/relay/project-relay-layers.ts", 1],
	["src/lib/domain/daemon/Services/account-directory.ts", 1],
	["src/bin/cli-doctor.ts", 1],
	// Service install/start runs without a daemon and injects the loader into its commands.
	["src/bin/cli-service.ts", 0],
	// Compatibility only: a new runner launched by an old daemon has no snapshot.
	// Once supplied, snapshots permanently disable this legacy disk sweep.
	["src/lib/provider/runner/runner-idle.ts", 1],
]);
const owner = "src/lib/daemon/config-persistence.ts";
const configPathOwners = new Set([
	// Legacy Effect config writer owns its injected file path.
	"src/lib/domain/daemon/Services/daemon-config-persistence.ts",
	"src/lib/env.ts",
	"src/lib/relay/project-relay-layers.ts",
	// Lists the configuration directory, not daemon configuration contents.
	"src/lib/domain/relay/Services/directory-listing-service.ts",
]);

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory()
			? sources(path)
			: /\.(?:ts|svelte)$/.test(entry.name)
				? [path]
				: [];
	});
}

function violationsIn(path: string, source: string): string[] {
	const violations: string[] = [];
	if (path === owner) return violations;
	const loader =
		/\b(?:loadDaemonConfig(?:Startup)?Result|loadAccountsState|AccountDirectoryFromConfigLive)\b/;
	if (loader.test(source) && !diskLoaderSites.has(path))
		violations.push(`${path}: imports or uses a disk config loader`);
	const calls =
		source.match(
			/\b(?:loadDaemonConfig(?:Startup)?Result|loadAccountsState)\s*\(/g,
		)?.length ?? 0;
	if (diskLoaderSites.has(path) && calls !== diskLoaderSites.get(path))
		violations.push(
			`${path}: expected ${diskLoaderSites.get(path)} allowed loader sites, found ${calls}`,
		);
	if (/["'`][^"'`\r\n]*daemon\.json[^"'`\r\n]*["'`]/.test(source))
		violations.push(
			`${path}: constructs a daemon.json path outside its disk owner`,
		);
	if (/\bDaemonConfigSchema\b/.test(source))
		violations.push(`${path}: decodes disk config outside its disk owner`);
	// This text guard fences known loaders, literals and sanctioned path accessors.
	// Arbitrary injected paths or deliberately assembled filenames can escape it;
	// process-harness fs instrumentation verifies actual runtime reads separately.
	if (
		/\b(?:PersistencePathTag|getConfigDir|resolveConfigDir)\b/.test(source) &&
		!configPathOwners.has(path)
	)
		violations.push(`${path}: obtains a config path outside its disk owner`);
	return violations;
}

describe("daemon config disk boundary", () => {
	it("confines disk loaders and config paths to explicit disk boundaries", () => {
		const violations: string[] = [];
		for (const file of sources(join(root, "src"))) {
			const path = relative(root, file);
			const source = readFileSync(file, "utf8");
			violations.push(...violationsIn(path, source));
		}
		expect(violations).toEqual([]);
	});

	it.each([
		'import { PersistencePathTag } from "../daemon-config-persistence.js"; const path = yield* PersistencePathTag; yield* fs.readFileString(path);',
		'import { getConfigDir as configRoot } from "../config-persistence.js"; readFileSync(resolve(configRoot(), fileName));',
		"const path = resolveConfigDir(env, home); readFileSync(resolve(path, fileName));",
	])("rejects a sanctioned config path accessor outside its owner: %s", (source) => {
		expect(violationsIn("src/lib/provider/new-runtime.ts", source)).not.toEqual(
			[],
		);
	});
});
