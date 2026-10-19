import { Schema } from "effect";

export const UNTITLED_SESSION_TITLE = "Untitled";
export const AUTO_TITLE_SOURCE = "auto-title" as const;
export type AutoTitleSource = typeof AUTO_TITLE_SOURCE;

const NEW_SESSION_TITLE = "new session";
const PLACEHOLDER_TITLES = [
	"",
	"claude session",
	UNTITLED_SESSION_TITLE.toLowerCase(),
	NEW_SESSION_TITLE,
];
const PLACEHOLDER_TITLE_PREFIX = `${NEW_SESSION_TITLE} `;

export function isPlaceholderTitle(title: string | undefined): boolean {
	const normalized = title?.trim().toLowerCase() ?? "";
	return (
		PLACEHOLDER_TITLES.includes(normalized) ||
		normalized.startsWith(PLACEHOLDER_TITLE_PREFIX)
	);
}

export function placeholderTitleSql(expr: string): string {
	const normalized = `LOWER(TRIM(${expr}))`;
	return `(${expr} IS NULL
		OR ${normalized} IN (${PLACEHOLDER_TITLES.map((title) => `'${title}'`).join(", ")})
		OR ${normalized} LIKE '${PLACEHOLDER_TITLE_PREFIX}%')`;
}

export const SessionTitleModel = Schema.Union([
	Schema.Struct({ harness: Schema.Literal("claude"), model: Schema.String }),
]);
export type SessionTitleModel = typeof SessionTitleModel.Type;
