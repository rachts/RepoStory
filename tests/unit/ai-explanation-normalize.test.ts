import { describe, expect, it } from "vitest";
import { normalizeProjectExplanation } from "@/domain/ai-explanation-normalize";
import { projectExplanationSchema } from "@/domain/ai-explanation";

describe("normalizeProjectExplanation", () => {
  const validBase = {
    projectSummary: {
      title: "WeatherGPT Service",
      oneSentence: "A Next.js weather chatbot service.",
      plainEnglish: "Provides weather forecasting via natural language chat.",
      evidenceIds: ["ev-summary"],
      confidence: "high",
    },
    architectureAtAGlance: {
      plainEnglish: "Three tiers connecting App Router to external APIs.",
      layers: [
        {
          name: "API Routes",
          simpleName: "API Routes",
          purpose: "Handles client chat requests.",
          components: ["chat/route.ts"],
          evidenceIds: ["ev-route"],
          confidence: "high",
        },
      ],
      evidenceIds: ["ev-arch"],
    },
    mainComponents: [
      {
        name: "Chat Handler",
        simpleName: "Chat Handler",
        whatItDoes: "Streams chat responses.",
        whyItMatters: "Core user experience.",
        location: "app/api/chat/route.ts",
        evidenceIds: ["ev-comp"],
        confidence: "high",
      },
    ],
    howTheSystemWorks: [
      {
        step: 1,
        title: "Send chat message",
        plainEnglish: "User types a city name.",
        technicalDetail: "POST /api/chat with user payload.",
        evidenceIds: ["ev-step"],
        confidence: "high",
      },
    ],
    userJourney: [
      {
        step: 1,
        title: "Landing on page",
        plainEnglish: "User navigates to home view.",
        relatedRoutes: ["/"],
        relatedComponents: ["page.tsx"],
        evidenceIds: ["ev-journey"],
      },
    ],
    technologyGuide: [
      {
        technology: "Next.js",
        simpleName: "Next.js",
        whatItIs: "React full-stack framework.",
        roleInThisProject: "Hosts API routes and UI.",
        evidenceIds: ["ev-tech"],
        confidence: "high",
      },
    ],
    apiGuide: [
      {
        route: "/api/chat",
        method: "POST",
        simplePurpose: "Processes chat requests.",
        requestFlow: "Client POSTs to route.",
        evidenceIds: ["ev-api"],
        confidence: "high",
      },
    ],
    dataAndIntegrations: [
      {
        name: "OpenWeather",
        type: "external-service",
        simplePurpose: "Fetches weather data.",
        evidenceIds: ["ev-data"],
        confidence: "high",
      },
    ],
    securityAndAuthentication: {
      plainEnglish: "Public read routes with API key controls.",
      confirmedControls: ["Env vars"],
      unknowns: ["Auth headers"],
      evidenceIds: [],
      confidence: "medium",
    },
    glossary: [
      {
        technicalTerm: "App Router",
        simpleMeaning: "Next.js file-system routing.",
        projectSpecificMeaning: "Structures app/api/chat/route.ts.",
      },
    ],
    knownLimitations: ["Requires external API key"],
    confidenceNote: "Analysis derived strictly from static code findings.",
  };

  it("unwraps a single wrapper object (e.g. { explanation: { ... } })", () => {
    const wrapped = { explanation: validBase };
    const normalized = normalizeProjectExplanation(wrapped) as Record<string, unknown>;
    expect(normalized.projectSummary).toBeDefined();
    expect(projectExplanationSchema.safeParse(normalized).success).toBe(true);
  });

  it("truncates over-long strings at a word boundary", () => {
    const longText = "Word ".repeat(800); // 4000 characters
    const input = {
      ...validBase,
      projectSummary: {
        ...validBase.projectSummary,
        plainEnglish: longText,
      },
    };
    const normalized = normalizeProjectExplanation(input) as typeof validBase;
    expect(normalized.projectSummary.plainEnglish.length).toBeLessThanOrEqual(3000);
    expect(normalized.projectSummary.plainEnglish.endsWith(" ")).toBe(false);
    expect(projectExplanationSchema.safeParse(normalized).success).toBe(true);
  });

  it("caps array sizes according to schema limits", () => {
    const seventyComponents = Array.from({ length: 70 }, (_, i) => ({
      name: `Component ${i}`,
      simpleName: `Comp ${i}`,
      whatItDoes: "Does something useful.",
      whyItMatters: "Important for feature.",
      location: `src/comp${i}.ts`,
      evidenceIds: ["ev-1"],
      confidence: "high",
    }));

    const input = {
      ...validBase,
      mainComponents: seventyComponents,
    };
    const normalized = normalizeProjectExplanation(input) as typeof validBase;
    expect(normalized.mainComponents.length).toBe(60);
  });

  it("drops empty string entries from string arrays", () => {
    const input = {
      ...validBase,
      knownLimitations: ["First limit", "", "   ", "Second limit"],
    };
    const normalized = normalizeProjectExplanation(input) as typeof validBase;
    expect(normalized.knownLimitations).toEqual(["First limit", "Second limit"]);
  });

  it("drops array items with empty required fields", () => {
    const input = {
      ...validBase,
      mainComponents: [
        {
          name: "Valid Component",
          simpleName: "Valid",
          whatItDoes: "Works properly.",
          whyItMatters: "Vital component.",
          location: "src/valid.ts",
          evidenceIds: ["ev-1"],
          confidence: "high",
        },
        {
          name: "Broken Component",
          simpleName: "", // empty required field -> dropped!
          whatItDoes: "Missing simpleName",
          whyItMatters: "Should be dropped",
          location: "src/broken.ts",
          evidenceIds: ["ev-1"],
          confidence: "high",
        },
        {
          name: "Another Broken",
          simpleName: "Broken 2",
          whatItDoes: "   ", // whitespace only -> dropped!
          whyItMatters: "Should be dropped",
          location: "src/broken2.ts",
          evidenceIds: ["ev-1"],
          confidence: "high",
        },
      ],
    };
    const normalized = normalizeProjectExplanation(input) as typeof validBase;
    expect(normalized.mainComponents.length).toBe(1);
    expect(normalized.mainComponents[0]?.name).toBe("Valid Component");
  });

  it("fixes enum casing and defaults unknown enum values", () => {
    const input = {
      ...validBase,
      projectSummary: {
        ...validBase.projectSummary,
        confidence: "HIGH", // uppercase -> high
      },
      dataAndIntegrations: [
        {
          name: "Redis",
          type: "QUEUE", // uppercase -> queue
          simplePurpose: "Message caching",
          evidenceIds: ["ev-1"],
          confidence: "MODERATE", // moderate -> medium
        },
        {
          name: "External API",
          type: "unknown_custom_service", // invalid enum -> unknown
          simplePurpose: "External call",
          evidenceIds: ["ev-1"],
          confidence: "needs_verification", // underscore -> hyphen
        },
      ],
    };
    const normalized = normalizeProjectExplanation(input) as typeof validBase;
    expect(normalized.projectSummary.confidence).toBe("high");
    expect(normalized.dataAndIntegrations[0]?.type).toBe("queue");
    expect(normalized.dataAndIntegrations[0]?.confidence).toBe("medium");
    expect(normalized.dataAndIntegrations[1]?.type).toBe("unknown");
    expect(normalized.dataAndIntegrations[1]?.confidence).toBe("needs-verification");
  });

  it("clamps and coerces integer step numbers", () => {
    const input = {
      ...validBase,
      howTheSystemWorks: [
        {
          step: "1", // string -> 1
          title: "Step 1",
          plainEnglish: "First step",
          technicalDetail: "Detail 1",
          evidenceIds: ["ev-1"],
          confidence: "high",
        },
        {
          step: 0, // < 1 -> clamped to 1
          title: "Step 0",
          plainEnglish: "Zero step",
          technicalDetail: "Detail 0",
          evidenceIds: ["ev-1"],
          confidence: "high",
        },
        {
          step: 999, // > 50 -> clamped to 50
          title: "Step 999",
          plainEnglish: "Max step",
          technicalDetail: "Detail 999",
          evidenceIds: ["ev-1"],
          confidence: "high",
        },
      ],
    };
    const normalized = normalizeProjectExplanation(input) as typeof validBase;
    expect(normalized.howTheSystemWorks[0]?.step).toBe(1);
    expect(normalized.howTheSystemWorks[1]?.step).toBe(1);
    expect(normalized.howTheSystemWorks[2]?.step).toBe(50);
  });

  it("drops unknown keys from schema objects", () => {
    const input = {
      ...validBase,
      extraTopLevelField: "unwanted",
      projectSummary: {
        ...validBase.projectSummary,
        hallucinatedSummaryField: "unwanted",
      },
    };
    const normalized = normalizeProjectExplanation(input) as Record<string, unknown>;
    expect(normalized.extraTopLevelField).toBeUndefined();
    const summary = normalized.projectSummary as Record<string, unknown>;
    expect(summary.hallucinatedSummaryField).toBeUndefined();
    expect(projectExplanationSchema.safeParse(normalized).success).toBe(true);
  });

  it("defaults missing arrays to empty arrays", () => {
    const input = {
      ...validBase,
      technologyGuide: null,
      glossary: undefined,
      knownLimitations: null,
    };
    const normalized = normalizeProjectExplanation(input) as typeof validBase;
    expect(normalized.technologyGuide).toEqual([]);
    expect(normalized.glossary).toEqual([]);
    expect(normalized.knownLimitations).toEqual([]);
  });

  it("cleans evidence IDs: drops over-long (>256 chars) without character-truncating, dedupes, caps at 30", () => {
    const overLongId = "ev-".repeat(100); // 300 chars > 256
    const fortyIds = Array.from({ length: 40 }, (_, i) => `ev-id-${i}`);
    const input = {
      ...validBase,
      projectSummary: {
        ...validBase.projectSummary,
        evidenceIds: ["ev-valid", "ev-valid", overLongId, "", ...fortyIds],
      },
    };
    const normalized = normalizeProjectExplanation(input) as typeof validBase;
    const ids = normalized.projectSummary.evidenceIds;
    expect(ids).not.toContain(overLongId);
    expect(ids).not.toContain("");
    expect(ids.filter((id) => id === "ev-valid").length).toBe(1); // deduped
    expect(ids.length).toBeLessThanOrEqual(30); // capped at 30
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(256);
    }
  });

  it("never invents missing prose for required top-level fields (Zod stays authoritative)", () => {
    const input = {
      ...validBase,
      projectSummary: {
        ...validBase.projectSummary,
        oneSentence: "", // empty string
      },
    };
    const normalized = normalizeProjectExplanation(input) as typeof validBase;
    // Should NOT invent prose
    expect(normalized.projectSummary.oneSentence).toBe("");
    // Zod must fail closed
    const parsed = projectExplanationSchema.safeParse(normalized);
    expect(parsed.success).toBe(false);
  });
});
