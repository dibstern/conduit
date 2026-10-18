/** One project, or the projects in one Project Group. */
export interface SessionScope {
	readonly projectIds: readonly [string, ...string[]];
}
