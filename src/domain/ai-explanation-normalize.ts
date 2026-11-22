/**
 * Normalizes raw LLM output against the Project Explanation schema rules:
 * - Unwraps a single wrapper object (e.g. { explanation: { ... } })
 * - Trims and truncates over-long strings at word boundaries
 * - Caps array sizes according to schema limits
 * - Drops empty string entries in string lists
 * - Drops array items with empty required fields
 * - Fixes enum casing and defaults unknown values to 'needs-verification' or 'unknown'
 * - Clamps and coerces integers for step numbers
 * - Drops unknown keys
 * - Defaults missing arrays to []
 * - Cleans evidence IDs (drops over-long >256 chars, dedupes, caps at 30, never truncating characters)
 * - NEVER invents missing prose (Zod remains authoritative)
 */

function unwrapWrapper(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.projectSummary && typeof raw.projectSummary === "object") {
    return raw;
  }
  const keys = Object.keys(raw);
  if (keys.length === 1 && typeof raw[keys[0]!] === "object" && raw[keys[0]!] !== null && !Array.isArray(raw[keys[0]!])) {
    const candidate = raw[keys[0]!] as Record<string, unknown>;
    if (candidate.projectSummary && typeof candidate.projectSummary === "object") {
      return candidate;
    }
    return candidate;
  }
  for (const candidateKey of ["explanation", "projectExplanation", "result", "data", "output"]) {
    if (candidateKey in raw && typeof raw[candidateKey] === "object" && raw[candidateKey] !== null && !Array.isArray(raw[candidateKey])) {
      const candidate = raw[candidateKey] as Record<string, unknown>;
      if (candidate.projectSummary && typeof candidate.projectSummary === "object") {
        return candidate;
      }
    }
  }
  return raw;
}

function truncateAtWordBoundary(str: string, max: number): string {
  const trimmed = str.trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 0 && lastSpace >= Math.floor(max * 0.5)) {
    return slice.slice(0, lastSpace).trimEnd();
  }
  return slice.trimEnd();
}

function normalizeOptionalBoundedString(val: unknown, max: number): unknown {
  if (typeof val === "string") {
    return truncateAtWordBoundary(val, max);
  }
  return val;
}

function normalizeEvidenceIds(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of val) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    // NEVER truncate characters: drop over-long IDs (>256 chars) and empty ones
    if (trimmed.length === 0 || trimmed.length > 256) continue;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
      if (result.length >= 30) break;
    }
  }
  return result;
}

function normalizeStringList(val: unknown, maxItems: number, itemMax: number): string[] {
  if (!Array.isArray(val)) return [];
  const result: string[] = [];
  for (const item of val) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    result.push(truncateAtWordBoundary(trimmed, itemMax));
    if (result.length >= maxItems) break;
  }
  return result;
}

function normalizeConfidence(val: unknown): "high" | "medium" | "low" | "needs-verification" {
  if (typeof val === "string") {
    const lower = val.trim().toLowerCase().replace(/_/g, "-");
    if (lower === "high") return "high";
    if (lower === "medium" || lower === "moderate") return "medium";
    if (lower === "low") return "low";
    if (lower === "needs-verification" || lower === "unverified" || lower === "uncertain") return "needs-verification";
  }
  return "needs-verification";
}

function normalizeDataIntegrationType(val: unknown): "database" | "external-service" | "storage" | "queue" | "unknown" {
  if (typeof val === "string") {
    const lower = val.trim().toLowerCase().replace(/_/g, "-");
    if (lower === "database" || lower === "db" || lower === "sql") return "database";
    if (lower === "external-service" || lower === "service" || lower === "api") return "external-service";
    if (lower === "storage" || lower === "s3" || lower === "blob") return "storage";
    if (lower === "queue" || lower === "message-queue" || lower === "mq") return "queue";
    if (lower === "unknown") return "unknown";
  }
  return "unknown";
}

