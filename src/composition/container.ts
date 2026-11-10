import { runAnalysis as runAnalysisPipeline, type AnalysisRunOptions } from "@/application/pipeline";
import { InMemoryAnalysisStore, type AnalysisStore } from "@/application/store";
import type { AnalysisJobRepository } from "@/application/jobs/analysis-job-repository";
import { AnalysisJobRunner } from "@/application/jobs/analysis-job-runner";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";
import { FileAnalysisJobRepository } from "@/infrastructure/jobs/file-analysis-job-repository";
import { SupabaseAnalysisJobRepository } from "@/infrastructure/jobs/supabase-analysis-job-repository";
import type { CacheStore } from "@/application/cache/cache-store";
import { InMemoryCacheStore } from "@/infrastructure/cache/in-memory-cache-store";
import { SupabaseCacheStore } from "@/infrastructure/cache/supabase-cache-store";
import { serverConfig } from "@/shared/config";
import type { AnalysisJob } from "@/domain/analysis";
import type { JobQueue } from "@/application/jobs/job-queue";
import { InMemoryJobQueue } from "@/infrastructure/jobs/in-memory-job-queue";
import { SupabaseJobQueue } from "@/infrastructure/jobs/supabase-job-queue";
import { AppError } from "@/domain/errors";
import type { RepositoryProvider, RepositoryReference } from "@/domain/repository";
import { err, type Result } from "@/shared/result";
import { getProductionConfigError } from "@/config/production-guards";

const globalContainer = globalThis as typeof globalThis & {
  repoStoryStore?: InMemoryAnalysisStore;
  repoStoryAnalysisRepository?: AnalysisJobRepository;
  repoStoryJobRunner?: AnalysisJobRunner;
  repoStoryJobQueue?: JobQueue;
  repoStoryCacheStore?: CacheStore;
};

function createLazyProxy<T extends object>(getExisting: () => T | undefined, factory: () => T): T {
  let instance: T | null = null;
  const resolveInstance = (): T => {
    const existing = getExisting();
    if (existing) return existing;
    if (!instance) {
      const configError = getProductionConfigError();
      if (configError) {
        throw configError;
      }
      instance = factory();
    }
    return instance;
  };

  return new Proxy({} as T, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      const instance = resolveInstance();
      const value = Reflect.get(instance, prop, receiver);
      return typeof value === "function" ? value.bind(instance) : value;
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver);
    },
    has(target, prop) {
      return prop in target || Reflect.has(resolveInstance(), prop);
    },
    ownKeys(target) {
      const instanceKeys = Reflect.ownKeys(resolveInstance());
      const targetKeys = Reflect.ownKeys(target);
      return Array.from(new Set([...instanceKeys, ...targetKeys]));
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop in target) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }
      return Reflect.getOwnPropertyDescriptor(resolveInstance(), prop);
    },
  });
}

function initCacheStore(): CacheStore {
  const store =
    serverConfig.cacheStoreMode === "supabase" && serverConfig.supabaseUrl && serverConfig.supabaseSecretKey
      ? new SupabaseCacheStore({ url: serverConfig.supabaseUrl, secretKey: serverConfig.supabaseSecretKey })
      : new InMemoryCacheStore();
  globalContainer.repoStoryCacheStore = store;
  return store;
}

function initAnalysisStore(): InMemoryAnalysisStore {
  const store = new InMemoryAnalysisStore({
    maxAnalyses: serverConfig.maxAnalyses,
    ttlMs: serverConfig.analysisTtlMs,
    isScratch: serverConfig.jobStoreMode !== "memory",
  });
  globalContainer.repoStoryStore = store;
  return store;
}

function initRepositoryProvider(): GitHubPublicRepositoryProvider {
  return new GitHubPublicRepositoryProvider({
    token: serverConfig.githubToken,
    cacheStore,
  });
}

function initAnalysisRepository(): AnalysisJobRepository {
  const repo =
    serverConfig.jobStoreMode === "supabase"
      ? new SupabaseAnalysisJobRepository({
          url: serverConfig.supabaseUrl,
          secretKey: serverConfig.supabaseSecretKey,
          maxAnalyses: serverConfig.maxAnalyses,
          ttlMs: serverConfig.jobTtlMs,
        })
      : serverConfig.jobStoreMode === "file"
        ? new FileAnalysisJobRepository({
            filePath: serverConfig.jobStorePath,
            maxAnalyses: serverConfig.maxAnalyses,
            ttlMs: serverConfig.jobTtlMs,
          })
        : (globalContainer.repoStoryStore ?? initAnalysisStore());
  globalContainer.repoStoryAnalysisRepository = repo;
  return repo;
}

function initJobQueue(): JobQueue {
  const queue =
    serverConfig.queueMode === "supabase"
      ? new SupabaseJobQueue({
          url: serverConfig.supabaseUrl,
          secretKey: serverConfig.supabaseSecretKey,
          heartbeatTimeoutMs: process.env.WORKER_HEARTBEAT_TIMEOUT_MS
            ? Number(process.env.WORKER_HEARTBEAT_TIMEOUT_MS)
            : 120_000,
        })
      : new InMemoryJobQueue();
  globalContainer.repoStoryJobQueue = queue;
  return queue;
}

function initAnalysisJobRunner(): AnalysisJobRunner {
  const runner = new AnalysisJobRunner(analysisRepository, repositoryProvider);
  if (process.env.NODE_ENV === "production") {
    globalContainer.repoStoryJobRunner = runner;
  }
  return runner;
}

export const cacheStore: CacheStore = createLazyProxy(
  () => globalContainer.repoStoryCacheStore,
  initCacheStore,
);

export const analysisStore: InMemoryAnalysisStore = createLazyProxy(
  () => globalContainer.repoStoryStore,
  initAnalysisStore,
);

export const repositoryProvider: GitHubPublicRepositoryProvider = createLazyProxy(
  () => undefined,
  initRepositoryProvider,
);

export const analysisRepository: AnalysisJobRepository = createLazyProxy(
  () => globalContainer.repoStoryAnalysisRepository,
  initAnalysisRepository,
);

export const jobQueue: JobQueue = createLazyProxy(
  () => globalContainer.repoStoryJobQueue,
  initJobQueue,
);

export const analysisJobRunner: AnalysisJobRunner = createLazyProxy(
  () => (process.env.NODE_ENV === "production" ? globalContainer.repoStoryJobRunner : undefined),
  initAnalysisJobRunner,
);

const MAX_ACTIVE_ANALYSES = 2;
let activeAnalyses = 0;

/** Bound synchronous upstream work so a burst cannot multiply fetch and analysis memory. */
export async function runAnalysis(
  reference: RepositoryReference,
  provider: RepositoryProvider,
  store: AnalysisStore,
  options?: AnalysisRunOptions,
): Promise<Result<AnalysisJob, AppError>> {
  if (activeAnalyses >= MAX_ACTIVE_ANALYSES) {
    return err(new AppError({ code: "ANALYSIS_BUSY", message: "Too many analyses are already running. Please retry shortly.", retryable: true }));
  }

  activeAnalyses += 1;
  try {
    return await runAnalysisPipeline(reference, provider, store, {
      cacheStore,
      ...options,
    });
  } finally {
    activeAnalyses -= 1;
  }
}
