import type { ExternalIntegrationFinding } from "@/domain/finding";
import type { EvidenceReference } from "@/domain/evidence";
import type { RepositoryFile } from "@/domain/repository";
import type { AnalysisBudget } from "@/shared/limits";
import { evidenceForPattern, fileContent, packageDependencyEvidence, packageNames, safePath, sourceFiles, uniqueEvidence, withoutStandaloneComments } from "@/analysis/static-utils";
import { stableId } from "@/shared/ids";
import { redactPath, redactSecrets } from "@/shared/redaction";

interface IntegrationRule {
  key: string;
  service: string;
  plain: string;
  packages: string[];
  packagePrefixes?: string[];
  imports?: RegExp;
  initialization?: RegExp;
  initializationRequiresContext?: boolean;
}

const integrationRules: IntegrationRule[] = [
  { key: "stripe", service: "Stripe", plain: "Payments and billing through Stripe", packages: ["stripe", "@stripe/stripe-js"], imports: /(?:from|require\s*\()\s*["'](?:stripe|@stripe\/stripe-js)["']/i, initialization: /\b(?:new\s+Stripe|loadStripe)\s*\(/i },
  { key: "openai", service: "OpenAI", plain: "AI model access through OpenAI", packages: ["openai"], imports: /(?:from|require\s*\()\s*["']openai["']/i, initialization: /\bnew\s+OpenAI\s*\(/i },
  { key: "anthropic", service: "Anthropic", plain: "AI model access through Anthropic", packages: ["@anthropic-ai/sdk"], imports: /(?:from|require\s*\()\s*["']@anthropic-ai\/sdk["']/i, initialization: /\bnew\s+Anthropic\s*\(/i },
  { key: "aws", service: "AWS", plain: "Cloud services through the AWS SDK", packages: ["aws-sdk"], packagePrefixes: ["@aws-sdk/"], imports: /(?:from|require\s*\()\s*["'](?:aws-sdk|@aws-sdk\/)[^"']*["']/i, initialization: /\bnew\s+[A-Za-z]+Client\s*\(/i, initializationRequiresContext: true },
  { key: "google-cloud", service: "Google Cloud", plain: "Cloud services through Google APIs", packages: ["googleapis"], packagePrefixes: ["@google-cloud/"], imports: /(?:from|require\s*\()\s*["'](?:googleapis|@google-cloud\/)[^"']*["']/i, initialization: /\bgoogle\.[A-Za-z]+\s*\(/i, initializationRequiresContext: true },
  { key: "supabase", service: "Supabase", plain: "Hosted data and authentication through Supabase", packages: ["@supabase/supabase-js", "@supabase/ssr"], imports: /(?:from|require\s*\()\s*["']@supabase\/(?:supabase-js|ssr)["']/i, initialization: /\bcreateClient\s*\(/i, initializationRequiresContext: true },
  { key: "firebase", service: "Firebase", plain: "Hosted application services through Firebase", packages: ["firebase", "firebase-admin"], packagePrefixes: ["firebase/"], imports: /(?:from|require\s*\()\s*["'](?:firebase|firebase-admin)(?:\/[^"']*)?["']/i, initialization: /\b(?:initializeApp|getApps)\s*\(/i, initializationRequiresContext: true },
  { key: "twilio", service: "Twilio", plain: "Messaging or telephony through Twilio", packages: ["twilio"], imports: /(?:from|require\s*\()\s*["']twilio["']/i, initialization: /\b(?:new\s+Twilio|twilio)\s*\(/i, initializationRequiresContext: true },
  { key: "sendgrid", service: "SendGrid", plain: "Transactional email through SendGrid", packages: ["@sendgrid/mail"], imports: /(?:from|require\s*\()\s*["']@sendgrid\/mail["']/i, initialization: /\b(?:sendgrid|sgMail)\./i, initializationRequiresContext: true },
  { key: "resend", service: "Resend", plain: "Transactional email through Resend", packages: ["resend"], imports: /(?:from|require\s*\()\s*["']resend["']/i, initialization: /\bnew\s+Resend\s*\(/i },
  { key: "slack", service: "Slack", plain: "Workspace messaging through Slack", packages: ["@slack/web-api", "@slack/bolt"], imports: /(?:from|require\s*\()\s*["']@slack\/(?:web-api|bolt)["']/i, initialization: /\bnew\s+(?:WebClient|App)\s*\(/i, initializationRequiresContext: true },
  { key: "discord", service: "Discord", plain: "Community messaging through Discord", packages: ["discord.js", "discord-api-types"], imports: /(?:from|require\s*\()\s*["'](?:discord\.js|discord-api-types)["']/i, initialization: /\bnew\s+Client\s*\(/i, initializationRequiresContext: true },
  { key: "sentry", service: "Sentry", plain: "Error monitoring through Sentry", packages: ["@sentry/node", "@sentry/nextjs", "@sentry/react", "@sentry/browser"], packagePrefixes: ["@sentry/"], imports: /(?:from|require\s*\()\s*["']@sentry\/[^"']+["']/i, initialization: /\bSentry\.init\s*\(/i, initializationRequiresContext: true },
  { key: "algolia", service: "Algolia", plain: "Search through Algolia", packages: ["algoliasearch"], imports: /(?:from|require\s*\()\s*["']algoliasearch["']/i, initialization: /\b(?:algoliasearch|algolia)\s*\(/i, initializationRequiresContext: true },
  { key: "posthog", service: "PostHog", plain: "Product analytics through PostHog", packages: ["posthog-node", "posthog-js"], imports: /(?:from|require\s*\()\s*["'](?:posthog-node|posthog-js)["']/i, initialization: /\bnew\s+PostHog\s*\(/i, initializationRequiresContext: true },
  { key: "github", service: "GitHub API", plain: "Repository operations through the GitHub API", packages: ["octokit", "@octokit/rest"], imports: /(?:from|require\s*\()\s*["'](?:octokit|@octokit\/rest)["']/i, initialization: /\bnew\s+Octokit\s*\(/i },
  { key: "hubspot", service: "HubSpot", plain: "CRM operations through HubSpot", packages: ["@hubspot/api-client"], imports: /(?:from|require\s*\()\s*["']@hubspot\/api-client["']/i, initialization: /\b(?:hubspot|Client)\./i, initializationRequiresContext: true },
];

function matchingPackages(dependencies: Set<string>, rule: IntegrationRule, budget?: AnalysisBudget): string[] {
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

function integrationFinding(rule: IntegrationRule, evidence: EvidenceReference[], evidenceType: ExternalIntegrationFinding["evidenceType"], confidence: ExternalIntegrationFinding["confidence"], detail: string, packageName?: string, budget?: AnalysisBudget): ExternalIntegrationFinding {
  return {
    id: stableId("integration", rule.key),
    kind: "external-service",
    technicalLabel: rule.service,
    plainEnglishLabel: rule.plain,
    explanation: redactSecrets(`${rule.service} evidence was found ${detail}. The detector reports only static imports, dependencies, or client initialization patterns.`),
    technicalDetail: redactSecrets(packageName ? `package=${packageName}` : `service=${rule.key}`),
    confidence,
    evidence: uniqueEvidence(evidence, budget),
    service: rule.service,
    packageName,
    evidenceType,
  };
}

export function analyzeExternalIntegrations(files: RepositoryFile[], budget?: AnalysisBudget): ExternalIntegrationFinding[] {
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
  const findings: ExternalIntegrationFinding[] = [];
  for (const rule of integrationRules) {
    budget?.check();
    const packageMatches = matchingPackages(dependencies, rule, budget);
    const evidence: EvidenceReference[] = [];
    for (const name of packageMatches) {
      budget?.check();
      evidence.push(...packageDependencyEvidence(packageFile, name, `${rule.service} dependency ${name} is declared`));
    }
    let sourceEvidenceType: ExternalIntegrationFinding["evidenceType"] | undefined;
    const sourceFilesMatched: RepositoryFile[] = [];
    for (const file of analyzable) {
      budget?.check();
      const clean = withoutStandaloneComments(fileContent(file));
      const importMatch = rule.imports?.test(clean) ?? false;
      const initializationMatch = rule.initialization?.test(clean) ?? false;
      const identifiableInitialization = initializationMatch && (!rule.initializationRequiresContext || packageMatches.length > 0 || importMatch);
      if (!importMatch && !identifiableInitialization) continue;
      sourceFilesMatched.push(file);
      sourceEvidenceType = identifiableInitialization ? "client-initialization" : "import";
      evidence.push(evidenceForPattern(file, `${rule.service} import or client initialization`, identifiableInitialization ? rule.initialization : rule.imports));
    }
    if (!sourceFilesMatched.length) continue;
    const evidenceType = packageMatches.length ? "dependency" : sourceEvidenceType ?? "import";
    const confidence = packageMatches.length ? "high" : "medium";
    const detail = packageMatches.length ? `through declared package${packageMatches.length > 1 ? "s" : ""} ${packageMatches.join(", ")}` : `in ${sourceFilesMatched.map((file) => redactPath(safePath(file.path))).join(", ")}`;
    findings.push(integrationFinding(rule, evidence, evidenceType, confidence, detail, packageMatches[0], budget));
  }

  const httpEvidence: EvidenceReference[] = [];
  const httpFiles: RepositoryFile[] = [];
  for (const file of analyzable) {
    budget?.check();
    const clean = withoutStandaloneComments(fileContent(file));
    const axiosMatch = /(?:from|require\s*\()\s*["']axios["']|\baxios\.create\s*\(/i.test(clean);
    const fetchMatch = /\bfetch\s*\(\s*["'`]https?:\/\//i.test(clean);
    if (!axiosMatch && !fetchMatch) continue;
    httpFiles.push(file);
    httpEvidence.push(evidenceForPattern(file, axiosMatch ? "initializes a generic HTTP client" : "calls an external HTTP URL", axiosMatch ? /\baxios(?:\.create)?\s*\(/i : /\bfetch\s*\(\s*["'`]https?:\/\//i));
  }
  if (httpEvidence.length) {
    findings.push(integrationFinding({ key: "http-client", service: "External HTTP API", plain: "Calls to an external HTTP service", packages: [] }, httpEvidence, "http-client", "medium", `in ${httpFiles.map((file) => redactPath(safePath(file.path))).join(", ")}`, undefined, budget));
  }
  findings.sort((left, right) => { budget?.check(); return left.id.localeCompare(right.id); });
  budget?.check();
  return findings;
}

export const analyzeIntegrations = analyzeExternalIntegrations;
export const detectExternalIntegrations = analyzeExternalIntegrations;
export const findExternalIntegrations = analyzeExternalIntegrations;
export const analyzeExternalServices = analyzeExternalIntegrations;
export const detectIntegrations = analyzeExternalIntegrations;
