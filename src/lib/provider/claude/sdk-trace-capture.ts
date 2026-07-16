import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Raw Claude SDK wire capture — a Runtime Trace, per CONTEXT.md: optional
// diagnostics that may be absent or disabled without changing behavior.
//
// Set CONDUIT_CLAUDE_SDK_CAPTURE=1 (default dir below) or =<dir> to tee every
// raw SDK message to <dir>/<conduit-session-id>.jsonl BEFORE schema decode.
// Captured traces are the ground truth for the Provider Contract: trim one and
// commit it under test/fixtures/claude-sdk-traces/ so the replay test
// (claude-sdk-trace-replay.test.ts) pins decode + translation against real
// wire traffic instead of hand-written fixtures. See docs/adr/0002.

const DEFAULT_CAPTURE_DIR = join(homedir(), ".config", "conduit", "sdk-traces");

let resolvedCaptureDir: string | null | undefined;

function captureDir(): string | null {
	if (resolvedCaptureDir !== undefined) return resolvedCaptureDir;
	const raw = process.env["CONDUIT_CLAUDE_SDK_CAPTURE"];
	if (raw === undefined || raw === "" || raw === "0") {
		resolvedCaptureDir = null;
		return resolvedCaptureDir;
	}
	const dir = raw === "1" || raw === "true" ? DEFAULT_CAPTURE_DIR : raw;
	try {
		mkdirSync(dir, { recursive: true });
		resolvedCaptureDir = dir;
	} catch {
		resolvedCaptureDir = null;
	}
	return resolvedCaptureDir;
}

export function captureClaudeSdkMessage(
	sessionId: string,
	message: unknown,
): void {
	const dir = captureDir();
	if (dir === null) return;
	try {
		appendFileSync(
			join(dir, `${sessionId}.jsonl`),
			`${JSON.stringify(message)}\n`,
		);
	} catch {
		// A Runtime Trace must never break the stream it observes.
	}
}
