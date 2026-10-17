import type { EvidenceReference } from "@/domain/evidence";
import { stableId } from "@/shared/ids";
import { lines, truncate } from "@/shared/text";
import type { RepositoryFile } from "@/domain/repository";
import { redactSecrets } from "@/shared/redaction";
import { DEFAULT_LIMITS } from "@/shared/limits";
export function evidenceFor(file: RepositoryFile, reason: string, pattern?: RegExp): EvidenceReference {
  const content = redactSecrets(file.content ?? ""); const index = pattern ? content.search(pattern) : 0; const lineStart = index < 0 ? 1 : content.slice(0, index).split(/\r?\n/).length;
  return { id: stableId("evidence", file.path, reason), filePath: file.path, lineStart, lineEnd: lineStart, excerpt: truncate(lines(content)[lineStart - 1] ?? "", DEFAULT_LIMITS.maxEvidenceExcerpt), reason };
}
