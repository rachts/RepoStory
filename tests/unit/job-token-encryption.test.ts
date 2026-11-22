import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptToken,
  decryptToken,
  getTokenEncryptionKey,
  JobTokenRegistry,
  type EncryptedTokenPayload,
} from "@/infrastructure/jobs/job-token-registry";
import crypto from "node:crypto";

describe("Fix 8: Private-Repo Tokens Encrypted in Queue (AES-256-GCM)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("encrypts and decrypts token successfully with default dev key", () => {
    delete process.env.REPO_STORY_TOKEN_ENCRYPTION_KEY;
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";

    const secretToken = "ghp_secure_personal_access_token_123456789";
    const encrypted = encryptToken(secretToken);

    expect(encrypted.version).toBe(1);
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.tag).toBeDefined();
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.ciphertext).not.toBe(secretToken);

    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(secretToken);
  });

  it("uses custom REPO_STORY_TOKEN_ENCRYPTION_KEY (hex or base64 or pass-phrase)", () => {
    const rawKey = crypto.randomBytes(32).toString("hex");
    process.env.REPO_STORY_TOKEN_ENCRYPTION_KEY = rawKey;

    const secretToken = "github_pat_super_secret_oauth_token";
    const encrypted = encryptToken(secretToken);
    const decrypted = decryptToken(encrypted);

    expect(decrypted).toBe(secretToken);
  });

  it("rejects decryption with the wrong key", () => {
    const key1 = crypto.randomBytes(32);
    const key2 = crypto.randomBytes(32);

    const secretToken = "gho_token_test_wrong_key";
    const encrypted = encryptToken(secretToken, key1);

    expect(() => decryptToken(encrypted, key2)).toThrowError(
      /Failed to decrypt repository token/,
    );
  });

  it("rejects tampered ciphertext", () => {
    const key = crypto.randomBytes(32);
    const secretToken = "gho_token_test_tamper_body";
    const encrypted = encryptToken(secretToken, key);

    // Tamper with the ciphertext base64
    const cipherBuf = Buffer.from(encrypted.ciphertext, "base64");
    cipherBuf[0] = cipherBuf[0]! ^ 0xff; // Flip bits
    const tamperedPayload: EncryptedTokenPayload = {
      ...encrypted,
      ciphertext: cipherBuf.toString("base64"),
    };

    expect(() => decryptToken(tamperedPayload, key)).toThrowError(
      /Failed to decrypt repository token/,
    );
  });

  it("rejects tampered auth tag", () => {
    const key = crypto.randomBytes(32);
    const secretToken = "gho_token_test_tamper_tag";
    const encrypted = encryptToken(secretToken, key);

    // Tamper with auth tag
    const tagBuf = Buffer.from(encrypted.tag, "base64");
    tagBuf[0] = tagBuf[0]! ^ 0x01; // Flip bit
    const tamperedPayload: EncryptedTokenPayload = {
      ...encrypted,
      tag: tagBuf.toString("base64"),
    };

    expect(() => decryptToken(tamperedPayload, key)).toThrowError(
      /Failed to decrypt repository token/,
    );
  });

  it("rejects tampered IV", () => {
    const key = crypto.randomBytes(32);
    const secretToken = "gho_token_test_tamper_iv";
    const encrypted = encryptToken(secretToken, key);

    // Tamper with IV
    const ivBuf = Buffer.from(encrypted.iv, "base64");
    ivBuf[0] = ivBuf[0]! ^ 0x01;
    const tamperedPayload: EncryptedTokenPayload = {
      ...encrypted,
      iv: ivBuf.toString("base64"),
    };

    expect(() => decryptToken(tamperedPayload, key)).toThrowError(
      /Failed to decrypt repository token/,
    );
  });

  it("throws CONFIG_ERROR in production when REPO_STORY_TOKEN_ENCRYPTION_KEY is unset", () => {
    delete process.env.REPO_STORY_TOKEN_ENCRYPTION_KEY;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";

    expect(() => getTokenEncryptionKey()).toThrowError(
      /REPO_STORY_TOKEN_ENCRYPTION_KEY is required/,
    );
  });

  it("JobTokenRegistry expires tokens after TTL and deletes them", async () => {
    const registry = new JobTokenRegistry();
    registry.setToken("job-123", "secret-token-val", 50); // 50ms TTL

    expect(registry.getToken("job-123")).toBe("secret-token-val");

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(registry.getToken("job-123")).toBeUndefined();
    expect(registry.has("job-123")).toBe(false);
  });
});
