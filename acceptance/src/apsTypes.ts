export type ApsStep = {
	keyword: "Given" | "When" | "Then" | "And";
	text: string;
	parameters?: string[];
};

export type ApsScenario = {
	name: string;
	steps: ApsStep[];
	examples: Record<string, string>[];
};

export type ApsFeature = {
	name: string;
	background?: ApsStep[];
	scenarios: ApsScenario[];
};
