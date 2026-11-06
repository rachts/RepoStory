import type { Organization, OrganizationMembership, OrganizationRole } from "@/domain/organization";
import { canAdminister, canAnalyze, canView } from "@/domain/organization";
import { AppError } from "@/domain/errors";

export interface OrganizationRepository {
  getOrganization(id: string): Promise<Organization | null>;
  getMembership(orgId: string, userId: string): Promise<OrganizationMembership | null>;
  createOrganization(org: Omit<Organization, "createdAt" | "updatedAt">, adminUserId: string): Promise<Organization>;
  addMember(orgId: string, userId: string, role: OrganizationRole): Promise<OrganizationMembership>;
}

export class OrganizationService {
  public constructor(private readonly repo: OrganizationRepository) {}

  public async getRole(orgId: string, userId: string): Promise<OrganizationRole | null> {
    const membership = await this.repo.getMembership(orgId, userId);
    return membership?.role ?? null;
  }

  public async authorize(orgId: string, userId: string, action: "view" | "analyze" | "admin"): Promise<OrganizationRole> {
    const role = await this.getRole(orgId, userId);
    if (!role) {
      throw new AppError({
        code: "REPOSITORY_INACCESSIBLE",
        message: "You are not a member of this organization.",
        retryable: false,
      });
    }

    if (action === "view" && !canView(role)) {
      throw new AppError({ code: "REPOSITORY_INACCESSIBLE", message: "Insufficient permissions to view.", retryable: false });
    }
    if (action === "analyze" && !canAnalyze(role)) {
      throw new AppError({ code: "REPOSITORY_INACCESSIBLE", message: "Insufficient permissions: analysts or admins only.", retryable: false });
    }
    if (action === "admin" && !canAdminister(role)) {
      throw new AppError({ code: "REPOSITORY_INACCESSIBLE", message: "Insufficient permissions: admins only.", retryable: false });
    }

    return role;
  }
}
