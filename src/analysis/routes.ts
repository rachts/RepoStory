import type { ApiRouteFinding, ApiRouteFramework, HttpMethod } from "@/domain/finding";
import type { RepositoryFile } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import {
  evidenceForPattern,
  fileContent,
  HTTP_METHODS,
  joinRoutePaths,
  normalizeHttpMethods,
  routePathFromSegments,
  safePath,
  safeText,
  sourceFiles,
  uniqueEvidence,
  withoutStandaloneComments,
} from "@/analysis/static-utils";
import { stableId } from "@/shared/ids";
import { redactPath } from "@/shared/redaction";

const HTTP_METHOD_PATTERN = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE";

function safeRoute(value: string): string {
  return safeText(redactPath(value));
}

function asHttpMethods(methods: string[]): HttpMethod[] {
  return normalizeHttpMethods(methods) as HttpMethod[];
}

function nextMethods(content: string, budget?: AnalysisBudget): { methods: HttpMethod[]; pattern?: RegExp; reason: string } {
  const clean = withoutStandaloneComments(content);
  const methods: string[] = [];
  const patterns: RegExp[] = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+(${HTTP_METHOD_PATTERN})\\b`, "gi"),
    new RegExp(`export\\s+(?:const|let|var)\\s+(${HTTP_METHOD_PATTERN})\\s*=`, "gi"),
  ];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      budget?.check();
      if (match[1]) methods.push(match[1]);
    }
  }
  const exportList = /export\s*\{([^}]+)\}/gi;
  for (const match of clean.matchAll(exportList)) {
    budget?.check();
    for (const name of match[1]?.split(",") ?? []) {
      budget?.check();
      const method = name.trim().split(/\s+as\s+/i)[0]?.toUpperCase();
      if (method && HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) methods.push(method);
    }
  }
  const normalized = asHttpMethods(methods);
  if (normalized[0] !== "UNKNOWN") return { methods: normalized, pattern: patterns[0], reason: "exports named HTTP method handlers" };
  const defaultPattern = /export\s+default\b/i;
  if (defaultPattern.test(clean)) return { methods: ["UNKNOWN"], pattern: defaultPattern, reason: "has a default API handler without explicit method branching" };
  return { methods: ["UNKNOWN"], reason: "matches an API route filename but does not expose a named method" };
}

function pagesMethods(content: string, budget?: AnalysisBudget): { methods: HttpMethod[]; pattern?: RegExp; reason: string } {
  const clean = withoutStandaloneComments(content);
  const methods: string[] = [];
  const methodPattern = new RegExp(`(?:req|request)\\s*\\.\\s*method\\s*(?:===?|!==?)\\s*["'](${HTTP_METHOD_PATTERN})["']|["'](${HTTP_METHOD_PATTERN})["']\\s*(?:===?|!==?)\\s*(?:req|request)\\s*\\.\\s*method|case\\s+["'](${HTTP_METHOD_PATTERN})["']`, "gi");
  for (const match of clean.matchAll(methodPattern)) {
    budget?.check();
    const method = match[1] ?? match[2] ?? match[3];
    if (method) methods.push(method);
  }
  const normalized = asHttpMethods(methods);
  if (normalized[0] !== "UNKNOWN") return { methods: normalized, pattern: methodPattern, reason: "branches on the request method" };
  const defaultPattern = /export\s+default\b/i;
  if (defaultPattern.test(clean)) return { methods: ["UNKNOWN"], pattern: defaultPattern, reason: "has a default API handler without explicit method branching" };
  return { methods: ["UNKNOWN"], reason: "matches a Pages Router API filename but has no explicit method branch" };
}

function nextRoute(file: RepositoryFile, budget?: AnalysisBudget): ApiRouteFinding | null {
  const match = file.path.match(/^(?:src\/)?app\/(.+)\/route\.(?:tsx?|jsx?|mjs|cjs|mts|cts)$/i);
  if (!match) return null;
  const segments = match[1]?.split("/") ?? [];
  const apiIndex = segments.findIndex((segment) => segment.toLowerCase() === "api");
  if (apiIndex < 0) return null;
  const routeSegments = segments.slice(apiIndex).filter((segment) => !/^\(.+\)$/.test(segment) && !segment.startsWith("@"));
  const methodInfo = nextMethods(fileContent(file), budget);
  const routePath = safeRoute(routePathFromSegments(routeSegments));
  const filePath = redactPath(safePath(file.path));
  const evidence = [evidenceForPattern(file, `Next.js App Router route ${routePath}; ${methodInfo.reason}`, methodInfo.pattern)];
  const methodLabel = methodInfo.methods.join(", ");
  return {
    id: stableId("api-route", "next-app-router", file.path, routePath, methodLabel),
    kind: "api-route",
    technicalLabel: safeText(`Next.js App Router ${methodLabel} ${routePath}`),
    plainEnglishLabel: safeText(`${methodLabel} API endpoint at ${routePath}`),
    explanation: safeText(`Next.js App Router treats ${filePath} as the handler for ${routePath}. The listed methods come from exported handler names or are marked for verification when no explicit method was found.`),
    technicalDetail: safeText(`framework=next-app-router; file=${filePath}`),
    confidence: methodInfo.methods[0] === "UNKNOWN" ? "needs-verification" : "high",
    evidence,
    routePath,
    path: routePath,
    route: routePath,
    methods: methodInfo.methods,
    httpMethods: methodInfo.methods,
    framework: "next-app-router",
    filePath,
    handler: filePath,
  };
}

function pagesRoute(file: RepositoryFile, budget?: AnalysisBudget): ApiRouteFinding | null {
  const match = file.path.match(/^(?:src\/)?pages\/api(?:\/(.*))?\.(?:tsx?|jsx?|mjs|cjs|mts|cts)$/i);
  if (!match) return null;
  const nestedPath = match[1]?.split("/") ?? [];
  const routePath = safeRoute(routePathFromSegments(["api", ...nestedPath]));
  const filePath = redactPath(safePath(file.path));
  const methodInfo = pagesMethods(fileContent(file), budget);
  const evidence = [evidenceForPattern(file, `Next.js Pages Router route ${routePath}; ${methodInfo.reason}`, methodInfo.pattern)];
  const methodLabel = methodInfo.methods.join(", ");
  return {
    id: stableId("api-route", "next-pages-router", file.path, routePath, methodLabel),
    kind: "api-route",
    technicalLabel: safeText(`Next.js Pages Router ${methodLabel} ${routePath}`),
    plainEnglishLabel: safeText(`${methodLabel} API endpoint at ${routePath}`),
    explanation: safeText(`Next.js Pages Router treats ${filePath} as the API handler for ${routePath}. Explicit request-method branches are reported when present.`),
    technicalDetail: safeText(`framework=next-pages-router; file=${filePath}`),
    confidence: methodInfo.methods[0] === "UNKNOWN" ? "needs-verification" : "high",
    evidence,
    routePath,
    path: routePath,
    route: routePath,
    methods: methodInfo.methods,
    httpMethods: methodInfo.methods,
    framework: "next-pages-router",
    filePath,
    handler: filePath,
  };
}

interface ExpressRouteCandidate {
  receiver: string;
  method: string;
  route: string;
  pattern: RegExp;
}

interface MountCandidate {
  receiver: string;
  prefix: string;
  target: string;
  pattern: RegExp;
}

interface MountEntry {
  prefix: string;
  evidence?: MountCandidate;
}

const EXPRESS_MODULES = new Set(["express"]);

function expressCandidates(file: RepositoryFile, budget?: AnalysisBudget): { routes: ExpressRouteCandidate[]; mounts: MountCandidate[]; receivers: Set<string>; routers: Set<string> } {
  const clean = withoutStandaloneComments(fileContent(file));
  const routers = new Set<string>();
  const receivers = new Set<string>();
  const expressBindings = new Set<string>();
  const routerFactories = new Set<string>();
  const isExpressModule = (source: string): boolean => EXPRESS_MODULES.has(source);

  const defaultImports = /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]+)\})?\s+from\s*["']([^"']+)["']/g;
  for (const match of clean.matchAll(defaultImports)) {
    budget?.check();
    if (!match[1] || !match[3] || !isExpressModule(match[3])) continue;
    expressBindings.add(match[1]);
    for (const imported of match[2]?.split(",") ?? []) {
      const [importedName, localName] = imported.trim().split(/\s+as\s+/i);
      if (importedName?.trim() === "Router") routerFactories.add(localName?.trim() || importedName.trim());
    }
  }

  const namespaceImports = /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g;
  for (const match of clean.matchAll(namespaceImports)) {
    budget?.check();
    if (match[1] && match[2] && isExpressModule(match[2])) expressBindings.add(match[1]);
  }

  const namedImports = /\bimport\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of clean.matchAll(namedImports)) {
    budget?.check();
    if (!match[1] || !match[2] || !isExpressModule(match[2])) continue;
    for (const imported of match[1].split(",")) {
      const [importedName, localName] = imported.trim().split(/\s+as\s+/i);
      if (importedName?.trim() === "Router") routerFactories.add(localName?.trim() || importedName.trim());
    }
  }

  const requiredModules = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of clean.matchAll(requiredModules)) {
    budget?.check();
    if (match[1] && match[2] && isExpressModule(match[2])) expressBindings.add(match[1]);
  }

  const requiredRouterFactories = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)\s*\.\s*Router\b/g;
  for (const match of clean.matchAll(requiredRouterFactories)) {
    budget?.check();
    if (match[1] && match[2] && isExpressModule(match[2])) routerFactories.add(match[1]);
  }

  const directRequiredRouters = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)\s*\.\s*Router\s*\(\s*\)/g;
  for (const match of clean.matchAll(directRequiredRouters)) {
    budget?.check();
    if (match[1] && match[2] && isExpressModule(match[2])) routers.add(match[1]);
  }

  const routerDeclaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*\)/g;
  for (const match of clean.matchAll(routerDeclaration)) {
    budget?.check();
    if (match[1] && match[2] && routerFactories.has(match[2])) routers.add(match[1]);
  }

  const namespacedRouterDeclaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\.\s*Router\s*\(\s*\)/g;
  for (const match of clean.matchAll(namespacedRouterDeclaration)) {
    budget?.check();
    if (match[1] && match[2] && expressBindings.has(match[2])) routers.add(match[1]);
  }

  for (const router of routers) receivers.add(router);

  const appDeclaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*\)/g;
  for (const match of clean.matchAll(appDeclaration)) {
    budget?.check();
    if (match[1] && match[2] && expressBindings.has(match[2])) receivers.add(match[1]);
  }

  const requiredAppDeclaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)\s*\(\s*\)/g;
  for (const match of clean.matchAll(requiredAppDeclaration)) {
    budget?.check();
    if (match[1] && match[2] && isExpressModule(match[2])) receivers.add(match[1]);
  }

  const routes: ExpressRouteCandidate[] = [];
  const directRoute = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|head|options|connect|all)\s*\(\s*(["'`])([^"'`]*?)\3/gi;
  for (const match of clean.matchAll(directRoute)) {
    budget?.check();
    const receiver = match[1];
    const method = match[2]?.toUpperCase();
    const route = match[4];
    if (!receiver || !method || route === undefined) continue;
    if (!receivers.has(receiver)) continue;
    receivers.add(receiver);
    routes.push({ receiver, method, route, pattern: new RegExp(`${receiver}\\s*\\.\\s*${method}\\b`, "i") });
  }

  const routeChain = /\b([A-Za-z_$][\w$]*)\s*\.\s*route\s*\(\s*(["'`])([^"'`]*?)\2\s*\)([\s\S]*?)(?=;|$)/gi;
  for (const match of clean.matchAll(routeChain)) {
    budget?.check();
    const receiver = match[1];
    const route = match[3];
    const chain = match[4] ?? "";
    if (!receiver || route === undefined || !receivers.has(receiver)) continue;
    receivers.add(receiver);
    for (const methodMatch of chain.matchAll(/\.(get|post|put|patch|delete|head|options|connect|all)\s*\(/gi)) {
      budget?.check();
      const method = methodMatch[1]?.toUpperCase();
      if (!method) continue;
      routes.push({ receiver, method, route, pattern: new RegExp(`${receiver}\\s*\\.\\s*route\\s*\\(`, "i") });
    }
  }

  const mounts: MountCandidate[] = [];
  const mountPattern = /\b([A-Za-z_$][\w$]*)\s*\.\s*use\s*\(\s*(["'`])([^"'`]*?)\2\s*,\s*([A-Za-z_$][\w$]*)/gi;
  for (const match of clean.matchAll(mountPattern)) {
    budget?.check();
    const receiver = match[1];
    const prefix = match[3];
    const target = match[4];
    if (!receiver || prefix === undefined || !target) continue;
    if (!receivers.has(receiver)) continue;
    receivers.add(receiver);
    mounts.push({ receiver, prefix, target, pattern: new RegExp(`${receiver}\\s*\\.\\s*use\\s*\\(`, "i") });
  }
  return { routes, mounts, receivers, routers };
}

function resolveMountPrefixes(mounts: MountCandidate[], receivers: Set<string>, budget?: AnalysisBudget): Map<string, MountEntry[]> {
  const prefixes = new Map<string, MountEntry[]>();
  for (const receiver of receivers) {
    budget?.check();
    if (receiver === "app" || receiver.toLowerCase().includes("app")) prefixes.set(receiver, [{ prefix: "" }]);
  }
  let changed = true;
  let rounds = 0;
  while (changed && rounds < mounts.length + 2) {
    budget?.check();
    changed = false;
    rounds += 1;
    for (const mount of mounts) {
      budget?.check();
      const bases = prefixes.get(mount.receiver) ?? [{ prefix: "" }];
      const targetPrefixes = prefixes.get(mount.target) ?? [];
      for (const base of bases) {
        budget?.check();
        const prefix = joinRoutePaths(base.prefix, mount.prefix);
        let alreadyPresent = false;
        for (const item of targetPrefixes) {
          budget?.check();
          if (item.prefix === prefix) {
            alreadyPresent = true;
            break;
          }
        }
        if (alreadyPresent) continue;
        targetPrefixes.push({ prefix, evidence: mount });
        changed = true;
      }
       targetPrefixes.sort((left, right) => { budget?.check(); return left.prefix.localeCompare(right.prefix); });
       budget?.check();
       prefixes.set(mount.target, targetPrefixes);
    }
  }
  return prefixes;
}

function expressRoute(file: RepositoryFile, candidate: ExpressRouteCandidate, routers: Set<string>, prefixEntry?: MountEntry, budget?: AnalysisBudget): ApiRouteFinding {
  const safeCandidateRoute = safeRoute(candidate.route);
  const safePrefix = prefixEntry ? safeRoute(prefixEntry.prefix) : undefined;
  const safeReceiver = safeText(candidate.receiver);
  const filePath = redactPath(safePath(file.path));
  const prefix = safePrefix || undefined;
  const routePath = safeRoute(joinRoutePaths(safePrefix, safeCandidateRoute));
  const method = candidate.method as HttpMethod;
  const routeEvidence = evidenceForPattern(file, `${candidate.method} route ${safeCandidateRoute} on ${safeReceiver}`, candidate.pattern);
  const mountEvidence = prefixEntry?.evidence ? evidenceForPattern(file, `mount prefix ${safePrefix} for ${safeReceiver}`, prefixEntry.evidence.pattern) : undefined;
  const evidence = uniqueEvidence([routeEvidence, ...(mountEvidence ? [mountEvidence] : [])], budget);
  const framework: ApiRouteFramework = routers.has(candidate.receiver) || candidate.receiver.toLowerCase().includes("router") ? "router" : "express";
  return {
    id: stableId("api-route", framework, file.path, candidate.receiver, routePath, candidate.method),
    kind: "api-route",
    technicalLabel: safeText(`${framework} ${candidate.method} ${routePath}`),
    plainEnglishLabel: safeText(`${candidate.method} API endpoint at ${routePath}`),
    explanation: safeText(`A ${framework} route call on ${safeReceiver} handles ${candidate.method} requests. ${prefix ? `The route includes the inferred mount prefix ${prefix}.` : "No mount prefix was inferred."}`),
    technicalDetail: safeText(`framework=${framework}; receiver=${safeReceiver}; file=${filePath}`),
    confidence: prefix && !mountEvidence ? "medium" : "high",
    evidence,
    routePath,
    path: routePath,
    route: routePath,
    methods: [method],
    httpMethods: [method],
    framework,
    filePath,
    prefix,
    handler: safeReceiver,
  };
}

function expressRoutes(file: RepositoryFile, budget?: AnalysisBudget): ApiRouteFinding[] {
  const parsed = expressCandidates(file, budget);
  if (!parsed.routes.length) return [];
  const prefixes = resolveMountPrefixes(parsed.mounts, parsed.receivers, budget);
  const findings: ApiRouteFinding[] = [];
  for (const candidate of parsed.routes) {
    budget?.check();
    const entries = prefixes.get(candidate.receiver);
    if (!entries?.length) {
      findings.push(expressRoute(file, candidate, parsed.routers, undefined, budget));
      continue;
    }
    for (const entry of entries) {
      budget?.check();
      findings.push(expressRoute(file, candidate, parsed.routers, entry, budget));
    }
  }
  findings.sort((left, right) => { budget?.check(); return left.id.localeCompare(right.id); });
  budget?.check();
  return findings;
}

export function analyzeApiRoutes(files: RepositoryFile[], budget?: AnalysisBudget): ApiRouteFinding[] {
  const findings: ApiRouteFinding[] = [];
  for (const file of sourceFiles(files, budget)) {
    budget?.check();
    const next = nextRoute(file, budget);
    const pages = pagesRoute(file, budget);
    if (next) findings.push(next);
    if (pages) findings.push(pages);
    findings.push(...expressRoutes(file, budget));
  }
  const byId = new Map<string, ApiRouteFinding>();
  for (const finding of findings) {
    budget?.check();
    byId.set(finding.id, finding);
  }
  budget?.check();
  const sortedFindings = [...byId.values()];
  sortedFindings.sort((left, right) => { budget?.check(); return left.id.localeCompare(right.id); });
  budget?.check();
  return sortedFindings;
}

export const detectApiRoutes = analyzeApiRoutes;
export const analyzeRoutes = analyzeApiRoutes;
export const findApiRoutes = analyzeApiRoutes;
export const analyzeApiRouteFindings = analyzeApiRoutes;
export const detectRoutes = analyzeApiRoutes;
