import type {
	BuiltinCategoryId,
	Category,
} from "../../contracts/category-set.js";

const BUILTIN_CATEGORY_COLOURS: Readonly<Record<string, string | undefined>> = {
	ask: "var(--color-cat-ask)",
	blocked: "var(--color-cat-blocked)",
	risk: "var(--color-cat-risk)",
	scope: "var(--color-cat-scope)",
	replan: "var(--color-cat-replan)",
	correction: "var(--color-cat-correction)",
	decision: "var(--color-cat-decision)",
	finding: "var(--color-cat-finding)",
	milestone: "var(--color-cat-milestone)",
} satisfies Record<BuiltinCategoryId, string>;

export function categoryColour(
	category: Category | undefined,
): string | undefined {
	return category?.origin === "builtin"
		? BUILTIN_CATEGORY_COLOURS[category.id]
		: category?.colour;
}
