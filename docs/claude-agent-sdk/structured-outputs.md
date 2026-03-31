# Get structured output from agents

> Source: https://platform.claude.com/docs/en/agent-sdk/structured-outputs
> Extracted: 2026-03-31

Return validated JSON from agent workflows using JSON Schema, Zod, or Pydantic. Get type-safe, structured data after multi-turn tool use.

---

Structured outputs let you define the exact shape of data you want back from an agent. The agent can use any tools it needs to complete the task, and you still get validated JSON matching your schema at the end.

## Quick start

Define a JSON Schema describing the shape of data you want, then pass it to `query()` via `outputFormat` (TypeScript) or `output_format` (Python):

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const schema = {
  type: "object",
  properties: {
    company_name: { type: "string" },
    founded_year: { type: "number" },
    headquarters: { type: "string" }
  },
  required: ["company_name"]
};

for await (const message of query({
  prompt: "Research Anthropic and provide key company information",
  options: {
    outputFormat: { type: "json_schema", schema: schema }
  }
})) {
  if (message.type === "result" && message.structured_output) {
    console.log(message.structured_output);
  }
}
```

## Type-safe schemas with Zod and Pydantic

Instead of writing JSON Schema by hand, use Zod (TypeScript) or Pydantic (Python):

```typescript
import { z } from "zod";

const FeaturePlan = z.object({
  feature_name: z.string(),
  summary: z.string(),
  steps: z.array(z.object({
    step_number: z.number(),
    description: z.string(),
    estimated_complexity: z.enum(["low", "medium", "high"])
  })),
  risks: z.array(z.string())
});

const schema = z.toJSONSchema(FeaturePlan);
```

```python
from pydantic import BaseModel

class Step(BaseModel):
    step_number: int
    description: str
    estimated_complexity: str

class FeaturePlan(BaseModel):
    feature_name: str
    summary: str
    steps: list[Step]
    risks: list[str]

# Use: output_format={"type": "json_schema", "schema": FeaturePlan.model_json_schema()}
```

## Output format configuration

- `type`: Set to `"json_schema"` for structured outputs
- `schema`: A JSON Schema object (generate from Zod with `z.toJSONSchema()` or Pydantic with `.model_json_schema()`)

## Error handling

| Subtype | Meaning |
|---------|---------|
| `success` | Output was generated and validated successfully |
| `error_max_structured_output_retries` | Agent couldn't produce valid output after multiple attempts |

Tips for avoiding errors:
- **Keep schemas focused.** Deeply nested schemas are harder to satisfy.
- **Match schema to task.** Make fields optional if the task might not have all info.
- **Use clear prompts.** Ambiguous prompts make it harder for the agent.

## Related resources

- [Custom tools](./custom-tools.md)
