import { Context, Layer } from "effect";

export class PendingSendOwnershipTag extends Context.Tag(
	"PendingSendOwnership",
)<
	PendingSendOwnershipTag,
	{
		readonly register: (
			sessionId: string,
			send: { commandId: string; originId: string | undefined; text: string },
		) => void;
		readonly remove: (sessionId: string, commandId: string) => void;
		readonly clear: (sessionId: string) => void;
		readonly resolve: (
			sessionId: string | undefined,
			messageId: string | undefined,
			text: string,
		) => string | undefined;
		readonly deleteSession: (sessionId: string) => void;
	}
>() {}

export const PendingSendOwnershipLive = Layer.sync(
	PendingSendOwnershipTag,
	() => {
		const sessions = new Map<
			string,
			{
				pending: {
					commandId: string;
					originId: string | undefined;
					text: string;
				}[];
				commands: Set<string>;
				confirmed: Map<string, string | undefined>;
			}
		>();
		return {
			register: (sessionId, send) => {
				const state = sessions.get(sessionId) ?? {
					pending: [],
					commands: new Set<string>(),
					confirmed: new Map<string, string | undefined>(),
				};
				sessions.set(sessionId, state);
				if (state.commands.has(send.commandId)) return;
				state.commands.add(send.commandId);
				if (state.commands.size > 64) {
					const oldest = state.commands.values().next().value;
					if (oldest !== undefined) state.commands.delete(oldest);
				}
				state.pending.push(send);
			},
			remove: (sessionId, commandId) => {
				const pending = sessions.get(sessionId)?.pending;
				const index = pending?.findIndex(
					(send) => send.commandId === commandId,
				);
				if (pending && index !== undefined && index !== -1)
					pending.splice(index, 1);
			},
			clear: (sessionId) => {
				const state = sessions.get(sessionId);
				if (state) state.pending.length = 0;
			},
			resolve: (sessionId, messageId, text) => {
				if (!sessionId || !messageId) return undefined;
				const state = sessions.get(sessionId) ?? {
					pending: [],
					commands: new Set<string>(),
					confirmed: new Map<string, string | undefined>(),
				};
				sessions.set(sessionId, state);
				if (state.confirmed.has(messageId))
					return state.confirmed.get(messageId);
				const owner = state.pending.shift();
				const originId = owner?.text === text ? owner.originId : undefined;
				state.confirmed.set(messageId, originId);
				if (state.confirmed.size > 64) {
					const oldest = state.confirmed.keys().next().value;
					if (oldest !== undefined) state.confirmed.delete(oldest);
				}
				return originId;
			},
			deleteSession: (sessionId) => {
				sessions.delete(sessionId);
			},
		};
	},
);
