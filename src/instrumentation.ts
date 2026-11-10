export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { assertProductionGuards } = await import("@/config/production-guards");
      assertProductionGuards(process.env, false);
    } catch (error) {
      console.error(
        "[RepoStory] Production configuration failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
