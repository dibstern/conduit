// ─── Version Store ──────────────────────────────────────────────────────────
// Tracks current conduit version and available update info for the sidebar footer.

export const versionState = $state({
	/** Current running version (fetched from /info endpoint) */
	current: "",
	/** Latest available version from npm (set by update_available WS message) */
	latest: "",
});

/** Called once on app init to fetch current version from the daemon. */
export async function fetchCurrentVersion(): Promise<void> {
	try {
		const res = await fetch("/info");
		if (res.ok) {
			const data = (await res.json()) as { version?: string };
			if (data.version) {
				versionState.current = data.version;
			}
		}
	} catch {
		// Non-fatal — version just won't show
	}
}

/** Called by ws-dispatch when an update_available message arrives. */
export function setLatestVersion(version: string): void {
	versionState.latest = version;
}
