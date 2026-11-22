import crypto from "node:crypto";
import { AppError } from "@/domain/errors";

export interface EncryptedTokenPayload {
  version: number;
  iv: string; // base64
  tag: string; // base64
  ciphertext: string; // base64
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM

export function getTokenEncryptionKey(overrideKey?: string): Buffer {
  const envKey = overrideKey ?? process.env.REPO_STORY_TOKEN_ENCRYPTION_KEY;
  if (envKey) {
    const trimmed = envKey.trim();
    // Support 32-byte hex string (64 characters)
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return Buffer.from(trimmed, "hex");
    }
    // Support 32-byte base64 string
    const base64Buf = Buffer.from(trimmed, "base64");
    if (base64Buf.length === 32) {
      return base64Buf;
    }
    // Deterministic 32-byte SHA-256 hash of arbitrary secret string
    return crypto.createHash("sha256").update(trimmed).digest();
  }

  if (process.env.NODE_ENV === "production") {
    throw new AppError({
      code: "CONFIG_ERROR",
      message: "[RepoStory Config Error] REPO_STORY_TOKEN_ENCRYPTION_KEY is required to encrypt private repo tokens in production.",
      retryable: false,
    });
  }

  // Deterministic dev/test fallback key (strictly non-production)
  return crypto.createHash("sha256").update("repo-story-dev-token-encryption-key-fallback").digest();
}

export function encryptToken(token: string, keyOrSecret?: Buffer | string): EncryptedTokenPayload {
  const key = Buffer.isBuffer(keyOrSecret)
    ? keyOrSecret
    : getTokenEncryptionKey(typeof keyOrSecret === "string" ? keyOrSecret : undefined);

  if (key.length !== 32) {
    throw new Error("Encryption key must be exactly 32 bytes for AES-256-GCM");
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(token, "utf8")),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptToken(payload: EncryptedTokenPayload, keyOrSecret?: Buffer | string): string {
  const key = Buffer.isBuffer(keyOrSecret)
    ? keyOrSecret
    : getTokenEncryptionKey(typeof keyOrSecret === "string" ? keyOrSecret : undefined);

  if (key.length !== 32) {
    throw new Error("Encryption key must be exactly 32 bytes for AES-256-GCM");
  }

  if (!payload || typeof payload !== "object" || !payload.iv || !payload.tag || !payload.ciphertext) {
    throw new AppError({
      code: "INVALID_TOKEN_PAYLOAD",
      message: "Encrypted token payload is malformed.",
      retryable: false,
    });
  }

  try {
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const ciphertext = Buffer.from(payload.ciphertext, "base64");

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  } catch {
    throw new AppError({
      code: "TOKEN_DECRYPTION_FAILED",
      message: "Failed to decrypt repository token. Ciphertext may be tampered or encryption key changed.",
      retryable: false,
    });
  }
}

export interface TokenEntry {
  token: string;
  expiresAt: number;
}

export class JobTokenRegistry extends Map<string, TokenEntry> {
  public setToken(jobId: string, token: string, ttlMs = 15 * 60 * 1000): void {
    super.set(jobId, { token, expiresAt: Date.now() + ttlMs });
  }

  public getToken(jobId: string): string | undefined {
    const entry = super.get(jobId);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      super.delete(jobId);
      return undefined;
    }
    return entry.token;
  }
}

export const jobTokenRegistry = new JobTokenRegistry();
