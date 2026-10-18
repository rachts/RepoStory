import type { AuthenticationFinding } from "@/domain/finding";
import type { EvidenceReference } from "@/domain/evidence";
import type { RepositoryFile } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import { evidenceForPattern, fileContent, packageDependencyEvidence, packageNames, safePath, sourceFiles, uniqueEvidence, withoutStandaloneComments } from "@/analysis/static-utils";
import { stableId } from "@/shared/ids";
import { redactPath, redactSecrets } from "@/shared/redaction";

interface AuthenticationRule {
  key: string;
  provider: string;
  plain: string;
  mechanism: AuthenticationFinding["mechanism"];
  packages: string[];
  packagePrefixes?: string[];
  imports?: RegExp;
  initialization?: RegExp;
}

const authenticationRules: AuthenticationRule[] = [
  { key: "authjs", provider: "Auth.js / NextAuth", plain: "Sign-in and sessions managed by Auth.js / NextAuth", mechanism: "auth-provider", packages: ["next-auth", "@auth/core", "@auth/express", "@auth/prisma-adapter"], packagePrefixes: ["@auth/"], imports: /(?:from|require\s*\()\s*["'](?:next-auth|@auth\/)[^"']*["']/i, initialization: /\b(?:NextAuth|Auth)\s*\(/i },
  { key: "clerk", provider: "Clerk", plain: "Sign-in and identity managed by Clerk", mechanism: "auth-provider", packages: ["@clerk/nextjs", "@clerk/backend", "@clerk/clerk-react"], packagePrefixes: ["@clerk/"], imports: /(?:from|require\s*\()\s*["']@clerk\/[^"']+["']/i, initialization: /\b(?:clerkMiddleware|currentUser|useAuth|useUser|withAuth)\s*\(/i },
  { key: "supabase-auth", provider: "Supabase Auth", plain: "Sign-in and sessions managed by Supabase Auth", mechanism: "auth-provider", packages: ["@supabase/supabase-js", "@supabase/ssr"], initialization: /\.(?:auth)\.(?:getUser|getSession|signInWithPassword|signInWithOAuth|signUp|signOut|exchangeCodeForSession)\s*\(|\bcreateServerClient\s*\(/i },
  { key: "jwt", provider: "JWT", plain: "Requests carry signed JSON Web Tokens", mechanism: "jwt", packages: ["jsonwebtoken", "jose", "express-jwt", "passport-jwt"], imports: /(?:from|require\s*\()\s*["'](?:jsonwebtoken|jose|express-jwt|passport-jwt)["']/i, initialization: /\b(?:jwt\.(?:verify|sign|decode)|jwtVerify|new\s+SignJWT|Authorization\s*:[^\n]*Bearer)\b/i },
  { key: "session", provider: "Session middleware", plain: "Requests are associated with server-side sessions", mechanism: "session", packages: ["express-session", "iron-session", "cookie-session", "@fastify/session"], imports: /(?:from|require\s*\()\s*["'](?:express-session|iron-session|cookie-session|@fastify\/session)["']/i, initialization: /\b(?:getServerSession|getSession|req\s*\.\s*session|session\s*\(|setSession)\b/i },
  { key: "oauth", provider: "OAuth / OpenID Connect", plain: "Sign-in delegates to an OAuth or OpenID Connect provider", mechanism: "oauth", packages: ["passport", "openid-client", "oauth4webapi", "arctic"], imports: /(?:from|require\s*\()\s*["'](?:passport|openid-client|oauth4webapi|arctic)["']/i, initialization: /\b(?:oauth|openid|authorizationCode|authorizeUrl|callbackUrl|passport\.authenticate)\b/i },
];

const contextRequiredInitialization = new Set(authenticationRules.map((rule) => rule.key));

function matchingPackages(dependencies: Set<string>, rule: AuthenticationRule, budget?: AnalysisBudget): string[] {
  const matches: string[] = [];
  for (const name of dependencies) {
    budget?.check();
    let matchesRule = rule.packages.includes(name);
    for (const prefix of rule.packagePrefixes ?? []) {
      budget?.check();
      if (name.startsWith(prefix)) {
        matchesRule = true;
        break;
      }
    }
    if (matchesRule) matches.push(name);
  }
  matches.sort((left, right) => { budget?.check(); return left.localeCompare(right); });
  budget?.check();
  return matches;
}

function authenticationFinding(rule: AuthenticationRule, evidence: EvidenceReference[], evidenceType: AuthenticationFinding["evidenceType"], confidence: AuthenticationFinding["confidence"], detail: string, packageName?: string, budget?: AnalysisBudget): AuthenticationFinding {
  return {
    id: stableId("authentication", rule.key),
    kind: "authentication",
    technicalLabel: rule.provider,
    plainEnglishLabel: rule.plain,
    explanation: redactSecrets(`${rule.provider} evidence was found ${detail}. This finding is based on static repository evidence and does not claim that a login flow was executed.`),
    technicalDetail: redactSecrets(packageName ? `package=${packageName}` : `mechanism=${rule.mechanism}`),
    confidence,
    evidence: uniqueEvidence(evidence, budget),
    provider: rule.provider,
    mechanism: rule.mechanism,
    evidenceType,
  };
}

export function analyzeAuthentication(files: RepositoryFile[], budget?: AnalysisBudget): AuthenticationFinding[] {
  const analyzable = sourceFiles(files, budget);
  let packageFile: RepositoryFile | undefined;
  for (const file of analyzable) {
    budget?.check();
    if (file.path.toLowerCase() === "package.json") {
      packageFile = file;
      break;
    }
  }
  const dependencies = new Set(packageNames(packageFile, budget));
  const findings: AuthenticationFinding[] = [];
  for (const rule of authenticationRules) {
    budget?.check();
    const packageMatches = matchingPackages(dependencies, rule, budget);
    const evidence: EvidenceReference[] = [];
    for (const name of packageMatches) {
      budget?.check();
      evidence.push(...packageDependencyEvidence(packageFile, name, `${rule.provider} dependency ${name} is declared`));
    }
    const sourceMatches: RepositoryFile[] = [];
    let sourceEvidenceType: AuthenticationFinding["evidenceType"] | undefined;
    for (const file of analyzable) {
      budget?.check();
      const clean = withoutStandaloneComments(fileContent(file));
      const importMatch = rule.imports?.test(clean) ?? false;
      const initializationMatch = rule.initialization?.test(clean) ?? false;
      const identifiableInitialization = initializationMatch && (!contextRequiredInitialization.has(rule.key) || packageMatches.length > 0 || importMatch);
      if (!importMatch && !identifiableInitialization) continue;
      sourceMatches.push(file);
      sourceEvidenceType = identifiableInitialization ? "client-initialization" : "import";
      evidence.push(evidenceForPattern(file, `${rule.provider} import or authentication call`, identifiableInitialization ? rule.initialization : rule.imports));
    }
    if (rule.key === "supabase-auth" && !sourceMatches.length) continue;
    if (!sourceMatches.length) continue;
    const evidenceType = packageMatches.length ? "dependency" : sourceEvidenceType ?? "import";
    const confidence = packageMatches.length ? "high" : "medium";
    const detail = packageMatches.length ? `through declared package${packageMatches.length > 1 ? "s" : ""} ${packageMatches.join(", ")}` : `in ${sourceMatches.map((file) => redactPath(safePath(file.path))).join(", ")}`;
    findings.push(authenticationFinding(rule, evidence, evidenceType, confidence, detail, packageMatches[0], budget));
  }

  const middlewareFiles: RepositoryFile[] = [];
  for (const file of analyzable) {
    budget?.check();
    if (/(^|\/)middleware\.(?:tsx?|jsx?|mjs|cjs)$/i.test(file.path)) middlewareFiles.push(file);
  }
  for (const file of middlewareFiles) {
    budget?.check();
    const clean = withoutStandaloneComments(fileContent(file));
    const codeOnly = clean.replace(/(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g, " ");
    const authPattern = /\b(?:auth|session|clerk|withAuth|getToken)\b/i;
    if (!authPattern.test(codeOnly)) continue;
    const evidence = [evidenceForPattern(file, `authentication-aware middleware in ${redactPath(safePath(file.path))}`, authPattern)];
    findings.push({
      id: stableId("authentication", "middleware", file.path),
      kind: "authentication",
      technicalLabel: "Authentication middleware",
      plainEnglishLabel: "Requests pass through an authentication check",
      explanation: redactSecrets(`The middleware file ${redactPath(safePath(file.path))} contains authentication-related request handling. Static evidence cannot determine every protected path.`),
      technicalDetail: redactSecrets(`middleware=${redactPath(safePath(file.path))}`),
      confidence: "medium",
      evidence,
      provider: "Application middleware",
      mechanism: "middleware",
      evidenceType: "middleware",
    });
  }
  findings.sort((left, right) => { budget?.check(); return left.id.localeCompare(right.id); });
  budget?.check();
  return findings;
}

export const analyzeAuth = analyzeAuthentication;
export const analyzeAuthenticationEvidence = analyzeAuthentication;
export const detectAuthentication = analyzeAuthentication;
export const findAuthenticationEvidence = analyzeAuthentication;
export const analyzeAuthEvidence = analyzeAuthentication;
export const detectAuth = analyzeAuthentication;
export const detectAuthenticationEvidence = analyzeAuthentication;
