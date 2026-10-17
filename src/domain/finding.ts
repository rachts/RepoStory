import type { EvidenceReference } from "@/domain/evidence";

export type ConfidenceLevel =
  | "high"
  | "medium"
  | "low"
  | "needs-verification";

export type FindingKind =
  | "technology"
  | "directory"
  | "entry-point"
  | "module"
  | "module-relationship"
  | "integration"
  | "external-service"
  | "route"
  | "api-route"
  | "database"
  | "database-client"
  | "authentication"
  | "frontend"
  | "backend";

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "CONNECT"
  | "TRACE"
  | "ALL"
  | "UNKNOWN";

export type ApiRouteFramework =
  | "next-app-router"
  | "next-pages-router"
  | "express"
  | "router";

export interface AnalysisFinding {
  id: string;
  kind: FindingKind;
  technicalLabel: string;
  plainEnglishLabel: string;
  explanation: string;
  technicalDetail?: string;
  confidence: ConfidenceLevel;
  evidence: EvidenceReference[];
}

/** A statically discovered HTTP endpoint and the evidence that identifies it. */
export interface ApiRouteFinding extends AnalysisFinding {
  kind: "api-route" | "route";
  routePath: string;
  /** Alias kept for consumers that use `path` for endpoint paths. */
  path: string;
  /** Alias kept for consumers that call the endpoint path `route`. */
  route: string;
  methods: HttpMethod[];
  /** Alias kept for consumers that name the collection `httpMethods`. */
  httpMethods?: HttpMethod[];
  framework: ApiRouteFramework;
  filePath: string;
  /** Express/router mount prefix when one can be inferred. */
  prefix?: string;
  handler?: string;
}

/** A local module import discovered without executing repository code. */
export interface ModuleRelationship extends AnalysisFinding {
  kind: "module-relationship" | "module";
  source: string;
  target: string;
  sourceFile: string;
  targetFile: string;
  sourcePath?: string;
  targetPath?: string;
  specifier: string;
  importType: "static" | "dynamic" | "require";
  importKind?: "static" | "dynamic" | "require";
  relationship: "imports";
}

export interface DatabaseFinding extends AnalysisFinding {
  kind: "database" | "database-client";
  technology: string;
  evidenceType: "dependency" | "client-initialization" | "schema" | "migration";
}

export interface ExternalIntegrationFinding extends AnalysisFinding {
  kind: "external-service";
  service: string;
  packageName?: string;
  evidenceType: "dependency" | "import" | "client-initialization" | "http-client";
}

export interface AuthenticationFinding extends AnalysisFinding {
  kind: "authentication";
  provider: string;
  mechanism: "auth-provider" | "jwt" | "session" | "middleware" | "oauth";
  evidenceType: "dependency" | "import" | "client-initialization" | "middleware";
}
