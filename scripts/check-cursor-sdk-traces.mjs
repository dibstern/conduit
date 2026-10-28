#!/usr/bin/env node

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SUPPORTED_TRACE_VERSIONS = ["1.0.37", "1.0.40"];

const directory = "test/fixtures/cursor-sdk-traces";
const files = readdirSync(directory)
	.filter((file) => file.endsWith(".jsonl"))
	.sort();
const secretField =
	/^(?:api[_-]?key|authorization|(?:access|refresh|session)[_-]?token|token|password|secret|(?:blob)?encryption[_-]?key)$/i;
const keyLike =
	/\b(?:key_[A-Za-z0-9_-]{16,}|sk[-_][A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
const privateHome = /\/Users\/[^/\s"\\]+|\/home\/(?!test\b)[^/\s"\\]+/g;
const evidence = {
	checkedAt: new Date().toISOString(),
	directory,
	supportedTraceVersions: SUPPORTED_TRACE_VERSIONS,
	files,
	rows: 0,
	invalidJsonRows: 0,
	invalidHeaders: 0,
	unredactedCredentialFields: 0,
	keyLikeStrings: 0,
	privateHomePaths: 0,
};

// Do not read the developer's key. Report counts only, never matched contents.
function scan(value) {
	if (typeof value === "string") {
		evidence.keyLikeStrings += [...value.matchAll(keyLike)].length;
		evidence.privateHomePaths += [...value.matchAll(privateHome)].length;
	} else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			if (secretField.test(key) && child !== "[REDACTED]" && child !== null) {
				evidence.unredactedCredentialFields++;
			}
			scan(child);
		}
	}
}

for (const file of files) {
	const lines = readFileSync(join(directory, file), "utf8")
		.split("\n")
		.filter(Boolean);
	for (const [index, line] of lines.entries()) {
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			evidence.invalidJsonRows++;
			continue;
		}
		evidence.rows++;
		if (
			index === 0 &&
			(!row ||
				!SUPPORTED_TRACE_VERSIONS.includes(row.sdkVersion) ||
				typeof row.scenario !== "string" ||
				!(
					typeof row.model === "string" ||
					(row.model && typeof row.model.id === "string")
				) ||
				typeof row.recordedAt !== "string")
		) {
			evidence.invalidHeaders++;
		}
		scan(row);
	}
	if (!lines.length) evidence.invalidHeaders++;
}

mkdirSync("test-results", { recursive: true });
const output = "test-results/xqsg-22-cursor-trace-audit.json";
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(
	JSON.stringify(
		{ ...evidence, files: files.length, evidence: output },
		null,
		2,
	),
);
process.exitCode =
	evidence.invalidJsonRows ||
	evidence.invalidHeaders ||
	evidence.unredactedCredentialFields ||
	evidence.keyLikeStrings ||
	evidence.privateHomePaths
		? 1
		: 0;
