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

function sanitizeString(val: unknown, max: number, fallback: string): string {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.length > 0) return trimmed.slice(0, max);
  }
  return fallback.slice(0, max);
}

function sanitizeConfidence(val: unknown): "high" | "medium" | "low" | "needs-verification" {
  if (typeof val === "string") {
    const lower = val.trim().toLowerCase().replace(/_/g, "-");
    if (lower === "high") return "high";
    if (lower === "medium" || lower === "moderate") return "medium";
    if (lower === "low") return "low";
    if (lower === "needs-verification" || lower === "unverified" || lower === "uncertain") return "needs-verification";
  }
  return "medium";
}

function sanitizeEvidenceIds(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 256))
    .slice(0, 30);
}

function sanitizeStringList(val: unknown, maxItems: number, itemMax: number): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, itemMax))
    .slice(0, maxItems);
}

export function sanitizeProjectExplanation(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const source = raw as Record<string, unknown>;
  if (!source.projectSummary || typeof source.projectSummary !== "object" || !source.architectureAtAGlance || typeof source.architectureAtAGlance !== "object") return raw;

  const summary = source.projectSummary as Record<string, unknown>;
  const projectSummary = {
    title: sanitizeString(summary.title, 300, "Repository Summary"),
    oneSentence: sanitizeString(summary.oneSentence, 1000, "Repository architecture overview."),
    plainEnglish: sanitizeString(summary.plainEnglish, 3000, "Repository architecture description."),
    evidenceIds: sanitizeEvidenceIds(summary.evidenceIds),
    confidence: sanitizeConfidence(summary.confidence),
  };

  const glance = (source.architectureAtAGlance && typeof source.architectureAtAGlance === "object" ? source.architectureAtAGlance : {}) as Record<string, unknown>;
  const rawLayers = Array.isArray(glance.layers) ? glance.layers : [];
  const layers = rawLayers.slice(0, 20).map((layerRaw, idx) => {
    const layer = (layerRaw && typeof layerRaw === "object" ? layerRaw : {}) as Record<string, unknown>;
    return {
      name: sanitizeString(layer.name, 200, `Layer ${idx + 1}`),
      simpleName: sanitizeString(layer.simpleName, 200, `Layer ${idx + 1}`),
      purpose: sanitizeString(layer.purpose, 1500, "Architectural layer purpose."),
      components: sanitizeStringList(layer.components, 30, 300),
      evidenceIds: sanitizeEvidenceIds(layer.evidenceIds),
      confidence: sanitizeConfidence(layer.confidence),
    };
  });
  const architectureAtAGlance = {
    plainEnglish: sanitizeString(glance.plainEnglish, 3000, "Architecture overview."),
    layers,
    evidenceIds: sanitizeEvidenceIds(glance.evidenceIds),
  };

  const rawComponents = Array.isArray(source.mainComponents) ? source.mainComponents : [];
  const mainComponents = rawComponents.slice(0, 60).map((compRaw, idx) => {
    const comp = (compRaw && typeof compRaw === "object" ? compRaw : {}) as Record<string, unknown>;
    return {
      name: sanitizeString(comp.name, 300, `Component ${idx + 1}`),
      simpleName: sanitizeString(comp.simpleName, 300, `Component ${idx + 1}`),
      whatItDoes: sanitizeString(comp.whatItDoes, 1500, "Component functionality."),
      whyItMatters: sanitizeString(comp.whyItMatters, 1500, "Component importance."),
      location: sanitizeString(comp.location, 500, "Repository file location."),
      evidenceIds: sanitizeEvidenceIds(comp.evidenceIds),
      confidence: sanitizeConfidence(comp.confidence),
    };
  });

  const rawSteps = Array.isArray(source.howTheSystemWorks) ? source.howTheSystemWorks : [];
  const howTheSystemWorks = rawSteps.slice(0, 30).map((stepRaw, idx) => {
    const stepObj = (stepRaw && typeof stepRaw === "object" ? stepRaw : {}) as Record<string, unknown>;
    const stepNum = typeof stepObj.step === "number" && Number.isInteger(stepObj.step) && stepObj.step >= 1 ? Math.min(stepObj.step, 50) : (idx + 1);
    return {
      step: stepNum,
      title: sanitizeString(stepObj.title, 300, `Step ${stepNum}`),
      plainEnglish: sanitizeString(stepObj.plainEnglish, 2000, "System process description."),
      technicalDetail: sanitizeString(stepObj.technicalDetail, 2000, "Technical flow details."),
      evidenceIds: sanitizeEvidenceIds(stepObj.evidenceIds),
      confidence: sanitizeConfidence(stepObj.confidence),
    };
  });

  const rawJourney = Array.isArray(source.userJourney) ? source.userJourney : [];
  const userJourney = rawJourney.slice(0, 30).map((journeyRaw, idx) => {
    const journeyObj = (journeyRaw && typeof journeyRaw === "object" ? journeyRaw : {}) as Record<string, unknown>;
    const stepNum = typeof journeyObj.step === "number" && Number.isInteger(journeyObj.step) && journeyObj.step >= 1 ? Math.min(journeyObj.step, 50) : (idx + 1);
    return {
      step: stepNum,
      title: sanitizeString(journeyObj.title, 300, `User step ${stepNum}`),
      plainEnglish: sanitizeString(journeyObj.plainEnglish, 2000, "User interaction description."),
      relatedRoutes: sanitizeStringList(journeyObj.relatedRoutes, 20, 500),
      relatedComponents: sanitizeStringList(journeyObj.relatedComponents, 20, 300),
      evidenceIds: sanitizeEvidenceIds(journeyObj.evidenceIds),
    };
  });

  const rawTech = Array.isArray(source.technologyGuide) ? source.technologyGuide : [];
  const technologyGuide = rawTech.slice(0, 60).map((techRaw, idx) => {
    const tech = (techRaw && typeof techRaw === "object" ? techRaw : {}) as Record<string, unknown>;
    return {
      technology: sanitizeString(tech.technology, 300, `Technology ${idx + 1}`),
      simpleName: sanitizeString(tech.simpleName, 300, `Technology ${idx + 1}`),
      whatItIs: sanitizeString(tech.whatItIs, 1200, "Technology definition."),
      roleInThisProject: sanitizeString(tech.roleInThisProject, 1500, "Role in application."),
      evidenceIds: sanitizeEvidenceIds(tech.evidenceIds),
      confidence: sanitizeConfidence(tech.confidence),
    };
  });

  const rawApi = Array.isArray(source.apiGuide) ? source.apiGuide : [];
  const apiGuide = rawApi.slice(0, 100).map((apiRaw, idx) => {
    const api = (apiRaw && typeof apiRaw === "object" ? apiRaw : {}) as Record<string, unknown>;
    return {
      route: sanitizeString(api.route, 500, `/route-${idx + 1}`),
      method: sanitizeString(api.method, 32, "GET"),
      simplePurpose: sanitizeString(api.simplePurpose, 1500, "API endpoint purpose."),
      requestFlow: sanitizeString(api.requestFlow, 2000, "Request flow details."),
      evidenceIds: sanitizeEvidenceIds(api.evidenceIds),
      confidence: sanitizeConfidence(api.confidence),
    };
  });

  const rawData = Array.isArray(source.dataAndIntegrations) ? source.dataAndIntegrations : [];
  const dataAndIntegrations = rawData.slice(0, 60).map((dataRaw, idx) => {
    const data = (dataRaw && typeof dataRaw === "object" ? dataRaw : {}) as Record<string, unknown>;
    const typeStr = typeof data.type === "string" ? data.type.trim().toLowerCase() : "unknown";
    const type = ["database", "external-service", "storage", "queue", "unknown"].includes(typeStr)
      ? (typeStr as "database" | "external-service" | "storage" | "queue" | "unknown")
      : "unknown";
    return {
      name: sanitizeString(data.name, 300, `Integration ${idx + 1}`),
      type,
      simplePurpose: sanitizeString(data.simplePurpose, 1500, "Data integration purpose."),
      evidenceIds: sanitizeEvidenceIds(data.evidenceIds),
      confidence: sanitizeConfidence(data.confidence),
    };
  });

  const sec = (source.securityAndAuthentication && typeof source.securityAndAuthentication === "object" ? source.securityAndAuthentication : {}) as Record<string, unknown>;
  const securityAndAuthentication = {
    plainEnglish: sanitizeString(sec.plainEnglish, 2500, "Security and authentication summary."),
    confirmedControls: sanitizeStringList(sec.confirmedControls, 30, 800),
    unknowns: sanitizeStringList(sec.unknowns, 30, 800),
    evidenceIds: sanitizeEvidenceIds(sec.evidenceIds),
    confidence: sanitizeConfidence(sec.confidence),
  };

  const rawGlossary = Array.isArray(source.glossary) ? source.glossary : [];
  const glossary = rawGlossary.slice(0, 60).map((itemRaw, idx) => {
    const item = (itemRaw && typeof itemRaw === "object" ? itemRaw : {}) as Record<string, unknown>;
    return {
      technicalTerm: sanitizeString(item.technicalTerm, 200, `Term ${idx + 1}`),
      simpleMeaning: sanitizeString(item.simpleMeaning, 1000, "Term explanation."),
      projectSpecificMeaning: sanitizeString(item.projectSpecificMeaning, 1200, "Project usage explanation."),
    };
  });

  const knownLimitations = sanitizeStringList(source.knownLimitations, 30, 1000);
  const confidenceNote = sanitizeString(source.confidenceNote, 2000, "All statements are based on repository evidence.");

  return {
    projectSummary,
    architectureAtAGlance,
    mainComponents,
    howTheSystemWorks,
    userJourney,
    technologyGuide,
    apiGuide,
    dataAndIntegrations,
    securityAndAuthentication,
    glossary,
    knownLimitations,
    confidenceNote,
  };
}
