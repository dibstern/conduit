import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, "src");

// Where a session is allowed to leave the read model. The handler file declares
// the one delete statement; the two projectors run it and report what went,
// because they are the only places that can (see the note at the top of
// session-handlers.ts).
const REMOVAL_SEAM = [
	"src/lib/persistence/projectors/session-handlers.ts",
	"src/lib/persistence/effect/projectors-effect.ts",
	"src/lib/persistence/projectors/session-projector.ts",
];

// The deletes outside the seam, listed rather than quietly permitted, because a
// list someone has to add themselves to is the point: it is a deliberate act,
// and it needs a reason that survives review.
//
//   eviction.ts — `cascadeProjections` is retention maintenance over sessions
//     whose events have already been evicted. It holds a raw SqliteClient with
//     no event bus and no read-model counter to move, and nothing in production
//     calls it: its only callers are its own tests. Its removals are silent.
//   effect/migrations.ts — the legacy skeleton purge runs once, at startup,
//     before a relay exists for anyone to subscribe to. There is no advance to
//     publish because there is nobody to publish it to.
const RECORDED_GAPS = [
	"src/lib/persistence/eviction.ts",
	"src/lib/persistence/effect/migrations.ts",
];

// Being inside the seam is not a licence to write another delete: an ordinary
// SessionWrite is executed with `RETURNING id` appended, which names the row it
// deleted and nothing else, while the cascade takes the subtree in silence. So
// the seam gets exactly one delete statement, spelled out here, and everything
// else has to go through it.
const THE_SANCTIONED_DELETE =
	'export const REMOVE_SESSION_SQL = "DELETE FROM sessions WHERE id = ?";';
const DELETES_A_SESSION = /delete from sessions\b/g;
const RUNS_THE_SANCTIONED_DELETE = /\bremove_session_sql\b/g;

interface Source {
	readonly path: string;
	readonly text: string;
}

// Prose about the rule is not a breach of it. Blanking the comment rather than
// dropping it leaves every other character at its original offset, so a match
// can still be reported at the line someone wrote it on.
const maskProse = (text: string) =>
	text
		.split("\n")
		.map((line) => {
			const source = line.trim();
			return source.startsWith("//") || source.startsWith("*")
				? " ".repeat(line.length)
				: line;
		})
		.join("\n");

/**
 * The file as SQL sees it: one line, one space between tokens, lower case,
 * with each character's original offset kept alongside.
 *
 * Matching this instead of the raw lines is the difference between a rule and a
 * suggestion. A delete wrapped across three lines by the formatter, or typed in
 * lower case, is ordinary code — nobody has to be evading anything — and a
 * guard that reads line by line simply does not see it.
 */
const flatten = (text: string) => {
	const chars: string[] = [];
	const origin: number[] = [];
	let afterWhitespace = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index] ?? "";
		if (char.trim() === "") {
			afterWhitespace = true;
			continue;
		}
		if (afterWhitespace && chars.length > 0) {
			chars.push(" ");
			origin.push(index);
		}
		afterWhitespace = false;
		chars.push(char.toLowerCase());
		origin.push(index);
	}
	return { text: chars.join(""), origin };
};

const SANCTIONED = flatten(THE_SANCTIONED_DELETE).text;
const SANCTIONED_OFFSET = SANCTIONED.indexOf("delete from sessions");

/**
 * Every place that removes a session other than the one way it is allowed to be
 * done. Pure, so the tests below can run it over the real tree and over lines
 * that do not exist yet.
 */
