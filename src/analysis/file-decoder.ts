export type SkipReason =
  | "lfs-pointer"
  | "submodule"
  | "unsupported-encoding"
  | "path-collision"
  | "too-large"
  | "unsupported"
  | "limit-reached";

export interface DecodedFileContent {
  ok: boolean;
  content?: string;
  encoding?: string;
  reason?: SkipReason;
}

export function decodeFileBuffer(
  buffer: Uint8Array,
  options: { fetchLfs?: boolean; maxLfsBytes?: number } = {},
): DecodedFileContent {
  let encoding = "utf-8";
  let offset = 0;

  // Check BOM markers
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    encoding = "utf-8";
    offset = 3;
  } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = "utf-16le";
    offset = 2;
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = "utf-16be";
    offset = 2;
  }

  let text: string;
  try {
    const decoder = new TextDecoder(encoding, { fatal: true });
    text = decoder.decode(buffer.subarray(offset));
  } catch {
    return { ok: false, reason: "unsupported-encoding" };
  }

  // Detect Git LFS pointers:
  // First line: version https://git-lfs.github.com/spec/v1
  // Size under 1 KB
  if (buffer.length < 1024) {
    const firstLine = text.split(/\r?\n/)[0]?.trim();
    if (firstLine === "version https://git-lfs.github.com/spec/v1") {
      const fetchLfs = options.fetchLfs ?? (process.env.FETCH_LFS === "true");
      if (!fetchLfs) {
        return { ok: false, reason: "lfs-pointer" };
      }
      const maxLfsBytes = options.maxLfsBytes ?? (Number(process.env.MAX_LFS_BYTES) || 5 * 1024 * 1024);
      if (buffer.length > maxLfsBytes) {
        return { ok: false, reason: "too-large" };
      }
    }
  }

  return { ok: true, content: text, encoding };
}

export function normalizeRepositoryPath(filePath: string): string {
  return filePath.normalize("NFC");
}

export function detectCaseCollisions(paths: string[]): {
  collisions: Array<{ path: string; reason: SkipReason }>;
  warnings: string[];
  safePaths: Set<string>;
} {
  const seen = new Map<string, string>();
  const collisions: Array<{ path: string; reason: SkipReason }> = [];
  const warnings: string[] = [];
  const safePaths = new Set<string>();

  for (const rawPath of paths) {
    const normalized = normalizeRepositoryPath(rawPath);
    const lower = normalized.toLowerCase();
    const existing = seen.get(lower);
    if (existing && existing !== normalized) {
      collisions.push({ path: normalized, reason: "path-collision" });
      warnings.push(`Case-insensitive path collision detected between "${existing}" and "${normalized}".`);
    } else {
      seen.set(lower, normalized);
      safePaths.add(normalized);
    }
  }

  return { collisions, warnings, safePaths };
}
