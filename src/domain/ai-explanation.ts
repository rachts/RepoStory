import { z } from "zod";

const evidenceIdsSchema = z.array(z.string().trim().min(1).max(256)).max(30);
const confidenceSchema = z.enum(["high", "medium", "low", "needs-verification"]);
const boundedString = (max: number) => z.string().trim().min(1).max(max);
const boundedStringList = (maxItems: number, itemMax: number) => z.array(boundedString(itemMax)).max(maxItems);

const projectSummarySchema = z.object({
  title: boundedString(300),
  oneSentence: boundedString(1_000),
  plainEnglish: boundedString(3_000),
  evidenceIds: evidenceIdsSchema,
  confidence: confidenceSchema,
}).strict();

const architectureLayerSchema = z.object({
  name: boundedString(200),
  simpleName: boundedString(200),
  purpose: boundedString(1_500),
  components: boundedStringList(30, 300),
  evidenceIds: evidenceIdsSchema,
  confidence: confidenceSchema,
}).strict();

const architectureAtAGlanceSchema = z.object({
  plainEnglish: boundedString(3_000),
  layers: z.array(architectureLayerSchema).max(20),
  evidenceIds: evidenceIdsSchema,
}).strict();

const mainComponentSchema = z.object({
  name: boundedString(300),
  simpleName: boundedString(300),
  whatItDoes: boundedString(1_500),
  whyItMatters: boundedString(1_500),
  location: boundedString(500),
  evidenceIds: evidenceIdsSchema,
  confidence: confidenceSchema,
}).strict();

const systemStepSchema = z.object({
  step: z.number().int().min(1).max(50),
  title: boundedString(300),
  plainEnglish: boundedString(2_000),
  technicalDetail: boundedString(2_000),
  evidenceIds: evidenceIdsSchema,
  confidence: confidenceSchema,
}).strict();

const userJourneyStepSchema = z.object({
  step: z.number().int().min(1).max(50),
  title: boundedString(300),
  plainEnglish: boundedString(2_000),
  relatedRoutes: boundedStringList(20, 500),
  relatedComponents: boundedStringList(20, 300),
  evidenceIds: evidenceIdsSchema,
}).strict();

const technologyGuideItemSchema = z.object({
  technology: boundedString(300),
  simpleName: boundedString(300),
  whatItIs: boundedString(1_200),
  roleInThisProject: boundedString(1_500),
  evidenceIds: evidenceIdsSchema,
  confidence: confidenceSchema,
}).strict();

const apiGuideItemSchema = z.object({
  route: boundedString(500),
  method: boundedString(32),
  simplePurpose: boundedString(1_500),
  requestFlow: boundedString(2_000),
  evidenceIds: evidenceIdsSchema,
  confidence: confidenceSchema,
}).strict();

const dataIntegrationSchema = z.object({
  name: boundedString(300),
  type: z.enum(["database", "external-service", "storage", "queue", "unknown"]),
  simplePurpose: boundedString(1_500),
  evidenceIds: evidenceIdsSchema,
  confidence: confidenceSchema,
}).strict();

const securitySchema = z.object({
  plainEnglish: boundedString(2_500),
  confirmedControls: boundedStringList(30, 800),
  unknowns: boundedStringList(30, 800),
  evidenceIds: evidenceIdsSchema,
  confidence: confidenceSchema,
}).strict();

const glossaryItemSchema = z.object({
  technicalTerm: boundedString(200),
  simpleMeaning: boundedString(1_000),
  projectSpecificMeaning: boundedString(1_200),
}).strict();

export const projectExplanationSchema = z.object({
  projectSummary: projectSummarySchema,
  architectureAtAGlance: architectureAtAGlanceSchema,
  mainComponents: z.array(mainComponentSchema).max(60),
  howTheSystemWorks: z.array(systemStepSchema).max(30),
  userJourney: z.array(userJourneyStepSchema).max(30),
  technologyGuide: z.array(technologyGuideItemSchema).max(60),
  apiGuide: z.array(apiGuideItemSchema).max(100),
  dataAndIntegrations: z.array(dataIntegrationSchema).max(60),
  securityAndAuthentication: securitySchema,
  glossary: z.array(glossaryItemSchema).max(60),
  knownLimitations: boundedStringList(30, 1_000),
  confidenceNote: boundedString(2_000),
}).strict();

