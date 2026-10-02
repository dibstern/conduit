/** Claim at most one automatic reload per server build in this tab. */
export function claimBuildReload(
	pageBuildId: string,
	serverBuildId: string | undefined,
	storage?: Pick<Storage, "getItem" | "setItem">,
): "current" | "reload" | "warn" {
	if (
		!serverBuildId ||
		pageBuildId === serverBuildId ||
		pageBuildId === "dev" ||
		serverBuildId === "dev"
	)
		return "current";

	try {
		const tabStorage = storage ?? sessionStorage;
		const key = `conduit-build-reload:${serverBuildId}`;
		if (tabStorage.getItem(key)) return "warn";
		tabStorage.setItem(key, "1");
		return "reload";
	} catch {
		return "warn";
	}
}

/** Preparation can fail before navigation; allow a later handshake to retry. */
export function releaseBuildReload(serverBuildId: string | undefined): void {
	try {
		sessionStorage.removeItem(`conduit-build-reload:${serverBuildId}`);
	} catch {
		// Keep warning if storage becomes unavailable rather than risk a loop.
	}
}

/** Replace legacy shell-caching workers before navigating, preserving push. */
export async function refreshAppShell(): Promise<void> {
	if (!("serviceWorker" in navigator)) return;
	const previous = await navigator.serviceWorker.getRegistration();
	if (!previous) return;
	const registration = await navigator.serviceWorker.register("/sw.js", {
		scope: previous.scope,
		updateViaCache: "none",
	});
	const worker = registration.installing ?? registration.waiting;
	if (!worker || worker.state === "activated") return;
	await new Promise<void>((resolve, reject) => {
		const finish = (error?: Error) => {
			clearTimeout(timer);
			worker.removeEventListener("statechange", onStateChange);
			if (error) reject(error);
			else resolve();
		};
		const onStateChange = () => {
			if (worker.state === "activated") finish();
			else if (worker.state === "redundant")
				finish(new Error("Service worker update failed"));
		};
		const timer = setTimeout(
			() => finish(new Error("Service worker update timed out")),
			5_000,
		);
		worker.addEventListener("statechange", onStateChange);
		onStateChange();
	});
}
