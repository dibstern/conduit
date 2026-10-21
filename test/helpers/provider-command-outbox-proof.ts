import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";

const artifact = "test-results/82tn27-command-outbox.json";
const copy = "/tmp/82tn27-command-outbox.json";

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

/** Run contributing test files sequentially; this merge does not lock across processes. */
export function writeProviderCommandOutboxProof(
	records: readonly Record<string, unknown>[],
): void {
	if (records.length === 0) return;
	const previousPath = existsSync(artifact)
		? artifact
		: existsSync(copy)
			? copy
			: undefined;
	const previous = previousPath
		? (
				JSON.parse(readFileSync(previousPath, "utf8")) as {
					scenarios: Record<string, unknown>[];
				}
			).scenarios
		: [];
	const previousTimestamp = previousPath
		? statSync(previousPath).mtime.toISOString()
		: undefined;
	const merged = new Map(
		previous.map((record) => [
			scenarioKey(record),
			{
				...record,
				passed: record["passed"] === true,
				timestamp: record["timestamp"] ?? previousTimestamp,
			},
		]),
	);
	const timestamp = new Date().toISOString();
	for (const record of records)
		merged.set(scenarioKey(record), {
			...record,
			passed: record["passed"] === true,
			timestamp,
		});
	mkdirSync("test-results", { recursive: true });
	const json = JSON.stringify({ scenarios: [...merged.values()] }, null, 2);
	writeFileSync(artifact, json);
	writeFileSync(copy, json);
}
