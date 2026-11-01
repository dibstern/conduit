/**
 * The 2.1 rows 25scs lands (CONTRACT.md 2.1), for 32.2.17's replay differential to mask: each
 * names the unit that changes and what it does differently from main. Rows 203, 204 and 214
 * are deleted, so they change nothing.
 */
export const landedUnitRows = [
	{
		row: 202,
		unit: "markRunning",
		change:
			"a start is not claimed while the fence holds; the intake recall's processing-timeout deadline is deleted",
	},
	{
		row: 212,
		unit: "markRunning",
		change:
			"a direct send at 5 transmissions fails its input (provider_send_attempts_exhausted) instead of sending again",
	},
	{
		row: 206,
		unit: "requeueFailedSteers",
		change:
			"a steer the view reads as possibly reached is placed as its message once its Run is no longer active, never returned to the inbox",
	},
	{
		row: 207,
		unit: "requeueFailedSteers",
		change:
			"with { cancelFinal: true } (commitAndSignal), a steer the view marks failed gets input.cancelled after input.requeued in the same batch; recordSendReply writes the permanent outcome a direct steer's refused send needs for that",
	},
	{
		row: 210,
		unit: "recordSendReply",
		change:
			"a declined start that is not a steer is written retryable_failed with main's backoff instead of ending interrupted",
	},
	{
		row: 211,
		unit: "recordSendReply",
		change:
			"a start Claude reports cancelled before started is returned to the inbox (input.requeued) in the same write",
	},
	{
		row: 213,
		unit: "ProviderTurnService.abort",
		change:
			"the deadline step's retireProcess is skipped while the view's tasks are live or unknown",
	},
] as const satisfies readonly {
	readonly row: number;
	readonly unit: string;
	readonly change: string;
}[];
