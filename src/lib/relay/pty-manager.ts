// ─── PTY Manager ──────────────────────────────────────────────────────────────
// Encapsulates PTY session lifecycle: registration, scrollback buffering,
// input forwarding, and cleanup. Extracted from relay-stack.ts so PTY state
// management is isolated and independently testable.

import { createSilentLogger, type Logger } from "../logger.js";
import type { PtyStatus } from "../shared-types.js";

const DEFAULT_SCROLLBACK_MAX = 50 * 1024; // 50 KB per terminal (matches claude-relay)
const WS_OPEN = 1;

export interface PtyUpstream {
	readyState: number;
	send(data: string | Buffer | ArrayBuffer, cb?: (err?: Error) => void): void;
	close(code?: number, reason?: string | Buffer): void;
	terminate(): void;
}

export interface PtySessionState {
	upstream: PtyUpstream;
	scrollback: string[];
	scrollbackSize: number;
	exited: boolean;
	exitCode: number | null;
}

export interface PtyManagerOptions {
	log?: Logger;
	scrollbackMax?: number;
}

export class PtyManager {
	private readonly sessions = new Map<string, PtySessionState>();
	private readonly log: Logger;
	private readonly scrollbackMax: number;

	constructor(options: PtyManagerOptions) {
		this.log = options.log ?? createSilentLogger();
		this.scrollbackMax = options.scrollbackMax ?? DEFAULT_SCROLLBACK_MAX;
	}

	get sessionCount(): number {
		return this.sessions.size;
	}

	hasSession(ptyId: string): boolean {
		return this.sessions.has(ptyId);
	}

	getSession(ptyId: string): PtySessionState | undefined {
		return this.sessions.get(ptyId);
	}

	listSessions(): Array<{ id: string; status: PtyStatus }> {
		return Array.from(this.sessions.entries()).map(([id, s]) => ({
			id,
			status: (s.exited ? "exited" : "running") as PtyStatus,
		}));
	}

	registerSession(ptyId: string, upstream: PtyUpstream): PtySessionState {
		if (this.sessions.has(ptyId)) {
			this.closeSession(ptyId);
		}
		const session: PtySessionState = {
			upstream,
			scrollback: [],
			scrollbackSize: 0,
			exited: false,
			exitCode: null,
		};
		this.sessions.set(ptyId, session);
		return session;
	}

	appendScrollback(ptyId: string, text: string): void {
		const session = this.sessions.get(ptyId);
		if (!session) return;
		session.scrollback.push(text);
		session.scrollbackSize += text.length;
		while (
			session.scrollbackSize > this.scrollbackMax &&
			session.scrollback.length > 1
		) {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			session.scrollbackSize -= session.scrollback[0]!.length;
			session.scrollback.shift();
		}
	}

	getScrollback(ptyId: string): string {
		const session = this.sessions.get(ptyId);
		if (!session || session.scrollback.length === 0) return "";
		return session.scrollback.join("");
	}

	markExited(ptyId: string, exitCode: number): void {
		const session = this.sessions.get(ptyId);
		if (session) {
			session.exited = true;
			session.exitCode = exitCode;
		}
	}

	sendInput(ptyId: string, data: string): void {
		const session = this.sessions.get(ptyId);
		if (session?.upstream.readyState === WS_OPEN) {
			session.upstream.send(data);
		}
	}

	closeSession(ptyId: string): void {
		const session = this.sessions.get(ptyId);
		if (!session) return;
		this.sessions.delete(ptyId);
		this.log.info(`Closing PTY ${ptyId}`);
		if (session.upstream.readyState === WS_OPEN) {
			session.upstream.close(1000, "Proxy closed");
		} else {
			session.upstream.terminate();
		}
	}

	closeAll(): void {
		for (const ptyId of [...this.sessions.keys()]) {
			this.closeSession(ptyId);
		}
	}
}