export type ProjectExplanation = z.infer<typeof projectExplanationSchema>;

export function unknownExplanationEvidenceIds(explanation: ProjectExplanation, allowedIds: ReadonlySet<string>): string[] {
  const ids = [
    ...explanation.projectSummary.evidenceIds,
    ...explanation.architectureAtAGlance.evidenceIds,
    ...explanation.architectureAtAGlance.layers.flatMap((item) => item.evidenceIds),
    ...explanation.mainComponents.flatMap((item) => item.evidenceIds),
    ...explanation.howTheSystemWorks.flatMap((item) => item.evidenceIds),
    ...explanation.userJourney.flatMap((item) => item.evidenceIds),
    ...explanation.technologyGuide.flatMap((item) => item.evidenceIds),
    ...explanation.apiGuide.flatMap((item) => item.evidenceIds),
    ...explanation.dataAndIntegrations.flatMap((item) => item.evidenceIds),
    ...explanation.securityAndAuthentication.evidenceIds,
  ];
  return [...new Set(ids)].filter((id) => !allowedIds.has(id));
}

/** Groq Structured Outputs accepts this strict JSON Schema subset. */
export const projectExplanationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "projectSummary",
    "architectureAtAGlance",
    "mainComponents",
    "howTheSystemWorks",
    "userJourney",
    "technologyGuide",
    "apiGuide",
    "dataAndIntegrations",
    "securityAndAuthentication",
    "glossary",
    "knownLimitations",
    "confidenceNote",
  ],
  properties: {
    projectSummary: {
      type: "object",
      additionalProperties: false,
      required: ["title", "oneSentence", "plainEnglish", "evidenceIds", "confidence"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 300 },
        oneSentence: { type: "string", minLength: 1, maxLength: 1000 },
        plainEnglish: { type: "string", minLength: 1, maxLength: 3000 },
        evidenceIds: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 256 } },
        confidence: { type: "string", enum: ["high", "medium", "low", "needs-verification"] },
      },
    },
    architectureAtAGlance: {
      type: "object",
      additionalProperties: false,
      required: ["plainEnglish", "layers", "evidenceIds"],
      properties: {
        plainEnglish: { type: "string", minLength: 1, maxLength: 3000 },
        layers: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "simpleName", "purpose", "components", "evidenceIds", "confidence"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 200 },
              simpleName: { type: "string", minLength: 1, maxLength: 200 },
              purpose: { type: "string", minLength: 1, maxLength: 1500 },
              components: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 300 } },
              evidenceIds: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 256 } },
              confidence: { type: "string", enum: ["high", "medium", "low", "needs-verification"] },
            },
          },
        },
        evidenceIds: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 256 } },
      },
    },
    mainComponents: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "simpleName", "whatItDoes", "whyItMatters", "location", "evidenceIds", "confidence"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 300 },
          simpleName: { type: "string", minLength: 1, maxLength: 300 },
          whatItDoes: { type: "string", minLength: 1, maxLength: 1500 },
          whyItMatters: { type: "string", minLength: 1, maxLength: 1500 },
          location: { type: "string", minLength: 1, maxLength: 500 },
          evidenceIds: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 256 } },
          confidence: { type: "string", enum: ["high", "medium", "low", "needs-verification"] },
        },
      },
    },
    howTheSystemWorks: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "title", "plainEnglish", "technicalDetail", "evidenceIds", "confidence"],
        properties: {
          step: { type: "integer", minimum: 1, maximum: 50 },
          title: { type: "string", minLength: 1, maxLength: 300 },
          plainEnglish: { type: "string", minLength: 1, maxLength: 2000 },
          technicalDetail: { type: "string", minLength: 1, maxLength: 2000 },
          evidenceIds: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 256 } },
          confidence: { type: "string", enum: ["high", "medium", "low", "needs-verification"] },
        },
      },
    },
    userJourney: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "title", "plainEnglish", "relatedRoutes", "relatedComponents", "evidenceIds"],
        properties: {
          step: { type: "integer", minimum: 1, maximum: 50 },
          title: { type: "string", minLength: 1, maxLength: 300 },
          plainEnglish: { type: "string", minLength: 1, maxLength: 2000 },
          relatedRoutes: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } },
          relatedComponents: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 300 } },
          evidenceIds: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 256 } },
        },
      },
    },
    technologyGuide: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["technology", "simpleName", "whatItIs", "roleInThisProject", "evidenceIds", "confidence"],
        properties: {
          technology: { type: "string", minLength: 1, maxLength: 300 },
          simpleName: { type: "string", minLength: 1, maxLength: 300 },
          whatItIs: { type: "string", minLength: 1, maxLength: 1200 },
          roleInThisProject: { type: "string", minLength: 1, maxLength: 1500 },
          evidenceIds: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 256 } },
          confidence: { type: "string", enum: ["high", "medium", "low", "needs-verification"] },
        },
      },
    },
    apiGuide: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["route", "method", "simplePurpose", "requestFlow", "evidenceIds", "confidence"],
        properties: {
          route: { type: "string", minLength: 1, maxLength: 500 },
          method: { type: "string", minLength: 1, maxLength: 32 },
          simplePurpose: { type: "string", minLength: 1, maxLength: 1500 },
          requestFlow: { type: "string", minLength: 1, maxLength: 2000 },
          evidenceIds: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 256 } },
          confidence: { type: "string", enum: ["high", "medium", "low", "needs-verification"] },
        },
      },
    },
    dataAndIntegrations: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type", "simplePurpose", "evidenceIds", "confidence"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 300 },
          type: { type: "string", enum: ["database", "external-service", "storage", "queue", "unknown"] },
          simplePurpose: { type: "string", minLength: 1, maxLength: 1500 },
          evidenceIds: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 256 } },
          confidence: { type: "string", enum: ["high", "medium", "low", "needs-verification"] },
        },
      },
    },
    securityAndAuthentication: {
      type: "object",
      additionalProperties: false,
      required: ["plainEnglish", "confirmedControls", "unknowns", "evidenceIds", "confidence"],
      properties: {
        plainEnglish: { type: "string", minLength: 1, maxLength: 2500 },
        confirmedControls: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 800 } },
        unknowns: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 800 } },
        evidenceIds: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 256 } },
        confidence: { type: "string", enum: ["high", "medium", "low", "needs-verification"] },
      },
    },
    glossary: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["technicalTerm", "simpleMeaning", "projectSpecificMeaning"],
        properties: {
          technicalTerm: { type: "string", minLength: 1, maxLength: 200 },
          simpleMeaning: { type: "string", minLength: 1, maxLength: 1000 },
          projectSpecificMeaning: { type: "string", minLength: 1, maxLength: 1200 },
        },
      },
    },
    knownLimitations: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 1000 } },
    confidenceNote: { type: "string", minLength: 1, maxLength: 2000 },
  },
} as const;

/**
 * Groq strict decoding supports a deliberately small JSON Schema subset. Keep
 * the richer bounds in Zod for local validation, but omit string/array bounds
 * from the provider schema so a valid explanation request is not rejected
 * before generation.
 */
function toGroqSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (typeof source.type === "string") result.type = source.type;
  if (Array.isArray(source.enum)) result.enum = source.enum;
  if (Array.isArray(source.required)) result.required = source.required;
  if (source.additionalProperties === false) result.additionalProperties = false;
  if (source.items) result.items = toGroqSchema(source.items);
  if (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) {
    result.properties = Object.fromEntries(Object.entries(source.properties as Record<string, unknown>).map(([key, child]) => [key, toGroqSchema(child)]));
  }
  return result;
}

export const groqProjectExplanationJsonSchema = toGroqSchema(projectExplanationJsonSchema);
