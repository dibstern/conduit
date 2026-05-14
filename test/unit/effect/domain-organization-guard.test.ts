import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const OLD_EFFECT_DIR = join(REPO_ROOT, "src/lib/effect");
const DOMAIN_ROOT = join(REPO_ROOT, "src/lib/domain");
const RELAY_SERVICES_INDEX = join(
	REPO_ROOT,
	"src/lib/domain/relay/Services/services.ts",
);

function tsFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];

	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...tsFiles(path));
		} else if (path.endsWith(".ts")) {
			files.push(relative(REPO_ROOT, path));
		}
	}
	return files.sort();
}

describe("Effect domain organization guard", () => {
	it("keeps production Effect services and layers out of the retired flat bucket", () => {
		expect(tsFiles(OLD_EFFECT_DIR)).toEqual([]);
	});

	it("keeps source and test imports off the retired flat src/lib/effect path", () => {
		const staleImports = [
			...tsFiles(join(REPO_ROOT, "src")),
			...tsFiles(join(REPO_ROOT, "test")),
		].filter((file) => {
			if (file === "test/unit/effect/domain-organization-guard.test.ts") {
				return false;
			}
			return readFileSync(join(REPO_ROOT, file), "utf8").includes(
				"src/lib/effect/",
			);
		});

		expect(staleImports).toEqual([]);
	});

	it("does not use the relay services index as a cross-domain export barrel", () => {
		const text = readFileSync(RELAY_SERVICES_INDEX, "utf8");

		expect(text).not.toMatch(
			/export\s*\{[\s\S]*\}\s*from\s*["']\.\.\/\.\.\/(daemon|persistence|provider|server)\//,
		);
	});

	it("keeps the domain-owned Effect layout present", () => {
		expect(existsSync(DOMAIN_ROOT)).toBe(true);
	});
});
