import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export const indexedAttachmentColumns = [
	"events.data",
	"messages.rest_payload",
	"message_parts.metadata",
	"message_parts.rest_payload",
	"pending_inputs.request",
	"pending_inputs.images",
	"provider_command_outbox.payload_json",
] as const;

/** Returns violations so later migration and E2E artifacts can record the evidence. */
export const assertAttachmentCatalogue = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const columns = yield* sql<{
		table_name: string;
		column_name: string;
	}>`SELECT m.name AS table_name, p.name AS column_name
		FROM sqlite_master m JOIN pragma_table_info(m.name) p
		WHERE m.type = 'table' AND upper(p.type) = 'TEXT' ORDER BY m.name, p.cid`;
	const violations: string[] = [];
	for (const { table_name, column_name } of columns) {
		const qualified = `${table_name}.${column_name}`;
		if (indexedAttachmentColumns.some((column) => column === qualified))
			continue;
		const rows =
			yield* sql`SELECT 1 FROM ${sql(table_name)} WHERE instr(${sql(column_name)}, '"attachmentHash"') > 0 LIMIT 1`;
		if (rows.length > 0) violations.push(qualified);
	}
	return violations;
});
