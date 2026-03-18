// ─── Shared Utilities ────────────────────────────────────────────────────────
// Pure utility functions used across multiple groups.

/**
 * Compile-time exhaustive check for switch/case statements.
 *
 * Place in the `default` branch of a switch over a union type.
 * If a new variant is added to the union but not handled,
 * TypeScript will produce a compile-time error because the
 * unhandled variant cannot be assigned to `never`.
 *
 * @example
 * ```ts
 * type Status = "active" | "inactive";
 * function label(s: Status): string {
 *   switch (s) {
 *     case "active": return "On";
 *     case "inactive": return "Off";
 *     default: return assertNever(s);
 *   }
 * }
 * ```
 */
export function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${String(value)}`);
}

/** Generate a slug from a directory path */
export function generateSlug(
	directory: string,
	existingSlugs: Set<string>,
): string {
	// Extract the last directory segment
	const parts = directory.replace(/\\/g, "/").split("/").filter(Boolean);
	let base = parts[parts.length - 1] ?? "project";

	// Sanitize: lowercase, replace non-alphanumeric with dashes
	base = base
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");

	if (base.length === 0) base = "project";

	// Ensure uniqueness
	let slug = base;
	let counter = 2;
	while (existingSlugs.has(slug)) {
		slug = `${base}-${counter}`;
		counter++;
	}

	return slug;
}
