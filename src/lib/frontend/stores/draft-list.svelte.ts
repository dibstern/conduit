import type { DraftListItem } from "../../contracts/ws-rpc.js";

/** Each daemon frame replaces the complete list, including after reconnect. */
export const draftList = $state({ rows: [] as readonly DraftListItem[] });
