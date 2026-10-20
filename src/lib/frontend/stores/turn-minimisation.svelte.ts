// Each turn has one choice across its hand-back segments. Storage is optional.
const choices = new Map<string, boolean | undefined>();
let revision = $state(0);
const keyFor = (sessionId: string | undefined, turnId: string) =>
	`surfacing-turn-minimised:${JSON.stringify([sessionId ?? "", turnId])}`;

export function turnMinimised(
	sessionId: string | undefined,
	turnId: string,
): boolean | undefined {
	void revision;
	const key = keyFor(sessionId, turnId);
	if (!choices.has(key)) {
		let value: boolean | undefined;
		try {
			const stored = localStorage.getItem(key);
			value = stored === "true" ? true : stored === "false" ? false : undefined;
		} catch {
			/* Keep the setting when storage is unavailable. */
		}
		choices.set(key, value);
	}
	return choices.get(key);
}

export function setTurnMinimised(
	sessionId: string | undefined,
	turnId: string,
	minimised: boolean | null,
): void {
	const key = keyFor(sessionId, turnId);
	choices.set(key, minimised ?? undefined);
	revision++;
	try {
		if (minimised === null) localStorage.removeItem(key);
		else localStorage.setItem(key, String(minimised));
	} catch {
		/* Retain the choice in memory. */
	}
}
