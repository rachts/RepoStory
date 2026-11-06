interface TokenState {
  token: string;
  remaining: number;
  resetAt: number;
}

export class GitHubTokenPool {
  private readonly tokens: TokenState[];
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

  public getBestToken(): string | undefined {
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
    remainingHeader?: string | null,
    resetHeader?: string | null,
  ): void {
    if (!token) return;
    const target = this.tokens.find((t) => t.token === token);
    if (!target) return;

    if (remainingHeader && /^\d+$/.test(remainingHeader)) {
      target.remaining = Number(remainingHeader);
    }
    if (resetHeader && /^\d+$/.test(resetHeader)) {
      target.resetAt = Number(resetHeader) * 1000;
    }
  }

  public markExhausted(token: string | undefined, resetAtEpochSeconds?: number): void {
    if (!token) return;
    const target = this.tokens.find((t) => t.token === token);
    if (!target) return;
    target.remaining = 0;
    target.resetAt = resetAtEpochSeconds ? resetAtEpochSeconds * 1000 : Date.now() + 60_000;
  }
}
