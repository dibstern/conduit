// Encapsulates PTY session lifecycle: registration, scrollback buffering,
// input forwarding, and cleanup. Extracted from relay-stack.ts so PTY state
// management is isolated and independently testable.

import type { PtyEvent } from "../contracts/ws-rpc.js";
import { createSilentLogger, type Logger } from "../logger.js";
import type { PtyInfo, PtyStatus } from "../shared-types.js";
import {
	PTY_SCROLLBACK_BYTES,
	PtyScrollback,
} from "../terminal/pty-host-protocol.js";

const WS_OPEN = 1;

export interface PtyUpstream {
	readyState: number;
	send(data: string | Buffer | ArrayBuffer, cb?: (err?: Error) => void): void;
	close(code?: number, reason?: string | Buffer): void;
	terminate(): void;
	resize?(cols: number, rows: number): void;
	detach?(): void;
}

export interface PtySessionState {
	upstream: PtyUpstream;
	source: "local" | "opencode";
	scrollback: PtyScrollback;
	exited: boolean;
	exitCode: number | null;
	info?: PtyInfo;
}

/** A tracked PTY as a row. OpenCode PTYs re-attached after a restart carry no
 *  info, so they get the defaults the terminal list always showed for them. */
export const trackedPtyInfo = (
	pty: { readonly id: string; readonly status: PtyStatus },
	projectDir: string,
	info?: PtyInfo,
): PtyInfo => ({
	id: pty.id,
	title: "Terminal",
	command: "bash",
	cwd: projectDir,
	pid: 0,
	...info,
	status: pty.status,
});

export interface PtyManagerOptions {
	log?: Logger;
	scrollbackMax?: number;
}

export class PtyManager {
	private readonly sessions = new Map<string, PtySessionState>();
	private readonly listeners = new Set<(event: PtyEvent) => void>();
	private readonly log: Logger;
	private readonly scrollbackMax: number;

	constructor(options: PtyManagerOptions) {
		this.log = options.log ?? createSilentLogger();
		this.scrollbackMax = options.scrollbackMax ?? PTY_SCROLLBACK_BYTES;
	}

	get sessionCount(): number {
		return this.sessions.size;
	}

	get listenerCount(): number {
		return this.listeners.size;
	}

	/** Hear every PTY change from now on. Read the snapshot in the same turn to
	 *  miss nothing. Returns the unsubscribe. */
	subscribe(listener: (event: PtyEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Tell every subscriber, i.e. every browser tab on this project. */
	publish(event: PtyEvent): void {
		for (const listener of this.listeners) listener(event);
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

	registerSession(
		ptyId: string,
		upstream: PtyUpstream,
		source: "local" | "opencode" = "opencode",
		info?: PtyInfo,
	): PtySessionState {
		if (this.sessions.has(ptyId)) {
			this.closeSession(ptyId);
		}
		const session: PtySessionState = {
			upstream,
			source,
			scrollback: new PtyScrollback(this.scrollbackMax),
			exited: false,
			exitCode: null,
			...(info && { info }),
		};
		this.sessions.set(ptyId, session);
		return session;
	}

	appendScrollback(ptyId: string, text: string): void {
		this.sessions.get(ptyId)?.scrollback.append(text);
	}

	getScrollback(ptyId: string): string {
		return this.sessions.get(ptyId)?.scrollback.read() ?? "";
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

	detachAll(): void {
		for (const [ptyId, session] of this.sessions) {
			if (session.upstream.detach) {
				session.upstream.detach();
				this.sessions.delete(ptyId);
			} else {
				this.closeSession(ptyId);
			}
		}
	}
}
