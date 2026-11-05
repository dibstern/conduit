// Display-only sidebar rows. Storage failures and incompatible records cost a
// cold sidebar; these rows are never a shell subscription's resume base, so a
// record from an older build is still drawn until the live rows replace it.
// One record holds every project's rows, as the shell feed does (m379.5).
import { Option, Schema } from "effect";
import { SessionInfoSchema } from "../../contracts/ws-rpc.js";
import { WS_PROTOCOL_VERSION } from "../../shared-types.js";
import type { SessionInfo } from "../types.js";

const DATABASE = "conduit-saved-shell";
const STORE = "shell";
const KEY = "daemon";
const READ_WAIT_MS = 150;

const SavedShell = Schema.Struct({
	schema: Schema.Literal(2),
	protocolVersion: Schema.Number,
	savedAt: Schema.Number,
	rows: Schema.Array(SessionInfoSchema),
});
export type SavedShell = typeof SavedShell.Type;

const decode = (stored: unknown): SavedShell | undefined =>
	Option.getOrUndefined(
		Option.filter(
			Schema.decodeUnknownOption(SavedShell)(stored),
			(record) => record.protocolVersion === WS_PROTOCOL_VERSION,
		),
	);

let database: Promise<IDBDatabase> | undefined;

const open = (): Promise<IDBDatabase> =>
	(database ??= new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE, 2);
		request.onupgradeneeded = () => {
			const db = request.result;
			// Version 1 kept one record per project.
			if (db.objectStoreNames.contains("projects"))
				db.deleteObjectStore("projects");
			db.createObjectStore(STORE);
		};
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => {
				db.close();
				database = undefined;
			};
			resolve(db);
		};
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(request.error);
	}));

const transact = <T>(
	work: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T | undefined> =>
	open()
		.then(
			(db) =>
				new Promise<T | undefined>((resolve, reject) => {
					const transaction = db.transaction(STORE, "readwrite");
					transaction.oncomplete = () => resolve(undefined);
					transaction.onabort = () => reject(transaction.error);
					work(transaction.objectStore(STORE), resolve);
				}),
		)
		.catch(() => undefined);

/** Read in time or open cold. Drop invalid records. */
export const openSavedShell = (): Promise<SavedShell | undefined> =>
	Promise.race([
		transact<SavedShell>((store, done) => {
			const get = store.get(KEY);
			get.onsuccess = () => {
				if (get.result === undefined) return;
				const record = decode(get.result);
				if (record === undefined) {
					store.delete(KEY);
					return;
				}
				// The saved rows are the last answer the server sent, activity included; the
				// live snapshot replaces them.
				done(record);
			};
		}),
		new Promise<undefined>((resolve) => setTimeout(resolve, READ_WAIT_MS)),
	]);

/** Save the applied shell rows unless another tab saved newer ones. */
export const saveShell = (rows: readonly SessionInfo[]): Promise<void> => {
	const savedAt = Date.now();
	return transact<void>((store) => {
		const record = Schema.encodeSync(SavedShell)({
			schema: 2,
			protocolVersion: WS_PROTOCOL_VERSION,
			savedAt,
			rows,
		});
		const get = store.get(KEY);
		get.onsuccess = () => {
			const existing = decode(get.result);
			if (existing === undefined || existing.savedAt <= savedAt)
				store.put(record, KEY);
		};
	});
};
