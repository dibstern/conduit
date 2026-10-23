import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const scenariosByFile = new Map<string, Map<string, Record<string, unknown>>>();

function scenarioKey(record: Record<string, unknown>): string {
	if (typeof record["scenario"] === "string") return record["scenario"];
	if (
		typeof record["kind"] === "string" &&
		typeof record["crashPoint"] === "string"
	)
		return `${record["kind"]}:${record["crashPoint"]}`;
	throw new Error(
		"Command outbox proof requires a scenario name or kind and crashPoint",
	);
}

/** Each test file owns its artifact and accumulates its records in memory. */
export function writeProviderCommandOutboxProof(
	testFile: string,
	records: readonly Record<string, unknown>[],
): void {
	if (records.length === 0) return;
	const source = basename(fileURLToPath(testFile), ".test.ts");
	const merged =
		scenariosByFile.get(source) ?? new Map<string, Record<string, unknown>>();
	scenariosByFile.set(source, merged);
	const timestamp = new Date().toISOString();
	for (const record of records)
		merged.set(scenarioKey(record), {
			...record,
			passed: record["passed"] === true,
			timestamp,
		});
	mkdirSync("test-results", { recursive: true });
	const json = JSON.stringify({ scenarios: [...merged.values()] }, null, 2);
	writeFileSync(`test-results/82tn27-command-outbox-${source}.json`, json);
	writeFileSync(`/tmp/82tn27-command-outbox-${source}.json`, json);
}
