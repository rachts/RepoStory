import type { RepositoryProvider, RepositoryReference, RepositorySnapshot, RepositoryFile } from "@/domain/repository";
import { err, ok, type Result } from "@/shared/result";
import { AppError } from "@/domain/errors";
import fixture from "../../../fixtures/repositories/small-react/repository.json";
import nextApi from "../../../fixtures/repositories/next-api/repository.json";
import expressApi from "../../../fixtures/repositories/express-api/repository.json";
import authenticatedApp from "../../../fixtures/repositories/authenticated-app/repository.json";
import databaseApp from "../../../fixtures/repositories/database-app/repository.json";
import externalIntegrations from "../../../fixtures/repositories/external-integrations/repository.json";
import ambiguousRoutes from "../../../fixtures/repositories/ambiguous-routes/repository.json";

const fixtures = [fixture, nextApi, expressApi, authenticatedApp, databaseApp, externalIntegrations, ambiguousRoutes];

export class FixtureRepositoryProvider implements RepositoryProvider {
  public async getSnapshot(reference: RepositoryReference): Promise<Result<RepositorySnapshot, AppError>> {
    const selected = fixtures.find((item) => reference.owner === item.owner && reference.name === item.name);
    if (!selected) return err<AppError>(new AppError({ code: "REPOSITORY_NOT_FOUND", message: "Fixture repository not found." }));
    return ok({ repository: { ...selected.repository, selectedBranch: reference.branch ?? selected.repository.defaultBranch }, files: selected.files as RepositoryFile[] });
  }
}
