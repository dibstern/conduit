import {
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	SynchronizedRef,
} from "effect";

export interface ClientMessageSerializationService {
	withClient: <A, E, R>(
		clientId: string,
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
	removeClient: (clientId: string) => Effect.Effect<void>;
	readonly activeClients: Effect.Effect<number>;
}

export class ClientMessageSerializationTag extends Context.Tag(
	"ClientMessageSerialization",
)<ClientMessageSerializationTag, ClientMessageSerializationService>() {}

type ClientSemaphores = HashMap.HashMap<string, Effect.Semaphore>;

const getOrCreateSemaphore = (
	ref: SynchronizedRef.SynchronizedRef<ClientSemaphores>,
	clientId: string,
) =>
	SynchronizedRef.modifyEffect(ref, (state) => {
		const existing = HashMap.get(state, clientId);
		if (Option.isSome(existing)) {
			return Effect.succeed([existing.value, state] as const);
		}
		return Effect.map(Effect.makeSemaphore(1), (semaphore) => [
			semaphore,
			HashMap.set(state, clientId, semaphore),
		]);
	});

export const ClientMessageSerializationLive = Layer.effect(
	ClientMessageSerializationTag,
	Effect.gen(function* () {
		const semaphores = yield* SynchronizedRef.make<ClientSemaphores>(
			HashMap.empty(),
		);

		return {
			withClient: <A, E, R>(clientId: string, effect: Effect.Effect<A, E, R>) =>
				Effect.flatMap(
					getOrCreateSemaphore(semaphores, clientId),
					(semaphore) => semaphore.withPermits(1)(effect),
				),
			removeClient: (clientId: string) =>
				SynchronizedRef.update(semaphores, HashMap.remove(clientId)),
			activeClients: SynchronizedRef.get(semaphores).pipe(
				Effect.map(HashMap.size),
			),
		};
	}),
);
