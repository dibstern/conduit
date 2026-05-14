import { Context } from "effect";
import type { OpenCodeAPI } from "../../../instance/opencode-api.js";

export class OpenCodeAPITag extends Context.Tag("OpenCodeAPI")<
	OpenCodeAPITag,
	OpenCodeAPI
>() {}
