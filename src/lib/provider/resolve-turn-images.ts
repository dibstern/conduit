import { Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import type { AttachmentRef } from "../contracts/attachment-ref.js";
import {
	AttachmentMissing,
	type AttachmentStore,
} from "../persistence/attachment-store.js";

/** Durable commands keep refs; only the adapter boundary receives bytes. */
export const resolveTurnImages = <
	T extends { readonly images?: readonly AttachmentRef[] },
>(
	input: T,
	store?: Pick<AttachmentStore, "get">,
): Effect.Effect<
	Omit<T, "images"> & {
		readonly images?: readonly {
			readonly ref: AttachmentRef;
			readonly dataUrl: string;
		}[];
	},
	AttachmentMissing | SqlError
> =>
	Effect.gen(function* () {
		const { images, ...rest } = input;
		if (images === undefined) return rest;
		const resolved = yield* Effect.forEach(images, (ref) =>
			Effect.gen(function* () {
				if (!store)
					return yield* new AttachmentMissing({ hash: ref.attachmentHash });
				const blob = yield* store.get(ref.attachmentHash);
				const name =
					ref.name === undefined ? "" : `;name=${encodeURIComponent(ref.name)}`;
				return {
					ref,
					dataUrl: `data:${blob.mime}${name};base64,${Buffer.from(blob.bytes).toString("base64")}`,
				};
			}),
		);
		return { ...rest, images: resolved };
	});
