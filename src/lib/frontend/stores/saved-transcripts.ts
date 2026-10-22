// Saved transcripts (conduit-test-y7eo.14): the first page of the 20 most
// recently opened sessions, kept in IndexedDB so a page load can draw a
// session before the server answers. A saved page is provisional; the
// subscription resumes from it and the server's checksum confirms it or a
// fresh snapshot replaces it.
//
// How this can fail, and what each failure must cost (always a cold open,
// never an error the user sees):
// - IndexedDB is missing, refuses to open (private browsing), or is blocked:
//   every call resolves to "no record" and every write is dropped.
// - IndexedDB never answers (a WebKit bug can leave an open or a transaction
//   pending forever): a read gives up after READ_WAIT_MS as "no record", so
//   it never holds up the first subscribe.
// - A write exceeds the quota or the transaction aborts: the old record, if
//   any, stays as it was; a transaction is all or nothing.
// - A record from another protocol or schema version, or one that no longer
//   decodes: deleted on read, never drawn.
// - A record from another build: drawn, since its protocol and schema still
//   match. The server refuses a point from another build and its snapshot
//   replaces the page, so a deploy costs one snapshot, not a cold open.
// - A record from another store (reset, fresh install): the server refuses
//   its resume point and sends a fresh snapshot, which replaces it.
// - A store restored from a backup: the server sends a snapshot older than
//   the record. Only the snapshot this view opened from may be replaced by
//   an older one, so a stale tab cannot roll a newer record back.
// - Two tabs writing one session: each write replaces only an older record,
//   inside one transaction, so the newest snapshot wins.
// - A snapshot followed by changes before it synchronized: not saved, since
//   the record must be exactly what the server sent at one version.

import { Option, Schema } from "effect";
import {
	type ResumePoint,
	SessionDetailEnvelopeSchema,
} from "../../contracts/ws-rpc.js";
import { WS_PROTOCOL_VERSION } from "../../shared-types.js";

const DATABASE = "conduit-saved-transcripts";
const STORE = "transcripts";
// Recency only ({ sessionId, openedAt }): an open touches this small row, never
// the page. The page row stays the only truth about what was saved.
const META = "meta";
const KEEP = 20;
const READ_WAIT_MS = 150;

const SavedSnapshot = SessionDetailEnvelopeSchema.members[0];
export type SavedSnapshot = typeof SavedSnapshot.Type;

/** One session's record, keyed by its id alone: ids are globally unique. */
const SavedTranscript = Schema.Struct({
	schema: Schema.Literal(1),
	sessionId: Schema.String,
	project: Schema.String,
	protocolVersion: Schema.Number,
	openedAt: Schema.Number,
	snapshot: SavedSnapshot,
});
export type SavedTranscript = typeof SavedTranscript.Type;

const decode = (stored: unknown): SavedTranscript | undefined =>
	Option.getOrUndefined(
		Option.filter(
			Schema.decodeUnknownOption(SavedTranscript)(stored),
			(record) =>
				record.protocolVersion === WS_PROTOCOL_VERSION &&
				record.snapshot.resumePoint !== undefined,
		),
	);

let database: Promise<IDBDatabase> | undefined;

const open = (): Promise<IDBDatabase> =>
	(database ??= new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE, 2);
		request.onupgradeneeded = () => {
			const db = request.result;
			// These pages are a cache. Drop v1 rather than migrating large snapshots.
			if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
			db.createObjectStore(STORE, { keyPath: "sessionId" });
			db.createObjectStore(META, { keyPath: "sessionId" }).createIndex(
				"openedAt",
				"openedAt",
			);
		};
		request.onsuccess = () => {
			const db = request.result;
			// Another tab upgrading the database: let it, and reopen next time.
			db.onversionchange = () => {
				db.close();
				database = undefined;
			};
			resolve(db);
		};
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(request.error);
	}));

// Overlap the database open with module evaluation and transport startup.
// Private browsing throws on merely reading `indexedDB`; the app must still load.
try {
	if (typeof indexedDB !== "undefined") void open().catch(() => undefined);
} catch {
	// Storage refused: every open is cold.
}

