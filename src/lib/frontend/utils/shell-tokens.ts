export type ShellToken = {
	text: string;
	kind:
		| "command"
		| "flag"
		| "string"
		| "variable"
		| "operator"
		| "heredoc"
		| "comment"
		| "plain";
};

/** A display tokenizer, preserving shell source verbatim without interpreting it. */
export function shellTokens(source: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
	const lines = source.split("\n");
	for (const [index, line] of lines.entries()) {
		if (index > 0) tokens.push({ text: "\n", kind: "plain" });
		const here = heredocs[0];
		if (here) {
			const end =
				(here.stripTabs ? line.replace(/^\t+/, "") : line).replace(
					/\r$/,
					"",
				) === here.delimiter;
			tokens.push({ text: line, kind: end ? "heredoc" : "plain" });
			if (end) heredocs.shift();
			continue;
		}
		let expectCommand = true;
		let wordKind: ShellToken["kind"] | undefined;
		let pendingHere: boolean | undefined;
		const pattern =
			/([ \t\r]+)|('[^']*'?|"(?:\\.|[^"\\])*"?)|(\$\{[^}]*\}?|\$[A-Za-z_][\w]*)|(&&|\|\||\||;|<<-?|\d?>>?|<)|(#.*$)|([^\s'"|;&<>$]+)|([\s\S])/g;
		for (const match of line.matchAll(pattern)) {
			const [text, space, string, variable, operator, comment] = match;
			let kind: ShellToken["kind"] = "plain";
			if (space) {
				wordKind = undefined;
			} else if (pendingHere !== undefined) {
				heredocs.push({
					delimiter: text.replace(/['"]/g, ""),
					stripTabs: pendingHere,
				});
				pendingHere = undefined;
				kind = "heredoc";
				wordKind = "plain";
			} else if (operator) {
				kind = "operator";
				wordKind = undefined;
				if (/^(&&|\|\||\||;)$/.test(text)) expectCommand = true;
				if (text.startsWith("<<")) pendingHere = text === "<<-";
			} else if (comment) {
				kind = "comment";
			} else {
				if (wordKind === undefined) {
					const assignment = expectCommand && /^[A-Za-z_][\w]*=/.exec(text);
					if (assignment) {
						const name = assignment[0].slice(0, -1);
						tokens.push(
							{ text: name, kind: "variable" },
							{ text: "=", kind: "operator" },
						);
						if (text.length > name.length + 1)
							tokens.push({ text: text.slice(name.length + 1), kind: "plain" });
						wordKind = "plain";
						continue;
					}
					wordKind = expectCommand
						? "command"
						: text.startsWith("-")
							? "flag"
							: "plain";
					expectCommand = false;
				}
				kind = string ? "string" : variable ? "variable" : wordKind;
			}
			tokens.push({ text, kind });
		}
	}
	return tokens;
}
