// Display-only sidebar rows. Storage failures and incompatible records cost a
// cold sidebar; these rows are never a shell subscription's resume base.
import { Option, Schema } from "effect";
import { BUILD_ID } from "../../build-id.js";
import { SessionInfoSchema } from "../../contracts/ws-rpc.js";
import { WS_PROTOCOL_VERSION } from "../../shared-types.js";
import type { SessionInfo } from "../types.js";

const DATABASE = "conduit-saved-shell";
const STORE = "projects";
const KEEP = 5;
const READ_WAIT_MS = 150;

const SavedShell = Schema.Struct({
	schema: Schema.Literal(1),
	project: Schema.String,
	buildId: Schema.String,
	protocolVersion: Schema.Number,
	savedAt: Schema.Number,
	rows: Schema.Array(SessionInfoSchema),
});
export type SavedShell = typeof SavedShell.Type;

const decode = (stored: unknown): SavedShell | undefined =>
	Option.getOrUndefined(
		Option.filter(
			Schema.decodeUnknownOption(SavedShell)(stored),
			(record) =>
				record.buildId === BUILD_ID &&
				record.protocolVersion === WS_PROTOCOL_VERSION &&
				record.rows.every((row) => row.projectSlug === record.project),
		),
	);

let database: Promise<IDBDatabase> | undefined;

const open = (): Promise<IDBDatabase> =>
	(database ??= new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE, 1);
		request.onupgradeneeded = () =>
			request.result
				.createObjectStore(STORE, { keyPath: "project" })
				.createIndex("savedAt", "savedAt");
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

/** Read in time or open cold. Drop invalid records, and remove runtime liveness. */
export const openSavedShell = (
	project: string,
): Promise<SavedShell | undefined> =>
	Promise.race([
		transact<SavedShell>((store, done) => {
			const get = store.get(project);
			get.onsuccess = () => {
				if (get.result === undefined) return;
				const record = decode(get.result);
				if (record === undefined || record.project !== project) {
					store.delete(project);
					return;
				}
				done({
					...record,
					rows: record.rows.map((row) => ({
						...row,
						status:
							row.status === "busy" || row.status === "retry"
								? "idle"
								: row.status,
						processing: false,
						compacting: undefined,
						retrying: undefined,
						backgroundWork: undefined,
						backgroundTasks: undefined,
						attention:
							row.attention === "working" || row.attention === "monitoring"
								? row.unread
									? "done-unread"
									: "idle"
								: row.attention,
					})),
				});
			};
		}),
		new Promise<undefined>((resolve) => setTimeout(resolve, READ_WAIT_MS)),
	]);

/** Save only the attached project's applied shell rows, keeping the newest five. */
export const saveShell = (
	project: string,
	rows: readonly SessionInfo[],
): Promise<void> => {
	const savedAt = Date.now();
	return transact<void>((store) => {
		const record = Schema.encodeSync(SavedShell)({
			schema: 1,
			project,
			buildId: BUILD_ID,
			protocolVersion: WS_PROTOCOL_VERSION,
			savedAt,
			rows: rows.filter((row) => row.projectSlug === project),
		});
		const get = store.get(project);
		get.onsuccess = () => {
			const existing = decode(get.result);
			if (existing !== undefined && existing.savedAt > savedAt) return;
			store.put(record);
			const keys = store.index("savedAt").getAllKeys();
			keys.onsuccess = () => {
				for (const key of keys.result.slice(0, -KEEP)) store.delete(key);
			};
		};
	});
};
