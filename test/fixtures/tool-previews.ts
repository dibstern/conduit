// Long content for the tool preview harness (conduit-test-y7eo.6). The fake
// Claude SDK sends the live parts and the spec seeds the rest; both read these
// so the spec knows exactly what each field holds in full.

/** Ends every long field, so a page shows it only when the field is whole. */
export const endOf = (field: string) => `END-OF-${field}`;

const long = (field: string, codePoints: number) =>
	`${`${field} `.repeat(Math.ceil(codePoints / (field.length + 1)))}${endOf(field)}`;

/** A Bash call whose command and result both travel as previews. */
export const LONG_COMMAND = `printf '%s\\n' ${long("argument", 2_400)}`;
export const LONG_RESULT = `${Array.from(
	{ length: 1_500 },
	(_, index) => `line ${index + 1} of the long result`,
).join("\n")}\n${endOf("result")}`;

/** Over 2,000 characters of options: a pending question is never cut. */
export const LONG_QUESTION = {
	questions: [
		{
			question: "Which region should the deploy target?",
			header: "Deploy",
			options: Array.from({ length: 4 }, (_, index) => ({
				label: `Region ${index + 1}`,
				description: long(`region-${index + 1}-detail`, 600),
			})),
		},
	],
};

/** Seeded content: never cut, each over the 2,000 code point budget. */
export const LONG_USER_TEXT = long("user", 2_500);
export const LONG_THINKING = long("thinking", 2_500);
export const LONG_ASSISTANT_TEXT = long("assistant", 2_500);
export const LONG_SUBAGENT_PROMPT = long("subagent-prompt", 2_500);
export const LONG_SUBAGENT_OUTPUT = long("subagent-output", 3_000);
