import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { generateEntrypoint } from "../../../acceptance/bin/acceptance-entrypoint-generator.js";
import type { ApsFeature } from "../../../acceptance/src/apsTypes.js";
import {
	expandFeature,
	resolveStepText,
} from "../../../acceptance/src/exampleExpansion.js";
import { conduitVisualHandlers } from "../../../acceptance/src/stepHandlers.js";

describe("acceptance pipeline", () => {
	test("expands backgrounds and resolves composer and General settings steps to one handler", () => {
		const feature: ApsFeature = {
			name: "Composer send button reflects input content",
			background: [
				{
					keyword: "Given",
					text: "the conduit app is served with the connected mockup",
				},
			],
			scenarios: [
				{
					name: "send button enables only when the composer has text",
					steps: [
						{
							keyword: "When",
							text: "I type <message> into the composer",
						},
						{
							keyword: "Then",
							text: "the send button is <enabled>",
						},
					],
					examples: [
						{ message: "hello world", enabled: "true" },
						{ message: "fix the bug", enabled: "true" },
						{ message: "", enabled: "false" },
					],
				},
				{
					name: "the composer matches the approved layout",
					steps: [
						{
							keyword: "When",
							text: "I type <message> into the composer",
						},
						{
							keyword: "Then",
							text: "the composer region visually matches <baseline> at <threshold> percent",
						},
					],
					examples: [
						{
							message: "hello world",
							baseline: "composer-with-text-dark",
							threshold: "98",
						},
					],
				},
				{
					name: "General groups and Advanced follow the settings design",
					examples: [],
					steps: [
						{ keyword: "Given", text: "General auto-settle is set to 3 days" },
						{ keyword: "When", text: "I open settings to the General section" },
						{
							keyword: "Then",
							text: "the General headings are Appearance, Composer, Notifications and Sessions in order",
						},
						{
							keyword: "And",
							text: "General keeps Theme in Appearance and auto-settle in Sessions",
						},
						{ keyword: "And", text: "General has no log level control" },
						{
							keyword: "And",
							text: "the General Advanced group is collapsed with Debug off",
						},
						{ keyword: "When", text: "I expand General Advanced" },
						{
							keyword: "And",
							text: "I toggle the General connection debug panel",
						},
						{
							keyword: "Then",
							text: "the General Advanced group is expanded with Debug on",
						},
					],
				},
			],
		};
		const executions = expandFeature(feature);

		expect(executions).toHaveLength(5);
		for (const execution of executions) {
			expect(execution.steps[0]?.text).toBe(
				"the conduit app is served with the connected mockup",
			);
			for (const step of execution.steps) {
				const text = resolveStepText(step.text, execution.example);
				const matchingHandlers = conduitVisualHandlers.filter((handler) =>
					handler.match.test(text),
				);
				expect(matchingHandlers, text).toHaveLength(1);
			}
		}
	});

	test("generates deterministic entrypoint metadata from generated files only", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "conduit-acceptance-"));
		try {
			await mkdir(join(projectRoot, "features"), { recursive: true });
			await mkdir(join(projectRoot, "build/acceptance/ir"), {
				recursive: true,
			});
			await writeFile(
				join(projectRoot, "features/composer-send-button.feature"),
				"Feature: Composer\n",
			);
			await writeFile(
				join(projectRoot, "build/acceptance/ir/composer-send-button.json"),
				JSON.stringify({ name: "Composer", scenarios: [] }),
			);

			const args = [
				"build/acceptance/ir/composer-send-button.json",
				"acceptance/generated",
			] as const;
			const first = await generateEntrypoint(args[0], args[1], { projectRoot });
			const second = await generateEntrypoint(args[0], args[1], {
				projectRoot,
			});
			const metadata = JSON.parse(
				await readFile(join(projectRoot, first.metadataPath), "utf8"),
			) as {
				hash_scope: string;
				implementation_hash: string;
				generated_files: string[];
			};

			expect(second.implementationHash).toBe(first.implementationHash);
			expect(metadata.hash_scope).toBe("generated_files");
			expect(metadata.implementation_hash).toBe(first.implementationHash);
			expect(metadata.generated_files).toEqual([
				"acceptance/generated/composer-send-button.acceptance.ts",
			]);
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});
});
