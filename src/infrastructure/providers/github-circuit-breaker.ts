import { AppError } from "@/domain/errors";

export class GitHubCircuitBreaker {
  private consecutiveFailures = 0;
  private maxConsecutiveFailures: number;
  private openUntil = 0;

  public constructor(options: { maxConsecutiveFailures?: number } = {}) {
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
  }

  public check(): void {
    if (this.isOpen()) {
      throw new AppError({
        code: "GITHUB_RATE_LIMITED",
        message: "GitHub rate limit circuit breaker is open. Too many consecutive rate limit failures.",
        retryable: true,
        details: { retryAt: new Date(this.openUntil).toISOString() },
      });
    }
  }

  public isOpen(): boolean {
    return this.consecutiveFailures >= this.maxConsecutiveFailures && Date.now() < this.openUntil;
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

  public recordRateLimitFailure(resetEpochSeconds?: number): void {
    this.consecutiveFailures += 1;
    const retryAt = resetEpochSeconds ? resetEpochSeconds * 1000 : Date.now() + 60_000;
    this.openUntil = Math.max(this.openUntil, retryAt);

    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      throw new AppError({
        code: "GITHUB_RATE_LIMITED",
        message: "GitHub rate limit circuit breaker tripped after 3 consecutive rate limit failures.",
        retryable: true,
        details: { retryAt: new Date(this.openUntil).toISOString(), consecutiveFailures: this.consecutiveFailures },
      });
    }
  }
}
