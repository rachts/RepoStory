/**
 * Cleans raw LLM response text before JSON parsing:
 * 1. Strips Markdown code fences (```json ... ``` or ``` ... ```)
 * 2. Trims leading/trailing whitespace
 * 3. If JSON.parse still fails, extracts substring from the first '{' to the last '}'
 */
export function sanitizeJsonResponse(text: string): string {
  if (typeof text !== "string") return "";
  let cleaned = text.trim();

  // If directly valid JSON, return as is
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    // Proceed to fence stripping and brace extraction
  }

  // Strip Markdown code fences if present anywhere in the string
  const fenceRegex = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```/;
  const match = fenceRegex.exec(cleaned);
  if (match && match[1]) {
    const insideFence = match[1].trim();
    try {
      JSON.parse(insideFence);
      return insideFence;
    } catch {
      cleaned = insideFence;
    }
  }

  // Extract substring from first { to last }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = cleaned.slice(firstBrace, lastBrace + 1).trim();
    return candidate;
  }

  return cleaned;
}
