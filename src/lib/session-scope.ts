// Project slugs are URL path segments. A slash reserves a separate namespace
// for group keys, while every existing ?p=<slug> keeps its project meaning.
const GROUP_SCOPE_PREFIX = "/group/";

export function encodeGroupScope(key: string): string {
	return `${GROUP_SCOPE_PREFIX}${key}`;
}

export function getScopeGroupKey(
	scope: string | null | undefined,
): string | null {
	return scope?.startsWith(GROUP_SCOPE_PREFIX)
		? scope.slice(GROUP_SCOPE_PREFIX.length)
		: null;
}
