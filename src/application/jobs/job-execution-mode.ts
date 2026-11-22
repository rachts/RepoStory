export const ANALYSIS_ROUTE_MAX_DURATION_SECONDS = 60;

export function shouldRunInProcessJobs(): boolean {
  if (process.env.IN_PROCESS_JOBS !== undefined) {
    return process.env.IN_PROCESS_JOBS.toLowerCase() === "true";
  }
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  return true;
}
