import { describe, expect, it } from "vitest";
import { sanitizeJsonResponse } from "@/domain/sanitize-json-response";

describe("sanitizeJsonResponse", () => {
  it("passes through valid unfenced JSON unchanged", () => {
    const raw = '{"projectSummary": {"title": "Test"}}';
    const cleaned = sanitizeJsonResponse(raw);
    expect(cleaned).toBe('{"projectSummary": {"title": "Test"}}');
    expect(JSON.parse(cleaned)).toEqual({ projectSummary: { title: "Test" } });
  });

  it("strips markdown code fence with json language tag", () => {
    const raw = "```json\n{\n  \"projectSummary\": {\"title\": \"Test\"}\n}\n```";
    const cleaned = sanitizeJsonResponse(raw);
    expect(JSON.parse(cleaned)).toEqual({ projectSummary: { title: "Test" } });
  });

  it("strips markdown code fence without language tag", () => {
    const raw = "```\n{\n  \"projectSummary\": {\"title\": \"Test\"}\n}\n```";
    const cleaned = sanitizeJsonResponse(raw);
    expect(JSON.parse(cleaned)).toEqual({ projectSummary: { title: "Test" } });
  });

  it("extracts JSON with conversational prose before and after", () => {
    const raw = "Here is the architectural explanation in JSON format:\n\n```json\n{\"projectSummary\": {\"title\": \"Test\"}}\n```\n\nI hope this helps your understanding!";
    const cleaned = sanitizeJsonResponse(raw);
    expect(JSON.parse(cleaned)).toEqual({ projectSummary: { title: "Test" } });
  });

  it("extracts JSON with prose before and after without fences", () => {
    const raw = "Here is the result: {\"projectSummary\": {\"title\": \"Test\"}} Have a nice day!";
    const cleaned = sanitizeJsonResponse(raw);
    expect(JSON.parse(cleaned)).toEqual({ projectSummary: { title: "Test" } });
  });

  it("correctly handles nested braces inside strings", () => {
    const raw = '```json\n{"message": "nested {brace} inside string", "projectSummary": {"title": "Test"}}\n```';
    const cleaned = sanitizeJsonResponse(raw);
    expect(JSON.parse(cleaned)).toEqual({
      message: "nested {brace} inside string",
      projectSummary: { title: "Test" },
    });
  });

  it("returns invalid input such that JSON.parse still fails on truly invalid input", () => {
    const raw = "This is plain text with no json structure at all.";
    const cleaned = sanitizeJsonResponse(raw);
    expect(() => JSON.parse(cleaned)).toThrow();
  });
});