/**
 * Runs `work` in one transaction. Resolves with what `work` hands
 * to `done`, as soon as it does, so a later abort (over quota) cannot take
 * back a read; otherwise once the transaction commits.
 */
const transact = <T>(
	mode: IDBTransactionMode,
	work: (transaction: IDBTransaction, done: (value: T) => void) => void,
): Promise<T | undefined> =>
	open()
		.then(
			(db) =>
				new Promise<T | undefined>((resolve, reject) => {
					const transaction = db.transaction([STORE, META], mode);
					transaction.oncomplete = () => resolve(undefined);
					transaction.onabort = () => reject(transaction.error);
					work(transaction, resolve);
				}),
		)
		.catch(() => undefined);

/** The session's saved page, if it is still usable and read in time; marks
 *  it opened. */
export const openSavedTranscript = (
	sessionId: string,
): Promise<SavedTranscript | undefined> =>
	Promise.race([
		readSavedTranscript(sessionId),
		new Promise<undefined>((resolve) => setTimeout(resolve, READ_WAIT_MS)),
	]);

const readSavedTranscript = (
	sessionId: string,
): Promise<SavedTranscript | undefined> =>
	transact<SavedTranscript>("readonly", (transaction, done) => {
		const store = transaction.objectStore(STORE);
		const get = store.get(sessionId);
		get.onsuccess = () => {
			const stored: unknown = get.result;
			if (typeof stored !== "object" || stored === null) return;
			const record = decode(stored);
			if (record === undefined) {
				void transact<void>("readwrite", (cleanup) => {
					const pages = cleanup.objectStore(STORE);
					const current = pages.get(sessionId);
					current.onsuccess = () => {
						// A newer valid save may have landed since the readonly get.
						if (decode(current.result) !== undefined) return;
						pages.delete(sessionId);
						cleanup.objectStore(META).delete(sessionId);
					};
				});
				return;
			}
			done(record);
			// A touch writes only the small recency row, after the read resolves.
			void transact<void>("readwrite", (touch) => {
				const key = touch.objectStore(STORE).getKey(sessionId);
				key.onsuccess = () => {
					// An evicted page must not come back as an orphan recency row.
					if (key.result !== undefined)
						touch.objectStore(META).put({ sessionId, openedAt: Date.now() });
				};
			});
		};
	});

/**
 * Save the snapshot a view synchronized on. It replaces a record only when
 * that record is older, unusable, filed under another project, or the one
 * this view opened from (`openedFrom`), which a restored store may answer
 * with an older snapshot.
 */
export const saveTranscript = (
	sessionId: string,
	project: string,
	snapshot: SavedSnapshot,
	openedFrom: ResumePoint | undefined,
): Promise<void> =>
	snapshot.resumePoint === undefined
		? Promise.resolve()
		: transact<void>("readwrite", (transaction) => {
				const store = transaction.objectStore(STORE);
				const meta = transaction.objectStore(META);
				const record: SavedTranscript = {
					schema: 1,
					sessionId,
					project,
					protocolVersion: WS_PROTOCOL_VERSION,
					openedAt: Date.now(),
					snapshot,
				};
				const get = store.get(sessionId);
				get.onsuccess = () => {
					const existing = decode(get.result);
					if (
						existing !== undefined &&
						existing.project === project &&
						existing.snapshot.sequence >= snapshot.sequence &&
						existing.snapshot.resumePoint !== openedFrom
					)
						return;
					store.put(Schema.encodeSync(SavedTranscript)(record));
					meta.put({ sessionId, openedAt: record.openedAt });
					// Oldest first: everything before the newest KEEP goes.
					const keys = meta.index("openedAt").getAllKeys();
					keys.onsuccess = () => {
						for (const key of keys.result.slice(0, -KEEP)) {
							store.delete(key);
							meta.delete(key);
						}
					};
				};
			});

/** Drop the session's saved page: the server has disowned it. */
export const forgetTranscript = (sessionId: string): Promise<void> =>
	transact<void>("readwrite", (transaction) => {
		transaction.objectStore(STORE).delete(sessionId);
		transaction.objectStore(META).delete(sessionId);
	});
