import type { DatabaseFinding } from "@/domain/finding";
import type { EvidenceReference } from "@/domain/evidence";
import type { RepositoryFile } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import { evidenceForPattern, fileContent, packageDependencyEvidence, packageNames, safePath, sourceFiles, uniqueEvidence, withoutStandaloneComments } from "@/analysis/static-utils";
import { stableId } from "@/shared/ids";
import { redactPath, redactSecrets } from "@/shared/redaction";
import { normalizePath } from "@/shared/text";

interface DatabaseRule {
  key: string;
  label: string;
  plain: string;
  packages: string[];
  imports?: RegExp;
  initialization?: RegExp;
}

const databaseRules: DatabaseRule[] = [
  { key: "prisma", label: "Prisma", plain: "A typed database client and schema layer", packages: ["@prisma/client", "prisma"], imports: /(?:from|require\s*\()\s*["'](?:@prisma\/client|prisma)["']/i, initialization: /\bnew\s+PrismaClient\s*\(/i },
  { key: "drizzle", label: "Drizzle ORM", plain: "A lightweight typed SQL database layer", packages: ["drizzle-orm", "drizzle-kit"], imports: /(?:from|require\s*\()\s*["']drizzle-orm(?:\/[^"]*)?["']/i, initialization: /\bdrizzle\s*\(/i },
  { key: "postgres", label: "PostgreSQL client", plain: "A direct PostgreSQL database connection", packages: ["pg", "postgres", "postgres.js", "@neondatabase/serverless"], imports: /(?:from|require\s*\()\s*["'](?:pg|postgres|postgres\.js|@neondatabase\/serverless)["']/i, initialization: /\b(?:new\s+(?:Pool|Client)|postgres|neon)\s*\(/i },
  { key: "mysql", label: "MySQL client", plain: "A direct MySQL-compatible database connection", packages: ["mysql", "mysql2", "mariadb"], imports: /(?:from|require\s*\()\s*["'](?:mysql|mysql2|mariadb)["']/i, initialization: /\b(?:createPool|createConnection)\s*\(/i },
  { key: "mongodb", label: "MongoDB client", plain: "A document database connection", packages: ["mongodb", "mongoose"], imports: /(?:from|require\s*\()\s*["'](?:mongodb|mongoose)["']/i, initialization: /\b(?:new\s+MongoClient|mongoose\.connect)\s*\(/i },
  { key: "redis", label: "Redis client", plain: "A key-value or cache database connection", packages: ["redis", "ioredis"], imports: /(?:from|require\s*\()\s*["'](?:redis|ioredis)["']/i, initialization: /\b(?:createClient|new\s+Redis)\s*\(/i },
  { key: "sqlite", label: "SQLite client", plain: "An embedded SQLite database connection", packages: ["better-sqlite3", "sqlite3", "@libsql/client"], imports: /(?:from|require\s*\()\s*["'](?:better-sqlite3|sqlite3|@libsql\/client)["']/i, initialization: /\b(?:new\s+(?:Database|sqlite3\.Database)|createClient)\s*\(/i },
  { key: "sequelize", label: "Sequelize", plain: "An object-relational database layer", packages: ["sequelize"], imports: /(?:from|require\s*\()\s*["']sequelize["']/i, initialization: /\bnew\s+Sequelize\s*\(/i },
  { key: "typeorm", label: "TypeORM", plain: "An object-relational database layer", packages: ["typeorm"], imports: /(?:from|require\s*\()\s*["']typeorm["']/i, initialization: /\b(?:DataSource|createConnection)\s*\(/i },
  { key: "knex", label: "Knex", plain: "A SQL query builder and database client", packages: ["knex"], imports: /(?:from|require\s*\()\s*["']knex["']/i, initialization: /\bknex\s*\(/i },
  { key: "supabase-database", label: "Supabase database client", plain: "A hosted Postgres client used through Supabase", packages: ["@supabase/supabase-js"], imports: /(?:from|require\s*\()\s*["']@supabase\/supabase-js["']/i, initialization: /\bcreateClient\s*\(/i },
];

const contextRequiredInitialization = new Set(["drizzle", "postgres", "mysql", "redis", "sqlite", "typeorm", "knex", "supabase-database"]);

function migrationFiles(files: RepositoryFile[], budget?: AnalysisBudget): RepositoryFile[] {
  const migrations: RepositoryFile[] = [];
  for (const file of sourceFiles(files, budget)) {
    budget?.check();
    if (!/\.sql$/i.test(file.path)) continue;
    const pathLooksLikeMigration = /(^|\/)(?:migrations?|db|database|schema)(?:\/|[-_])/i.test(file.path);
    if (pathLooksLikeMigration || /\b(?:create|alter|drop)\s+(?:table|index|schema)|\binsert\s+into\b/i.test(fileContent(file))) migrations.push(file);
  }
  return migrations;
}

function schemaFiles(files: RepositoryFile[], budget?: AnalysisBudget): RepositoryFile[] {
  const schemas: RepositoryFile[] = [];
  for (const file of sourceFiles(files, budget)) {
    budget?.check();
    if (/\.prisma$/i.test(file.path)) schemas.push(file);
  }
  return schemas;
}

function findingFor(rule: DatabaseRule, evidence: EvidenceReference[], evidenceType: DatabaseFinding["evidenceType"], confidence: DatabaseFinding["confidence"], detail: string, budget?: AnalysisBudget): DatabaseFinding {
  return {
    id: stableId("database", rule.key),
    kind: "database",
    technicalLabel: rule.label,
    plainEnglishLabel: rule.plain,
    explanation: redactSecrets(`${rule.label} evidence was found ${detail}. This conclusion is based on static file and dependency evidence only.`),
    technicalDetail: redactSecrets(`database=${rule.key}`),
    confidence,
    evidence: uniqueEvidence(evidence, budget),
    technology: rule.label,
    evidenceType,
  };
}

export function analyzeDatabaseEvidence(files: RepositoryFile[], budget?: AnalysisBudget): DatabaseFinding[] {
  const analyzable = sourceFiles(files, budget);
  let packageFile: RepositoryFile | undefined;
  for (const file of analyzable) {
    budget?.check();
    if (normalizePath(file.path).toLowerCase() === "package.json") {
      packageFile = file;
      break;
    }
  }
  const dependencies = new Set(packageNames(packageFile, budget));
  const findings: DatabaseFinding[] = [];
  for (const rule of databaseRules) {
    budget?.check();
    const packageMatches: string[] = [];
    const evidence: EvidenceReference[] = [];
    for (const name of rule.packages) {
      budget?.check();
      if (!dependencies.has(name)) continue;
      packageMatches.push(name);
      evidence.push(...packageDependencyEvidence(packageFile, name, `${rule.label} dependency ${name} is declared`));
    }
    const sourceMatches: RepositoryFile[] = [];
    for (const file of analyzable) {
      budget?.check();
      const clean = withoutStandaloneComments(fileContent(file));
      const importEvidence = (rule.imports && rule.imports.test(clean)) || (rule.key === "drizzle" && /(?:from|require\s*\()\s*["']drizzle-orm(?:\/[^"']*)?["']/i.test(clean));
      const initializationEvidence = rule.initialization && rule.initialization.test(clean);
      const identifiableInitialization = Boolean(initializationEvidence && (!contextRequiredInitialization.has(rule.key) || packageMatches.length > 0 || importEvidence));
      if (importEvidence || identifiableInitialization) {
        sourceMatches.push(file);
        evidence.push(evidenceForPattern(file, `${rule.label} import or client initialization`, identifiableInitialization ? rule.initialization : rule.imports));
      }
    }
    if (!sourceMatches.length) continue;
    const evidenceType: DatabaseFinding["evidenceType"] = packageMatches.length ? "dependency" : "client-initialization";
    const confidence: DatabaseFinding["confidence"] = packageMatches.length ? "high" : "medium";
    const detail = packageMatches.length ? `through declared package${packageMatches.length > 1 ? "s" : ""} ${packageMatches.join(", ")} and usage in ${sourceMatches.map((file) => redactPath(safePath(file.path))).join(", ")}` : `in ${sourceMatches.map((file) => redactPath(safePath(file.path))).join(", ")}`;
    findings.push(findingFor(rule, evidence, evidenceType, confidence, detail, budget));
  }

  budget?.check();
  const prismaSchemas = schemaFiles(files, budget);
  if (prismaSchemas.length) {
    const evidence: EvidenceReference[] = [];
    for (const file of prismaSchemas) {
      budget?.check();
      evidence.push(evidenceForPattern(file, `Prisma schema file ${redactPath(safePath(file.path))}`));
    }
    const existing = findings.find((finding) => finding.technology === "Prisma");
    if (existing) {
      existing.evidence = uniqueEvidence([...existing.evidence, ...evidence], budget);
      existing.evidenceType = "schema";
      existing.explanation = `${existing.explanation} A Prisma schema file also confirms the database model.`;
    } else {
      findings.push(findingFor(databaseRules[0]!, evidence, "schema", "high", `through schema file${prismaSchemas.length > 1 ? "s" : ""} ${prismaSchemas.map((file) => redactPath(safePath(file.path))).join(", ")}`, budget));
    }
  }

  budget?.check();
  const migrations = migrationFiles(files, budget);
  if (migrations.length) {
    const evidence: EvidenceReference[] = [];
    for (const file of migrations) {
      budget?.check();
      evidence.push(evidenceForPattern(file, `SQL migration evidence in ${redactPath(safePath(file.path))}`, /\b(?:create|alter|drop)\s+(?:table|index|schema)|\binsert\s+into\b/i));
    }
    findings.push({
      id: stableId("database", "sql-migrations"),
      kind: "database",
      technicalLabel: "SQL migrations",
      plainEnglishLabel: "Versioned database changes",
      explanation: `SQL migration files describe database schema changes without requiring the application to run.`,
      technicalDetail: redactSecrets(`migrationFiles=${migrations.map((file) => redactPath(safePath(file.path))).join(", ")}`),
      confidence: "high",
      evidence: uniqueEvidence(evidence, budget),
      technology: "SQL migrations",
      evidenceType: "migration",
    });
  }

  findings.sort((left, right) => { budget?.check(); return left.id.localeCompare(right.id); });
  budget?.check();
  return findings;
}

export const analyzeDatabases = analyzeDatabaseEvidence;
export const detectDatabaseEvidence = analyzeDatabaseEvidence;
export const findDatabaseEvidence = analyzeDatabaseEvidence;
export const analyzeDatabase = analyzeDatabaseEvidence;
export const detectDatabase = analyzeDatabaseEvidence;
export const detectDatabaseUsage = analyzeDatabaseEvidence;
