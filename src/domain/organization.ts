export type OrganizationRole = "viewer" | "analyst" | "admin";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMembership {
  id: string;
  orgId: string;
  userId: string;
  role: OrganizationRole;
  createdAt: string;
}

export function canView(role: OrganizationRole): boolean {
  return role === "viewer" || role === "analyst" || role === "admin";
}

export function canAnalyze(role: OrganizationRole): boolean {
  return role === "analyst" || role === "admin";
}

export function canAdminister(role: OrganizationRole): boolean {
  return role === "admin";
}
