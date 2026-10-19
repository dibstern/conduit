import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const CONTRACT_SOURCE_PATH =
	"src/lib/contracts/providers/provider-runtime-event.ts";
const CONTRACT_SOURCE = join(REPO_ROOT, CONTRACT_SOURCE_PATH);

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

describe("ProviderRuntimeEvent contracts", () => {
	it("keeps ProviderRuntimeEvent as provider ingress, not persistence truth", () => {
		const filesImportingContract = tsFiles(join(REPO_ROOT, "src/lib"))
			.filter((file) => file !== CONTRACT_SOURCE_PATH)
			.filter((file) => {
				const source = readFileSync(join(REPO_ROOT, file), "utf8");
				return (
					source.includes("ProviderRuntimeEvent") ||
					source.includes("provider-runtime-event.js")
				);
			});

		const forbiddenPersistenceImports = filesImportingContract.filter(
			(file) =>
				file.startsWith("src/lib/persistence/") ||
				file.startsWith("src/lib/persistence/projectors/"),
		);

		expect(forbiddenPersistenceImports).toEqual([]);
		expect(filesImportingContract).toEqual(
			expect.arrayContaining([
				"src/lib/provider/types.ts",
				"src/lib/provider/relay-event-sink.ts",
				"src/lib/provider/provider-runtime-event-to-domain.ts",
				"src/lib/domain/relay/Services/provider-runtime-ingestion-service.ts",
			]),
		);
	});

	it("keeps provider adapters from constructing durable domain events directly", () => {
		const files = [
			...tsFiles(join(REPO_ROOT, "src/lib/provider")),
			...tsFiles(join(REPO_ROOT, "src/lib/relay")),
		];
		const allowed = new Set([
			"src/lib/provider/provider-runtime-event-to-domain.ts",
		]);
		const unexpected = files.flatMap((file) => {
			if (allowed.has(file)) return [];
			const source = readFileSync(join(REPO_ROOT, file), "utf8");
			return source.includes("canonicalEvent(") ? [file] : [];
		});

		expect(unexpected).toEqual([]);
	});

	it("keeps OpenCode runtime ingress outside persistence and behind ProviderRuntimeIngestion", () => {
		for (const file of [
			"src/lib/persistence/dual-write-hook.ts",
			"src/lib/persistence/effect/dual-write-hook-effect.ts",
		]) {
			expect(existsSync(join(REPO_ROOT, file))).toBe(false);
		}

		const effectIngressPath =
			"src/lib/domain/relay/Services/opencode-runtime-ingress-service.ts";
		const effectIngress = readFileSync(
			join(REPO_ROOT, effectIngressPath),
			"utf8",
		);

		expect(effectIngress).toContain("OpenCodeRuntimeEventTranslator");
		expect(effectIngress).toContain("ProviderRuntimeIngestionTag");
		expect(effectIngress).toContain("ingestBatch");
		expect(effectIngress).not.toContain(
			"translateProviderRuntimeEventToDomain",
		);
		expect(effectIngress).not.toContain("EventStoreEffectTag");
		expect(effectIngress).not.toContain("CanonicalEvent");
	});

	it("does not keep a legacy sync OpenCode runtime ingress", () => {
		const legacyIngress = join(
			REPO_ROOT,
			"src/lib/domain/relay/Services/opencode-runtime-ingress-legacy.ts",
		);

		expect(existsSync(legacyIngress)).toBe(false);
	});

	it("stays implementation-free", () => {
		const source = readFileSync(CONTRACT_SOURCE, "utf8");
		const imports = Array.from(
			source.matchAll(/^import\s+(?!type\b).*\s+from\s+["']([^"']+)["'];$/gm),
			(match) => match[1],
		);

		expect(imports).toEqual(["effect"]);
		expect(source).not.toMatch(
			/Context\.Tag|Layer|Effect\.|CanonicalEvent|ProviderInstance|RelayMessage|EventSink|sqlite|fetch\(/,
		);
	});
});
