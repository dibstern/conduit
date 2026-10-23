import type { Page } from "@playwright/test";

/** What a test needs to know of one saved transcript record. */
export interface SavedSummary {
	readonly project: unknown;
	readonly sequence: unknown;
	readonly resumePoint: unknown;
}

/**
 * Every saved transcript in the page's browser context, by session id. Never
 * creates the database: opening one that does not exist yet would make it
 * without its store, and the app could then never save.
 */
export const savedTranscripts = (
	page: Page,
): Promise<Record<string, SavedSummary>> =>
	page.evaluate(async () => {
		const name = "conduit-saved-transcripts";
		if (!(await indexedDB.databases()).some((db) => db.name === name))
			return {};
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(name);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			if (!db.objectStoreNames.contains("transcripts")) return {};
			const records = await new Promise<unknown[]>((resolve, reject) => {
				const all = db
					.transaction("transcripts")
					.objectStore("transcripts")
					.getAll();
				all.onsuccess = () => resolve(all.result);
				all.onerror = () => reject(all.error);
			});
			const field = (record: object, key: string): unknown =>
				Reflect.get(record, key);
			return Object.fromEntries(
				records.flatMap((record) => {
					if (typeof record !== "object" || record === null) return [];
					const snapshot = field(record, "snapshot");
					const of = (key: string) =>
						typeof snapshot === "object" && snapshot !== null
							? field(snapshot, key)
							: undefined;
					return [
						[
							String(field(record, "sessionId")),
							{
								project: field(record, "project"),
								sequence: of("sequence"),
								resumePoint: of("resumePoint"),
							},
						],
					];
				}),
			);
		} finally {
			db.close();
		}
	});
