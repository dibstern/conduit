import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const directory = resolve(root, "test/fixtures/cursor-sdk-traces");

it("documents live trace evidence or a concrete recapture gap for the installed Cursor SDK", () => {
	const { version } = JSON.parse(
		readFileSync(
			resolve(root, "node_modules/@cursor/sdk/package.json"),
			"utf8",
		),
	) as { version: string };
	const readme = readFileSync(resolve(directory, "README.md"), "utf8");
	const evidence = readme
		.split("\n")
		.find((line) => line.startsWith(`- SDK ${version} live capture: `));
	expect(
		evidence,
		`SDK ${version} needs a live capture or a README recapture explanation`,
	).toBeDefined();
	if (!evidence) return;
	const capture = /`([^`]+\.jsonl)`/.exec(evidence)?.[1];
	if (capture) {
		const header = JSON.parse(
			readFileSync(resolve(directory, capture), "utf8").split("\n")[0] ?? "",
		);
		expect(header.sdkVersion).toBe(version);
	} else {
		expect(evidence).toMatch(/unavailable because .+; follow-up [a-z0-9.-]+\./);
	}
});
