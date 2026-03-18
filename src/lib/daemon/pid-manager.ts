// ─── PID & Socket File Management ───────────────────────────────────────────
// Manages PID and Unix socket files for daemon lifecycle tracking.
// Extracted from daemon.ts for isolated testability.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";

export function writePidFile(configDir: string, pidPath: string): void {
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}
	writeFileSync(pidPath, String(process.pid), "utf-8");
}

export function removePidFile(pidPath: string): void {
	try {
		unlinkSync(pidPath);
	} catch {
		// ignore — file might not exist
	}
}

export function removeSocketFile(socketPath: string): void {
	try {
		unlinkSync(socketPath);
	} catch {
		// ignore — file might not exist
	}
}

/** Remove stale PID and socket files if no process is running. */
export function cleanupStalePidFiles(
	pidPath: string,
	socketPath: string,
): void {
	try {
		unlinkSync(pidPath);
	} catch {
		// ignore
	}
	try {
		unlinkSync(socketPath);
	} catch {
		// ignore
	}
}
