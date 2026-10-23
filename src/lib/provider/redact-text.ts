const PRIVATE_HOME = /\/Users\/[^/\s"\\]+|\/home\/(?!test\b)[^/\s"\\]+/g;
const SECRET_ASSIGNMENT =
	/\b((?:[\w-]+[_-])?(?:(?:api|access|private)[_-]?key|authorization|(?:access|refresh|session)[_-]?token|token|password|secret|(?:blob)?encryption[_-]?key|email|pin|cookie)["']?\s*[:=]\s*)(?:\[REDACTED(?::[^\]]*)?\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*|[^\s,;}\]]+)/gi;

/** Scrub transcript strings before bounding them, so truncation cannot expose a secret's tail. */
export const redactText = (value: string): string =>
	value
		.replace(PRIVATE_HOME, "/home/test")
		.replace(
			/\b((?:authorization|cookie)["']?\s*[:=]\s*)[^\r\n]*/gi,
			"$1[REDACTED]",
		)
		.replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