const removalsOutsideTheSeam = (sources: Iterable<Source>) =>
	[...sources].flatMap(({ path, text }) => {
		const flat = flatten(maskProse(text));
		const at = (index: number) => ({
			path,
			line: text.slice(0, flat.origin[index] ?? 0).split("\n").length,
			source: flat.text.slice(index, index + 72),
		});

		const breaches = [];
		for (const match of flat.text.matchAll(DELETES_A_SESSION)) {
			const index = match.index ?? 0;
			const declaredHere = flat.text.slice(
				index - SANCTIONED_OFFSET,
				index - SANCTIONED_OFFSET + SANCTIONED.length,
			);
			// The one exception, recognised by the whole statement rather than by
			// the file it sits in.
			if (path === REMOVAL_SEAM[0] && declaredHere === SANCTIONED) continue;
			breaches.push(at(index));
		}
		if (!REMOVAL_SEAM.includes(path))
			for (const match of flat.text.matchAll(RUNS_THE_SANCTIONED_DELETE))
				breaches.push(at(match.index ?? 0));
		return breaches;
	});

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

const productionSources = (): Source[] =>
	productionSourceFiles(SRC_ROOT)
		.map((file) => ({
			path: relative(REPO_ROOT, file),
			text: readFileSync(file, "utf8"),
		}))
		.filter(({ path }) => !RECORDED_GAPS.includes(path));

describe("session removal boundary grep", () => {
	it("leaves one way to remove a session, inside the seam and outside it", () => {
		const requirement = `A deleted session leaves no row behind to carry a version, and sessions.parent_id ON DELETE CASCADE takes the subagent subtree inside SQLite, where no statement names it. A removal that happens any other way reaches no subscriber: the row simply stops being there, with no advance to explain it, and a client keeps showing a session that is gone.

Remove sessions by returning { removeSession } from a handler in ${REMOVAL_SEAM[0]}. The projector reads the subtree, runs REMOVE_SESSION_SQL, and the advance names every id.

A second delete statement is not an alternative, including inside the seam. An ordinary SessionWrite runs with RETURNING id appended, so it would report the row it deleted and stay silent about the subtree the cascade took — the exact failure this rule exists to prevent, arriving through a file that is allowed to delete.

The match is made against the file flattened to one line and folded to lower case, so a statement wrapped across lines by the formatter counts the same as one written on a single line.

See the note at the top of ${REMOVAL_SEAM[0]} (bead conduit-test-ni8.5.12).`;

		expect(removalsOutsideTheSeam(productionSources()), requirement).toEqual(
			[],
		);
	});

	it("keeps the rule sharp: it still fires on a delete the seam would hide", () => {
		// The rule above passes because the tree obeys it, which is also what it
		// looks like when the rule has stopped meaning anything. So: the statement
		// it protects is really there, and the same predicate that cleared the tree
		// rejects the two ways round it — a raw delete in the file that is allowed
		// to declare one, and the constant executed somewhere that cannot report
		// what it took.
		// Counted under the same normalisation the rule uses, so the statement it
		// protects cannot quietly become two, or none.
		const declarations = productionSources().flatMap(({ path, text }) =>
			Array.from(
				{ length: flatten(maskProse(text)).text.split(SANCTIONED).length - 1 },
				() => path,
			),
		);
		expect(declarations).toEqual([
			"src/lib/persistence/projectors/session-handlers.ts",
		]);

		expect(
			removalsOutsideTheSeam([
				{
					path: "src/lib/persistence/projectors/session-handlers.ts",
					text: '\tconst sql = "DELETE FROM sessions WHERE parent_id = ?";',
				},
				{
					path: "src/lib/handlers/session-handler.ts",
					text: "\tdb.execute(REMOVE_SESSION_SQL, [sessionId]);",
				},
				{
					// A template literal wrapped across lines is ordinary formatting,
					// not evasion — which is exactly why it has to be caught.
					path: "src/lib/session/session-cleanup.ts",
					text: "\tconst sql = `DELETE\nFROM sessions WHERE id = ?`;",
				},
				{
					path: "src/lib/relay/session-reaper.ts",
					text: "\tconst sql = `delete\n\t\tfrom  sessions\n\t\twhere id = ?`;",
				},
			]).map(({ path }) => path),
		).toEqual([
			"src/lib/persistence/projectors/session-handlers.ts",
			"src/lib/handlers/session-handler.ts",
			"src/lib/session/session-cleanup.ts",
			"src/lib/relay/session-reaper.ts",
		]);
	});
});
