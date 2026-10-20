import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const writer = "src/lib/domain/relay/Services/surfacing-feedback.ts";
const writes =
	/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+surfacing_marks\b|\bsurfacing_mark\s*=(?!=)/gi;
const sourceFiles = (directory: string): string[] =>
	readdirSync(directory).flatMap((entry) => {
		const filename = join(directory, entry);
		return statSync(filename).isDirectory()
			? sourceFiles(filename)
			: /\.(?:ts|svelte|sql)$/.test(filename)
				? [filename]
				: [];
	});

it("confines surfacing mark writes to SurfacingFeedback", () => {
	const violations = sourceFiles(join(process.cwd(), "src"))
		.filter((filename) => relative(process.cwd(), filename) !== writer)
		.flatMap((filename) =>
			[...readFileSync(filename, "utf8").matchAll(writes)].map((match) => ({
				filename: relative(process.cwd(), filename),
				write: match[0],
			})),
		);
	expect(
		violations,
		"Annotations must use SurfacingFeedback's commit-and-signal stamp",
	).toEqual([]);
	expect(readFileSync(writer, "utf8").match(writes)?.length).toBeGreaterThan(0);
});
