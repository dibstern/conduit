export interface QueuedRelayCommand {
	readonly commandId: string;
	readonly clientId: string;
	readonly messageType: string;
	readonly sessionId?: string;
	readonly receivedAt: number;
}

export type RelayEvent =
	| {
			readonly _tag: "RelayBecameReady";
			readonly projectSlug: string;
			readonly readyAt: number;
	  }
	| {
			readonly _tag: "ClientCommandQueued";
			readonly projectSlug: string;
			readonly command: QueuedRelayCommand;
	  }
	| {
			readonly _tag: "ClientCommandAccepted";
			readonly projectSlug: string;
			readonly command: QueuedRelayCommand;
	  }
	| {
			readonly _tag: "ClientCommandCompleted";
			readonly projectSlug: string;
			readonly commandId: string;
			readonly completedAt: number;
	  }
	| {
			readonly _tag: "RelayStopped";
			readonly projectSlug: string;
			readonly stoppedAt: number;
	  };
