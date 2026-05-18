import {
	ClaudeEventTranslator,
	type ClaudeEventTranslatorDeps,
} from "./claude-event-translator.js";

export class ClaudeTranslationService extends ClaudeEventTranslator {}

export type ClaudeTranslationServiceDeps = ClaudeEventTranslatorDeps;

export const makeClaudeTranslationService = (
	deps: ClaudeTranslationServiceDeps,
): ClaudeTranslationService => new ClaudeTranslationService(deps);
