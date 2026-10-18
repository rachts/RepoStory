import type { AnalysisBudget } from "@/shared/limits";

const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const CONNECTION_STRING_PATTERN = /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver):\/\/|jdbc(?::[a-z][a-z0-9+.-]*)?:\/\/)([^\s"'`]+)/gi;
const BEARER_PATTERN = /(\b(?:authorization\s*[:=]\s*)?bearer\s+)(["']?)([^\s,"';]+)\2/gi;

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{4,}\b/g, "[REDACTED_STRIPE_KEY]"],
  [/\bwhsec_[A-Za-z0-9_-]{4,}\b/g, "[REDACTED_STRIPE_KEY]"],
  [/\bsk-(?:proj|admin|svcacct|live|test)-[A-Za-z0-9_-]{4,}\b/g, "[REDACTED_OPENAI_KEY]"],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "[REDACTED_OPENAI_KEY]"],
  [/\bxox(?:b|p|a|s|e)-[A-Za-z0-9-]{3,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/https?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){2,}/gi, "[REDACTED_SLACK_WEBHOOK]"],
  [/\bSG\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{4,})?\b/g, "[REDACTED_SENDGRID_KEY]"],
  [/\b(?:gh[pousrl]_[A-Za-z0-9_-]{4,}|github_pat_[A-Za-z0-9_-]{4,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
];

const SECRET_WORDS = new Set([
  "apikey",
  "authorization",
  "accesskey",
  "authtoken",
  "bearer",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "passwd",
  "passphrase",
  "privatekey",
  "secret",
  "sessiontoken",
  "signingsecret",
  "token",
  "webhooksecret",
]);

const COMPOUND_SECRET_WORDS = new Set([
  "apikey",
  "accesskey",
  "authtoken",
  "clientsecret",
  "amqpconnection",
  "amqpdsn",
  "amqpuri",
  "amqpurl",
  "amqpsconnection",
  "amqpsdsn",
  "amqpsuri",
  "amqpsurl",
  "connectiondsn",
  "connectionstring",
  "connectionuri",
  "connectionurl",
  "databaseconnection",
  "databasedsn",
  "databaseuri",
  "databaseurl",
  "dbconnection",
  "dbdsn",
  "dburi",
  "dburl",
  "directdsn",
  "directuri",
  "directurl",
  "jdbcconnection",
  "jdbcstring",
  "jdbcuri",
  "jdbcurl",
  "mongodbconnection",
  "mongodbdsn",
  "mongodburi",
  "mongodburl",
  "mongoconnection",
  "mongodsn",
  "mongouri",
  "mongourl",
  "mssqlconnection",
  "mssqldsn",
  "mssqluri",
  "mssqlurl",
  "mysqlconnection",
  "mysqldsn",
  "mysqluri",
  "mysqlurl",
  "postgresconnection",
  "postgresdsn",
  "postgresuri",
  "postgresurl",
  "postgresqlconnection",
  "postgresqldsn",
  "postgresqluri",
  "postgresqlurl",
  "privatekey",
  "redisconnection",
  "redisdsn",
  "redisuri",
  "redisurl",
  "redissconnection",
  "redissdsn",
  "redissuri",
  "redissurl",
  "sessiontoken",
  "sqlserverconnection",
  "sqlserverdsn",
  "sqlserveruri",
  "sqlserverurl",
  "signingsecret",
  "webhooksecret",
]);

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSecretKey(key: string): boolean {
  const words = keyWords(key);
  if (!words.length) return false;
  const compact = words.join("");
  return words.some((word) => SECRET_WORDS.has(word)) || [...COMPOUND_SECRET_WORDS].some((word) => compact.includes(word));
}

const DYNAMIC_REFERENCE_PATTERN = /^(?:(?:process\.env|import\.meta\.env|env|config|settings|secrets|vault)(?:\.[A-Za-z_][A-Za-z0-9_]*|\[["']?[A-Za-z_][A-Za-z0-9_]*["']?\]|\(["']?[A-Za-z_][A-Za-z0-9_]*["']?\))|\$\{[A-Z][A-Z0-9_]*\}|\$[A-Z][A-Z0-9_]*)$/;

function isDynamicReference(value: string): boolean {
  return DYNAMIC_REFERENCE_PATTERN.test(value.trim());
}

function isAlreadyRedacted(value: string): boolean {
  return value.includes("[REDACTED");
}

function redactValue(value: string): string {
  return !value || /^(?:any|bearer|boolean|false|never|null|number|object|string|true|undefined|unknown|void)$/i.test(value) || isAlreadyRedacted(value) || isDynamicReference(value) ? value : "[REDACTED]";
}

function redactQuotedKeys(text: string): string {
  return text.replace(
    /(["'])([A-Za-z][A-Za-z0-9_. -]{0,100})\1(\s*:\s*)(?:("|')([^\r\n]*?)\4|(?!["'])([^\s,#}\]]+))/g,
    (match: string, keyQuote: string, key: string, separator: string, valueQuote: string | undefined, quotedValue: string | undefined, bareValue: string | undefined) => {
      if (!isSecretKey(key)) return match;
      const value = quotedValue ?? bareValue ?? "";
      const replacement = redactValue(value);
      if (replacement === value) return match;
      const redactedValue = valueQuote ? `${valueQuote}${replacement}${valueQuote}` : replacement;
      return `${keyQuote}${key}${keyQuote}${separator}${redactedValue}`;
    },
  );
}

function redactUnquotedKeys(text: string): string {
  return text.replace(
    /(^[ \t]*(?:-[ \t]*)?|[\n\r,;{][ \t]*)([A-Za-z][A-Za-z0-9_.-]{0,100})(\s*:\s*)(?:(\"|')([^\r\n]*?)\4|(?!["'])([^\s,#}\]]+))/gm,
    (match: string, prefix: string, key: string, separator: string, valueQuote: string | undefined, quotedValue: string | undefined, bareValue: string | undefined) => {
      if (!isSecretKey(key)) return match;
      const value = quotedValue ?? bareValue ?? "";
      const replacement = redactValue(value);
      if (replacement === value) return match;
      const redactedValue = valueQuote ? `${valueQuote}${replacement}${valueQuote}` : replacement;
      return `${prefix}${key}${separator}${redactedValue}`;
    },
  );
}

function redactAssignments(text: string): string {
  return text.replace(
    /(^[ \t]*(?:(?:export|const|let|var)[ \t]+)?|[\n\r,;{}][ \t]*(?:(?:export|const|let|var)[ \t]+)?)([A-Za-z][A-Za-z0-9_.-]{0,100})([ \t]*=[ \t]*)(?:(\"|')([^\r\n]*?)\4|(?!["'])([^\s,;}\]]+))/gm,
    (match: string, prefix: string, key: string, separator: string, valueQuote: string | undefined, quotedValue: string | undefined, bareValue: string | undefined) => {
      if (!isSecretKey(key)) return match;
      const value = quotedValue ?? bareValue ?? "";
      const replacement = redactValue(value);
      if (replacement === value) return match;
      const redactedValue = valueQuote ? `${valueQuote}${replacement}${valueQuote}` : replacement;
      return `${prefix}${key}${separator}${redactedValue}`;
    },
  );
}

export function redactSecrets(text: string): string {
  let redacted = text
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]")
    .replace(CONNECTION_STRING_PATTERN, (_match, scheme: string, remainder: string) => {
      const at = remainder.lastIndexOf("@");
      return at >= 0 ? `${scheme}[REDACTED_CONNECTION_STRING]@${remainder.slice(at + 1)}` : `${scheme}[REDACTED_CONNECTION_STRING]`;
    })
    .replace(BEARER_PATTERN, (_match, prefix: string, quote: string) => `${prefix}${quote}[REDACTED_TOKEN]${quote}`);

  for (const [pattern, replacement] of TOKEN_PATTERNS) redacted = redacted.replace(pattern, replacement);
  redacted = redactQuotedKeys(redacted);
  redacted = redactUnquotedKeys(redacted);
  redacted = redactAssignments(redacted);
  return redacted;
}

const PATH_SECRET_KEY_PATTERN = /(?:api[._-]?key|access[._-]?key|auth[._-]?token|client[._-]?secret|credential|password|passwd|passphrase|private[._-]?key|session[._-]?token|secret|signing[._-]?secret|webhook[._-]?secret)/i;
const PATH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,}$/;
const PATH_SECRET_SUFFIX_PATTERN = /(?:api[._-]?key|access[._-]?key|auth[._-]?token|client[._-]?secret|credential|password|passwd|passphrase|private[._-]?key|session[._-]?token|secret|signing[._-]?secret|webhook[._-]?secret)[._-]+([A-Za-z0-9][A-Za-z0-9_-]{3,})$/i;
const OPAQUE_ID_PATTERN = /^(?:analysis|diagram|export)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function looksLikeCredentialPathSegment(segment: string): boolean {
  const match = segment.match(PATH_SECRET_SUFFIX_PATTERN);
  if (!match?.[1]) return false;
  return !/^(?:config|example|form|login|reset|route|test|template|value)$/i.test(match[1]);
}

function looksLikeHighEntropyPathSegment(segment: string): boolean {
  if (OPAQUE_ID_PATTERN.test(segment)) return false;
  if (!PATH_TOKEN_PATTERN.test(segment)) return false;
  const compact = segment.replace(/[-_]/g, "");
  const uniqueCharacters = new Set(compact).size;
  const digitCount = (compact.match(/\d/g) ?? []).length;
  const hasMixedCase = /[a-z]/.test(compact) && /[A-Z]/.test(compact);
  const separatorCount = (segment.match(/[-_]/g) ?? []).length;
  return uniqueCharacters >= 12 && digitCount >= 2 && (hasMixedCase || separatorCount === 0 && uniqueCharacters >= 16);
}

function redactPathSegment(segment: string): string {
  const redacted = redactSecrets(segment);
  if (redacted !== segment) return redacted;
  if (looksLikeHighEntropyPathSegment(segment) || (PATH_SECRET_KEY_PATTERN.test(segment) && looksLikeCredentialPathSegment(segment))) return "[REDACTED_PATH_SEGMENT]";
  return segment;
}

/** Redact token-like path segments without changing path separators or ordinary names. */
export function redactPath(filePath: string): string {
  const redacted = redactSecrets(filePath);
  return redacted
    .split(/([\\/]+)/)
    .map((part) => /[\\/]+/.test(part) ? part : redactPathSegment(part))
    .join("");
}

/** Sanitize nested API/domain payloads while preserving their original shape and types. */
export function redactPathValues<T>(value: T, budget?: AnalysisBudget): T {
  const visit = (current: unknown): unknown => {
    budget?.check();
    if (typeof current === "string") return redactPath(current);
    if (Array.isArray(current)) {
      const result: unknown[] = [];
      for (const item of current) {
        budget?.check();
        result.push(visit(item));
      }
      budget?.check();
      return result;
    }
    if (!current || typeof current !== "object") return current;
    if (current instanceof Date) return current;

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current)) {
      budget?.check();
      result[key] = visit(item);
    }
    budget?.check();
    return result;
  };

  return visit(value) as T;
}

const SAFE_ENV_BASENAME = /^\.env\.(?:example|sample|template)$/i;
const ENV_BASENAME = /^\.env(?:\..+)?$/i;
const SECRET_BASENAME = /(?:^|[._-])(?:api[._-]?key|access[._-]?key|auth[._-]?token|creds?|credentials?|secrets?|passwords?|passphrase|private[._-]?key|service[._-]?account|id[_-]?(?:rsa|dsa|ecdsa|ed25519))(?:$|[._-])/i;
const SECRET_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore)$/i;
const KNOWN_SECRET_BASENAMES = new Set([".dockerconfigjson", ".netrc", ".npmrc", ".pypirc", ".htpasswd"]);

export function isSecretBearingPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/\/+$/, "");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  if (!basename || SAFE_ENV_BASENAME.test(basename)) return false;
  return ENV_BASENAME.test(basename) || SECRET_BASENAME.test(basename) || SECRET_EXTENSION.test(basename) || KNOWN_SECRET_BASENAMES.has(basename);
}
