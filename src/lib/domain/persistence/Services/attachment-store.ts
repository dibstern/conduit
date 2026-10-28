import { Context, Layer } from "effect";
import {
	type AttachmentStore,
	makeAttachmentStore,
} from "../../../persistence/attachment-store.js";

export class AttachmentStoreTag extends Context.Service<
	AttachmentStoreTag,
	AttachmentStore
>()("AttachmentStore") {}

export const AttachmentStoreLive = Layer.effect(
	AttachmentStoreTag,
	makeAttachmentStore,
);
