// ─── Version Store ──────────────────────────────────────────────────────────
// Tracks current conduit version for the sidebar footer.

export const versionState = $state({
	/** Current running version (fetched from /info endpoint) */
	current: "",
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
