import { Schema } from "effect";

export const ACCOUNT_COLOR_SLOT_COUNT = 6;
export const AccountColorSlotSchema = Schema.Number.pipe(
	Schema.check(Schema.isInt()),
	Schema.check(
		Schema.isBetween({ minimum: 0, maximum: ACCOUNT_COLOR_SLOT_COUNT - 1 }),
	),
);