function normalizeStepNumber(val: unknown, fallback: number): number {
  let num: number | undefined;
  if (typeof val === "number" && Number.isFinite(val)) {
    num = Math.floor(val);
  } else if (typeof val === "string") {
    const parsed = parseInt(val.trim(), 10);
    if (!Number.isNaN(parsed)) num = parsed;
  }
  if (num === undefined) num = fallback;
  if (num < 1) return 1;
  if (num > 50) return 50;
  return num;
}

function hasNonEmptyString(val: unknown): boolean {
  return typeof val === "string" && val.trim().length > 0;
}

export function normalizeProjectExplanation(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;

  const unwrapped = unwrapWrapper(raw as Record<string, unknown>);
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) return unwrapped;

  const result: Record<string, unknown> = {};

  // projectSummary
  if (unwrapped.projectSummary && typeof unwrapped.projectSummary === "object" && !Array.isArray(unwrapped.projectSummary)) {
    const summary = unwrapped.projectSummary as Record<string, unknown>;
    result.projectSummary = {
      title: normalizeOptionalBoundedString(summary.title, 300),
      oneSentence: normalizeOptionalBoundedString(summary.oneSentence, 1000),
      plainEnglish: normalizeOptionalBoundedString(summary.plainEnglish, 3000),
      evidenceIds: normalizeEvidenceIds(summary.evidenceIds),
      confidence: normalizeConfidence(summary.confidence),
    };
  } else {
    result.projectSummary = unwrapped.projectSummary;
  }

  // architectureAtAGlance
  if (unwrapped.architectureAtAGlance && typeof unwrapped.architectureAtAGlance === "object" && !Array.isArray(unwrapped.architectureAtAGlance)) {
    const glance = unwrapped.architectureAtAGlance as Record<string, unknown>;
    const rawLayers = Array.isArray(glance.layers) ? glance.layers : [];
    const layers: Array<Record<string, unknown>> = [];
    for (const item of rawLayers) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const layer = item as Record<string, unknown>;
      // Drop array items with empty required fields
      if (!hasNonEmptyString(layer.name) || !hasNonEmptyString(layer.simpleName) || !hasNonEmptyString(layer.purpose)) {
        continue;
      }
      layers.push({
        name: truncateAtWordBoundary(layer.name as string, 200),
        simpleName: truncateAtWordBoundary(layer.simpleName as string, 200),
        purpose: truncateAtWordBoundary(layer.purpose as string, 1500),
        components: normalizeStringList(layer.components, 30, 300),
        evidenceIds: normalizeEvidenceIds(layer.evidenceIds),
        confidence: normalizeConfidence(layer.confidence),
      });
      if (layers.length >= 20) break;
    }

    result.architectureAtAGlance = {
      plainEnglish: normalizeOptionalBoundedString(glance.plainEnglish, 3000),
      layers,
      evidenceIds: normalizeEvidenceIds(glance.evidenceIds),
    };
  } else {
    result.architectureAtAGlance = unwrapped.architectureAtAGlance;
  }

  // mainComponents (array of objects, max 60)
  const rawComponents = Array.isArray(unwrapped.mainComponents) ? unwrapped.mainComponents : [];
  const mainComponents: Array<Record<string, unknown>> = [];
  for (const item of rawComponents) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const comp = item as Record<string, unknown>;
    // Required fields: name, simpleName, whatItDoes, whyItMatters, location
    if (
      !hasNonEmptyString(comp.name) ||
      !hasNonEmptyString(comp.simpleName) ||
      !hasNonEmptyString(comp.whatItDoes) ||
      !hasNonEmptyString(comp.whyItMatters) ||
      !hasNonEmptyString(comp.location)
    ) {
      continue;
    }
    mainComponents.push({
      name: truncateAtWordBoundary(comp.name as string, 300),
      simpleName: truncateAtWordBoundary(comp.simpleName as string, 300),
      whatItDoes: truncateAtWordBoundary(comp.whatItDoes as string, 1500),
      whyItMatters: truncateAtWordBoundary(comp.whyItMatters as string, 1500),
      location: truncateAtWordBoundary(comp.location as string, 500),
      evidenceIds: normalizeEvidenceIds(comp.evidenceIds),
      confidence: normalizeConfidence(comp.confidence),
    });
    if (mainComponents.length >= 60) break;
  }
  result.mainComponents = mainComponents;

  // howTheSystemWorks (array of objects, max 30)
  const rawSteps = Array.isArray(unwrapped.howTheSystemWorks) ? unwrapped.howTheSystemWorks : [];
  const howTheSystemWorks: Array<Record<string, unknown>> = [];
  for (let idx = 0; idx < rawSteps.length; idx++) {
    const item = rawSteps[idx];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const step = item as Record<string, unknown>;
    // Required fields: step, title, plainEnglish, technicalDetail
    if (!hasNonEmptyString(step.title) || !hasNonEmptyString(step.plainEnglish) || !hasNonEmptyString(step.technicalDetail)) {
      continue;
    }
    howTheSystemWorks.push({
      step: normalizeStepNumber(step.step, idx + 1),
      title: truncateAtWordBoundary(step.title as string, 300),
      plainEnglish: truncateAtWordBoundary(step.plainEnglish as string, 2000),
      technicalDetail: truncateAtWordBoundary(step.technicalDetail as string, 2000),
      evidenceIds: normalizeEvidenceIds(step.evidenceIds),
      confidence: normalizeConfidence(step.confidence),
    });
    if (howTheSystemWorks.length >= 30) break;
  }
  result.howTheSystemWorks = howTheSystemWorks;

  // userJourney (array of objects, max 30)
  const rawJourneys = Array.isArray(unwrapped.userJourney) ? unwrapped.userJourney : [];
  const userJourney: Array<Record<string, unknown>> = [];
  for (let idx = 0; idx < rawJourneys.length; idx++) {
    const item = rawJourneys[idx];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const journey = item as Record<string, unknown>;
    // Required fields: step, title, plainEnglish
    if (!hasNonEmptyString(journey.title) || !hasNonEmptyString(journey.plainEnglish)) {
      continue;
    }
    userJourney.push({
      step: normalizeStepNumber(journey.step, idx + 1),
      title: truncateAtWordBoundary(journey.title as string, 300),
      plainEnglish: truncateAtWordBoundary(journey.plainEnglish as string, 2000),
      relatedRoutes: normalizeStringList(journey.relatedRoutes, 20, 500),
      relatedComponents: normalizeStringList(journey.relatedComponents, 20, 300),
      evidenceIds: normalizeEvidenceIds(journey.evidenceIds),
    });
    if (userJourney.length >= 30) break;
  }
  result.userJourney = userJourney;

  // technologyGuide (array of objects, max 60)
  const rawTech = Array.isArray(unwrapped.technologyGuide) ? unwrapped.technologyGuide : [];
  const technologyGuide: Array<Record<string, unknown>> = [];
  for (const item of rawTech) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const tech = item as Record<string, unknown>;
    // Required fields: technology, simpleName, whatItIs, roleInThisProject
    if (
      !hasNonEmptyString(tech.technology) ||
      !hasNonEmptyString(tech.simpleName) ||
      !hasNonEmptyString(tech.whatItIs) ||
      !hasNonEmptyString(tech.roleInThisProject)
    ) {
      continue;
    }
    technologyGuide.push({
      technology: truncateAtWordBoundary(tech.technology as string, 300),
      simpleName: truncateAtWordBoundary(tech.simpleName as string, 300),
      whatItIs: truncateAtWordBoundary(tech.whatItIs as string, 1200),
      roleInThisProject: truncateAtWordBoundary(tech.roleInThisProject as string, 1500),
      evidenceIds: normalizeEvidenceIds(tech.evidenceIds),
      confidence: normalizeConfidence(tech.confidence),
    });
    if (technologyGuide.length >= 60) break;
  }
  result.technologyGuide = technologyGuide;

  // apiGuide (array of objects, max 100)
  const rawApi = Array.isArray(unwrapped.apiGuide) ? unwrapped.apiGuide : [];
  const apiGuide: Array<Record<string, unknown>> = [];
  for (const item of rawApi) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const api = item as Record<string, unknown>;
    // Required fields: route, method, simplePurpose, requestFlow
    if (
      !hasNonEmptyString(api.route) ||
      !hasNonEmptyString(api.method) ||
      !hasNonEmptyString(api.simplePurpose) ||
      !hasNonEmptyString(api.requestFlow)
    ) {
      continue;
    }
    apiGuide.push({
      route: truncateAtWordBoundary(api.route as string, 500),
      method: truncateAtWordBoundary(api.method as string, 32),
      simplePurpose: truncateAtWordBoundary(api.simplePurpose as string, 1500),
      requestFlow: truncateAtWordBoundary(api.requestFlow as string, 2000),
      evidenceIds: normalizeEvidenceIds(api.evidenceIds),
      confidence: normalizeConfidence(api.confidence),
    });
    if (apiGuide.length >= 100) break;
  }
  result.apiGuide = apiGuide;

  // dataAndIntegrations (array of objects, max 60)
  const rawIntegrations = Array.isArray(unwrapped.dataAndIntegrations) ? unwrapped.dataAndIntegrations : [];
  const dataAndIntegrations: Array<Record<string, unknown>> = [];
  for (const item of rawIntegrations) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const integration = item as Record<string, unknown>;
    // Required fields: name, simplePurpose
    if (!hasNonEmptyString(integration.name) || !hasNonEmptyString(integration.simplePurpose)) {
      continue;
    }
    dataAndIntegrations.push({
      name: truncateAtWordBoundary(integration.name as string, 300),
      type: normalizeDataIntegrationType(integration.type),
      simplePurpose: truncateAtWordBoundary(integration.simplePurpose as string, 1500),
      evidenceIds: normalizeEvidenceIds(integration.evidenceIds),
      confidence: normalizeConfidence(integration.confidence),
    });
    if (dataAndIntegrations.length >= 60) break;
  }
  result.dataAndIntegrations = dataAndIntegrations;

  // securityAndAuthentication
  if (unwrapped.securityAndAuthentication && typeof unwrapped.securityAndAuthentication === "object" && !Array.isArray(unwrapped.securityAndAuthentication)) {
    const sec = unwrapped.securityAndAuthentication as Record<string, unknown>;
    result.securityAndAuthentication = {
      plainEnglish: normalizeOptionalBoundedString(sec.plainEnglish, 2500),
      confirmedControls: normalizeStringList(sec.confirmedControls, 30, 800),
      unknowns: normalizeStringList(sec.unknowns, 30, 800),
      evidenceIds: normalizeEvidenceIds(sec.evidenceIds),
      confidence: normalizeConfidence(sec.confidence),
    };
  } else {
    result.securityAndAuthentication = unwrapped.securityAndAuthentication;
  }

  // glossary (array of objects, max 60)
  const rawGlossary = Array.isArray(unwrapped.glossary) ? unwrapped.glossary : [];
  const glossary: Array<Record<string, unknown>> = [];
  for (const item of rawGlossary) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const term = item as Record<string, unknown>;
    // Required fields: technicalTerm, simpleMeaning, projectSpecificMeaning
    if (
      !hasNonEmptyString(term.technicalTerm) ||
      !hasNonEmptyString(term.simpleMeaning) ||
      !hasNonEmptyString(term.projectSpecificMeaning)
    ) {
      continue;
    }
    glossary.push({
      technicalTerm: truncateAtWordBoundary(term.technicalTerm as string, 200),
      simpleMeaning: truncateAtWordBoundary(term.simpleMeaning as string, 1000),
      projectSpecificMeaning: truncateAtWordBoundary(term.projectSpecificMeaning as string, 1200),
    });
    if (glossary.length >= 60) break;
  }
  result.glossary = glossary;

  // knownLimitations (string list, max 30, itemMax 1000)
  result.knownLimitations = normalizeStringList(unwrapped.knownLimitations, 30, 1000);

  // confidenceNote
  result.confidenceNote = normalizeOptionalBoundedString(unwrapped.confidenceNote, 2000);

  return result;
}
