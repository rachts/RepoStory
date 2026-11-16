interface TokenState {
  token: string;
  remaining: number;
  resetAt: number;
}

export class GitHubTokenPool {
  private readonly tokens: TokenState[];
  private readonly overrideTokens = new Map<string, TokenState>();
  private warnedAnonymous = false;

  public constructor(tokens?: string[] | string) {
    const rawTokens = typeof tokens === "string"
      ? tokens.split(",").map((t) => t.trim()).filter(Boolean)
      : Array.isArray(tokens)
        ? tokens.map((t) => t.trim()).filter(Boolean)
        : (process.env.GITHUB_TOKENS?.split(",") || [process.env.GITHUB_TOKEN || ""]).map((t) => t.trim()).filter(Boolean);

    this.tokens = rawTokens.map((token) => ({
      token,
      remaining: 5000,
      resetAt: 0,
    }));
  }

  public get tokenCount(): number {
    return this.tokens.length;
  }

  public getBestToken(preferredToken?: string): string | undefined {
    if (preferredToken && typeof preferredToken === "string") {
      const clean = preferredToken.trim();
      if (clean) {
        let override = this.overrideTokens.get(clean);
        if (!override) {
          override = { token: clean, remaining: 5000, resetAt: 0 };
          this.overrideTokens.set(clean, override);
        }
        const now = Date.now();
        if (override.remaining <= 0 && override.resetAt <= now) {
          override.remaining = 5000;
        }
        if (override.remaining > 0) {
          return override.token;
        }
        // If preferred token is exhausted, fall back to best server token below
      }
    }

    if (this.tokens.length === 0) {
      if (!this.warnedAnonymous) {
        console.warn("[GitHub Token Pool] No GITHUB_TOKENS or GITHUB_TOKEN configured. Falling back to anonymous access with strict rate limits.");
        this.warnedAnonymous = true;
      }
      return undefined;
    }

    const now = Date.now();
    // Reset any tokens whose reset time has passed
    for (const t of this.tokens) {
      if (t.remaining <= 0 && t.resetAt <= now) {
        t.remaining = 5000;
      }
    }

    // Sort by remaining descending
    const sorted = [...this.tokens].sort((a, b) => b.remaining - a.remaining);
    return sorted[0]?.token;
  }

  public updateRateLimit(
    token: string | undefined,
    remainingHeader?: string | number | null,
    resetHeader?: string | number | null,
  ): void {
    if (!token) return;
    let target = this.tokens.find((t) => t.token === token) ?? this.overrideTokens.get(token);
    if (!target) {
      target = { token, remaining: 5000, resetAt: 0 };
      this.overrideTokens.set(token, target);
    }

    if (remainingHeader !== undefined && remainingHeader !== null) {
      const parsed = typeof remainingHeader === "number" ? remainingHeader : (/^\d+$/.test(remainingHeader) ? Number(remainingHeader) : undefined);
      if (parsed !== undefined) {
        target.remaining = parsed;
      }
    }
    if (resetHeader !== undefined && resetHeader !== null) {
      const parsed = typeof resetHeader === "number" ? resetHeader : (/^\d+$/.test(resetHeader) ? Number(resetHeader) : undefined);
      if (parsed !== undefined) {
        target.resetAt = parsed > 1e11 ? parsed : parsed * 1000;
      }
    }
  }

  public markExhausted(token: string | undefined, resetAtEpochSeconds?: number): void {
    if (!token) return;
    let target = this.tokens.find((t) => t.token === token) ?? this.overrideTokens.get(token);
    if (!target) {
      target = { token, remaining: 5000, resetAt: 0 };
      this.overrideTokens.set(token, target);
    }
    target.remaining = 0;
    target.resetAt = resetAtEpochSeconds ? resetAtEpochSeconds * 1000 : Date.now() + 60_000;
  }
}
