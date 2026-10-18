import type { AnalysisJob } from "@/domain/analysis";
import type { Diagram } from "@/domain/diagram";
import { DEFAULT_STORE_LIMITS } from "@/shared/limits";
import { redactPathValues } from "@/shared/redaction";

export interface InMemoryAnalysisStoreOptions {
  maxAnalyses?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface AnalysisStore {
  save(job: AnalysisJob): void;
  get(id: string): AnalysisJob | undefined;
  update(job: AnalysisJob): void;
  saveDiagram(diagram: Diagram): void;
  getDiagram(id: string): Diagram | undefined;
  listDiagrams(analysisId: string): Diagram[];
  delete(id: string): void;
  resetDiagram(id: string): Diagram | undefined;
}

export class InMemoryAnalysisStore implements AnalysisStore {
  private readonly jobs = new Map<string, AnalysisJob>();
  private readonly diagrams = new Map<string, Diagram>();
  private readonly generatedDiagrams = new Map<string, Diagram>();
  private readonly entries = new Map<string, { lastAccessed: number; expiresAt: number }>();
  private readonly maxAnalyses: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  public constructor(options: InMemoryAnalysisStoreOptions = {}) {
    this.maxAnalyses = options.maxAnalyses ?? DEFAULT_STORE_LIMITS.maxAnalyses;
    this.ttlMs = options.ttlMs ?? DEFAULT_STORE_LIMITS.ttlMs;
    this.now = options.now ?? Date.now;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [analysisId, entry] of this.entries) if (entry.expiresAt <= now) this.removeAnalysis(analysisId);
  }

  private touch(analysisId: string): void {
    const now = this.now();
    this.entries.set(analysisId, { lastAccessed: now, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxAnalyses) {
      const oldest = [...this.entries.entries()].sort((left, right) => left[1].lastAccessed - right[1].lastAccessed)[0]?.[0];
      if (!oldest) break;
      this.removeAnalysis(oldest);
    }
  }

  private removeAnalysis(id: string): void {
    this.entries.delete(id);
    this.jobs.delete(id);
    for (const [diagramId, diagram] of this.diagrams) {
      if (diagram.analysisId !== id) continue;
      this.diagrams.delete(diagramId);
      this.generatedDiagrams.delete(diagramId);
    }
  }

  public save(job: AnalysisJob): void {
    this.purgeExpired();
    this.touch(job.id);
    this.jobs.set(job.id, structuredClone(redactPathValues(job)));
  }

  public update(job: AnalysisJob): void {
    this.save(job);
  }

  public get(id: string): AnalysisJob | undefined {
    this.purgeExpired();
    const job = this.jobs.get(id);
    if (job) this.touch(id);
    return job ? structuredClone(job) : undefined;
  }

  public saveDiagram(diagram: Diagram): void {
    this.purgeExpired();
    this.touch(diagram.analysisId);
    const safeDiagram = redactPathValues(diagram);
    if (!this.generatedDiagrams.has(diagram.id)) this.generatedDiagrams.set(diagram.id, structuredClone(safeDiagram));
    this.diagrams.set(diagram.id, structuredClone(safeDiagram));
  }

  public getDiagram(id: string): Diagram | undefined {
    this.purgeExpired();
    const diagram = this.diagrams.get(id);
    if (diagram) this.touch(diagram.analysisId);
    return diagram ? structuredClone(diagram) : undefined;
  }

  public listDiagrams(analysisId: string): Diagram[] {
    this.purgeExpired();
    if (this.entries.has(analysisId)) this.touch(analysisId);
    return [...this.diagrams.values()]
      .filter((diagram) => diagram.analysisId === analysisId)
      .map((diagram) => structuredClone(diagram));
  }

  public delete(id: string): void {
    this.removeAnalysis(id);
  }

  public resetDiagram(id: string): Diagram | undefined {
    this.purgeExpired();
    const original = this.generatedDiagrams.get(id);
    if (!original) return undefined;
    this.touch(original.analysisId);
    const reset = structuredClone(original);
    this.diagrams.set(id, reset);
    return structuredClone(reset);
  }
}
