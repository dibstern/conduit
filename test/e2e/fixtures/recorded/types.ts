/** A single captured HTTP interaction or SSE event from OpenCode. */
export type OpenCodeInteraction =
	| {
			kind: "rest";
			method: string;
			path: string;
			requestBody?: unknown;
			status: number;
			responseBody: unknown;
	  }
	| {
			kind: "sse";
			type: string;
			properties: Record<string, unknown>;
			delayMs: number;
	  }
	| {
			/** PTY WebSocket connection opened */
			kind: "pty-open";
			ptyId: string;
			cursor: number; // 0 = new, -1 = reconnect
	  }
	| {
			/** Input sent from relay to PTY (text frame) */
			kind: "pty-input";
			ptyId: string;
			data: string;
			delayMs: number;
	  }
	| {
			/** Output received from PTY upstream (text frame, 0x00 metadata frames excluded) */
			kind: "pty-output";
			ptyId: string;
			data: string;
			delayMs: number;
	  }
	| {
			/** PTY WebSocket connection closed */
			kind: "pty-close";
			ptyId: string;
			code: number;
			reason: string;
			delayMs: number;
	  };

/** A full recorded session of OpenCode HTTP interactions. */
export interface OpenCodeRecording {
	name: string;
	recordedAt: string;
	opencodeVersion: string;
	interactions: OpenCodeInteraction[];
}
