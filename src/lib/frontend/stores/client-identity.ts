let browserClientId: string | undefined;

export function getBrowserClientId(): string {
	if (!browserClientId) {
		browserClientId = crypto.randomUUID();
	}
	return browserClientId;
}

export function isOwnBrowserClientId(originId: string | undefined): boolean {
	return originId !== undefined && originId === getBrowserClientId();
}
