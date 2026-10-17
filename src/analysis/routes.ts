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

const HTTP_METHOD_PATTERN = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE";

function safeRoute(value: string): string {
  return safeText(value);
}

function asHttpMethods(methods: string[]): HttpMethod[] {
  return normalizeHttpMethods(methods) as HttpMethod[];
}

function nextMethods(content: string): { methods: HttpMethod[]; pattern?: RegExp; reason: string } {
  const clean = withoutStandaloneComments(content);
  const methods: string[] = [];
  const patterns: RegExp[] = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+(${HTTP_METHOD_PATTERN})\\b`, "gi"),
    new RegExp(`export\\s+(?:const|let|var)\\s+(${HTTP_METHOD_PATTERN})\\s*=`, "gi"),
  ];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      if (match[1]) methods.push(match[1]);
    }
  }
  const exportList = /export\s*\{([^}]+)\}/gi;
  for (const match of clean.matchAll(exportList)) {
    for (const name of match[1]?.split(",") ?? []) {
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

function pagesMethods(content: string): { methods: HttpMethod[]; pattern?: RegExp; reason: string } {
  const clean = withoutStandaloneComments(content);
  const methods: string[] = [];
  const methodPattern = new RegExp(`(?:req|request)\\s*\\.\\s*method\\s*(?:===?|!==?)\\s*["'](${HTTP_METHOD_PATTERN})["']|["'](${HTTP_METHOD_PATTERN})["']\\s*(?:===?|!==?)\\s*(?:req|request)\\s*\\.\\s*method|case\\s+["'](${HTTP_METHOD_PATTERN})["']`, "gi");
  for (const match of clean.matchAll(methodPattern)) {
    const method = match[1] ?? match[2] ?? match[3];
    if (method) methods.push(method);
  }
  const normalized = asHttpMethods(methods);
  if (normalized[0] !== "UNKNOWN") return { methods: normalized, pattern: methodPattern, reason: "branches on the request method" };
  const defaultPattern = /export\s+default\b/i;
  if (defaultPattern.test(clean)) return { methods: ["UNKNOWN"], pattern: defaultPattern, reason: "has a default API handler without explicit method branching" };
  return { methods: ["UNKNOWN"], reason: "matches a Pages Router API filename but has no explicit method branch" };
}

function nextRoute(file: RepositoryFile): ApiRouteFinding | null {
  const match = file.path.match(/^(?:src\/)?app\/(.+)\/route\.(?:tsx?|jsx?|mjs|cjs|mts|cts)$/i);
  if (!match) return null;
  const segments = match[1]?.split("/") ?? [];
  const apiIndex = segments.findIndex((segment) => segment.toLowerCase() === "api");
  if (apiIndex < 0) return null;
  const routeSegments = segments.slice(apiIndex).filter((segment) => !/^\(.+\)$/.test(segment) && !segment.startsWith("@"));
  const methodInfo = nextMethods(fileContent(file));
  const routePath = safeRoute(routePathFromSegments(routeSegments));
  const evidence = [evidenceForPattern(file, `Next.js App Router route ${routePath}; ${methodInfo.reason}`, methodInfo.pattern)];
  const methodLabel = methodInfo.methods.join(", ");
  return {
    id: stableId("api-route", "next-app-router", file.path, routePath, methodLabel),
    kind: "api-route",
    technicalLabel: `Next.js App Router ${methodLabel} ${routePath}`,
    plainEnglishLabel: `${methodLabel} API endpoint at ${routePath}`,
    explanation: `Next.js App Router treats ${safePath(file.path)} as the handler for ${routePath}. The listed methods come from exported handler names or are marked for verification when no explicit method was found.`,
    technicalDetail: `framework=next-app-router; file=${safePath(file.path)}`,
    confidence: methodInfo.methods[0] === "UNKNOWN" ? "needs-verification" : "high",
    evidence,
    routePath,
    path: routePath,
    route: routePath,
    methods: methodInfo.methods,
    httpMethods: methodInfo.methods,
    framework: "next-app-router",
    filePath: file.path,
    handler: file.path,
  };
}

function pagesRoute(file: RepositoryFile): ApiRouteFinding | null {
  const match = file.path.match(/^(?:src\/)?pages\/api(?:\/(.*))?\.(?:tsx?|jsx?|mjs|cjs|mts|cts)$/i);
  if (!match) return null;
  const nestedPath = match[1]?.split("/") ?? [];
  const routePath = safeRoute(routePathFromSegments(["api", ...nestedPath]));
  const methodInfo = pagesMethods(fileContent(file));
  const evidence = [evidenceForPattern(file, `Next.js Pages Router route ${routePath}; ${methodInfo.reason}`, methodInfo.pattern)];
  const methodLabel = methodInfo.methods.join(", ");
  return {
    id: stableId("api-route", "next-pages-router", file.path, routePath, methodLabel),
    kind: "api-route",
    technicalLabel: `Next.js Pages Router ${methodLabel} ${routePath}`,
    plainEnglishLabel: `${methodLabel} API endpoint at ${routePath}`,
    explanation: `Next.js Pages Router treats ${safePath(file.path)} as the API handler for ${routePath}. Explicit request-method branches are reported when present.`,
    technicalDetail: `framework=next-pages-router; file=${safePath(file.path)}`,
    confidence: methodInfo.methods[0] === "UNKNOWN" ? "needs-verification" : "high",
    evidence,
    routePath,
    path: routePath,
    route: routePath,
    methods: methodInfo.methods,
    httpMethods: methodInfo.methods,
    framework: "next-pages-router",
    filePath: file.path,
    handler: file.path,
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

function expressCandidates(file: RepositoryFile, budget?: AnalysisBudget): { routes: ExpressRouteCandidate[]; mounts: MountCandidate[]; receivers: Set<string>; routers: Set<string> } {
  const clean = withoutStandaloneComments(fileContent(file));
  const routers = new Set<string>();
  const receivers = new Set<string>();
  const routerDeclaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:express\s*\.\s*)?Router)\s*\(/g;
  for (const match of clean.matchAll(routerDeclaration)) { budget?.check(); if (match[1]) routers.add(match[1]); }
  const appDeclaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*express\s*\(/g;
  for (const match of clean.matchAll(appDeclaration)) { budget?.check(); if (match[1]) receivers.add(match[1]); }
  for (const router of routers) receivers.add(router);
  const importedRouter = /\bimport\s*\{([^}]+)\}\s*from\s*["'][^"']+["']/g;
  for (const match of clean.matchAll(importedRouter)) {
    budget?.check();
    for (const imported of match[1]?.split(",") ?? []) {
      const localName = imported.trim().split(/\s+as\s+/i).at(-1)?.trim();
      if (localName && /router/i.test(localName)) { routers.add(localName); receivers.add(localName); }
    }
  }
  const requiredRouter = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*router[\w$]*)\s*=\s*require\s*\(/gi;
  for (const match of clean.matchAll(requiredRouter)) { budget?.check(); if (match[1]) { routers.add(match[1]); receivers.add(match[1]); } }

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

function resolveMountPrefixes(mounts: MountCandidate[], receivers: Set<string>): Map<string, MountEntry[]> {
  const prefixes = new Map<string, MountEntry[]>();
  const appReceivers = [...receivers].filter((receiver) => receiver === "app" || receiver.toLowerCase().includes("app"));
  for (const receiver of appReceivers) prefixes.set(receiver, [{ prefix: "" }]);
  let changed = true;
  let rounds = 0;
  while (changed && rounds < mounts.length + 2) {
    changed = false;
    rounds += 1;
    for (const mount of mounts) {
      const bases = prefixes.get(mount.receiver) ?? [{ prefix: "" }];
      const targetPrefixes = prefixes.get(mount.target) ?? [];
      for (const base of bases) {
        const prefix = joinRoutePaths(base.prefix, mount.prefix);
        if (targetPrefixes.some((item) => item.prefix === prefix)) continue;
        targetPrefixes.push({ prefix, evidence: mount });
        changed = true;
      }
      prefixes.set(mount.target, targetPrefixes.sort((left, right) => left.prefix.localeCompare(right.prefix)));
    }
  }
  return prefixes;
}

function expressRoute(file: RepositoryFile, candidate: ExpressRouteCandidate, routers: Set<string>, prefixEntry?: MountEntry): ApiRouteFinding {
  const safeCandidateRoute = safeRoute(candidate.route);
  const safePrefix = prefixEntry ? safeRoute(prefixEntry.prefix) : undefined;
  const prefix = safePrefix || undefined;
  const routePath = safeRoute(joinRoutePaths(safePrefix, safeCandidateRoute));
  const method = candidate.method as HttpMethod;
  const routeEvidence = evidenceForPattern(file, `${candidate.method} route ${safeCandidateRoute} on ${candidate.receiver}`, candidate.pattern);
  const mountEvidence = prefixEntry?.evidence ? evidenceForPattern(file, `mount prefix ${safePrefix} for ${candidate.receiver}`, prefixEntry.evidence.pattern) : undefined;
  const evidence = uniqueEvidence([routeEvidence, ...(mountEvidence ? [mountEvidence] : [])]);
  const framework: ApiRouteFramework = routers.has(candidate.receiver) || candidate.receiver.toLowerCase().includes("router") ? "router" : "express";
  return {
    id: stableId("api-route", framework, file.path, candidate.receiver, routePath, candidate.method),
    kind: "api-route",
    technicalLabel: `${framework} ${candidate.method} ${routePath}`,
    plainEnglishLabel: `${candidate.method} API endpoint at ${routePath}`,
    explanation: `A ${framework} route call on ${candidate.receiver} handles ${candidate.method} requests. ${prefix ? `The route includes the inferred mount prefix ${prefix}.` : "No mount prefix was inferred."}`,
    technicalDetail: `framework=${framework}; receiver=${candidate.receiver}; file=${safePath(file.path)}`,
    confidence: prefix && !mountEvidence ? "medium" : "high",
    evidence,
    routePath,
    path: routePath,
    route: routePath,
    methods: [method],
    httpMethods: [method],
    framework,
    filePath: file.path,
    prefix,
    handler: candidate.receiver,
  };
}

function expressRoutes(file: RepositoryFile, budget?: AnalysisBudget): ApiRouteFinding[] {
  const parsed = expressCandidates(file, budget);
  if (!parsed.routes.length) return [];
  const prefixes = resolveMountPrefixes(parsed.mounts, parsed.receivers);
  return parsed.routes
    .flatMap((candidate) => {
      budget?.check();
      const entries = prefixes.get(candidate.receiver);
      if (!entries?.length) return [expressRoute(file, candidate, parsed.routers)];
      return entries.map((entry) => expressRoute(file, candidate, parsed.routers, entry));
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function analyzeApiRoutes(files: RepositoryFile[], budget?: AnalysisBudget): ApiRouteFinding[] {
  const findings = sourceFiles(files).flatMap((file) => { budget?.check(); return [nextRoute(file), pagesRoute(file)].filter((finding): finding is ApiRouteFinding => finding !== null).concat(expressRoutes(file, budget)); });
  const byId = new Map<string, ApiRouteFinding>();
  for (const finding of findings) byId.set(finding.id, finding);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export const detectApiRoutes = analyzeApiRoutes;
export const analyzeRoutes = analyzeApiRoutes;
export const findApiRoutes = analyzeApiRoutes;
export const analyzeApiRouteFindings = analyzeApiRoutes;
export const detectRoutes = analyzeApiRoutes;
