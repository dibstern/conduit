import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempEventsDbPath(): string {
	return join(mkdtempSync(join(tmpdir(), "conduit-test-db-")), "events.db");
}
