// ─── Signal Handlers ────────────────────────────────────────────────────────
// Process signal handling for graceful daemon shutdown.
// Extracted from daemon.ts for clarity.

type ShutdownFn = () => void;

interface StoredHandler {
	signal: string;
	handler: () => void;
}

let handlers: StoredHandler[] = [];

export function installSignalHandlers(
	onShutdown: ShutdownFn,
	onReload?: () => void,
): void {
	const shutdown = () => {
		onShutdown();
	};

	const reload = () => {
		// SIGHUP — reload config (placeholder for future config reload)
		// Currently a no-op beyond logging
		onReload?.();
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	process.on("SIGHUP", reload);

	handlers = [
		{ signal: "SIGTERM", handler: shutdown },
		{ signal: "SIGINT", handler: shutdown },
		{ signal: "SIGHUP", handler: reload },
	];
}

export function removeSignalHandlers(): void {
	for (const { signal, handler } of handlers) {
		process.removeListener(signal, handler);
	}
	handlers = [];
}
