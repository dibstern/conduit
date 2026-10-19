/** The registered projects included in a persistence read. */
export interface SessionScope {
	readonly projectIds: readonly [string, ...string[]];
}
