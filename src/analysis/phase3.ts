import type { AnalysisFinding, ApiRouteFinding, AuthenticationFinding, DatabaseFinding, ExternalIntegrationFinding, ModuleRelationship } from "@/domain/finding";
import type { RepositoryFile } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import { analyzeApiRoutes } from "@/analysis/routes";
import { analyzeModuleRelationships } from "@/analysis/module-relationships";
import { analyzeDatabaseEvidence } from "@/analysis/database";
import { analyzeExternalIntegrations } from "@/analysis/integrations";
import { analyzeAuthentication } from "@/analysis/authentication";

export interface Phase3Analysis {
  apiRoutes: ApiRouteFinding[];
  moduleRelationships: ModuleRelationship[];
  databases: DatabaseFinding[];
  externalIntegrations: ExternalIntegrationFinding[];
  authentication: AuthenticationFinding[];
  findings: AnalysisFinding[];
}

/** Run all Phase 3 static detectors without changing the Phase 1/2 pipeline. */
export function analyzePhase3(files: RepositoryFile[], budget?: AnalysisBudget): Phase3Analysis {
  budget?.check();
  const apiRoutes = analyzeApiRoutes(files, budget);
  budget?.check();
  const moduleRelationships = analyzeModuleRelationships(files, budget);
  budget?.check();
  const databases = analyzeDatabaseEvidence(files, budget);
  budget?.check();
  const externalIntegrations = analyzeExternalIntegrations(files, budget);
  budget?.check();
  const authentication = analyzeAuthentication(files, budget);
  const findings: AnalysisFinding[] = [
    ...apiRoutes,
    ...moduleRelationships,
    ...databases,
    ...externalIntegrations,
    ...authentication,
  ];
  return { apiRoutes, moduleRelationships, databases, externalIntegrations, authentication, findings };
}

export const analyzePhase3Findings = (files: RepositoryFile[]): AnalysisFinding[] => analyzePhase3(files).findings;
