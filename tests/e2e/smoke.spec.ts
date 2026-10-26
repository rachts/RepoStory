import { expect, test } from "@playwright/test";

test("landing page exposes the RepoStory analysis flow", async ({ page }) => {
  await page.goto("/");
  const brand = page.getByRole("link", { name: "RepoStory home" });
  await expect(brand.locator("img")).toHaveAttribute("alt", "");
  await expect(brand.locator("img")).toHaveAttribute("src", /repostory-icon-mark\.png/);
  await expect(page.locator(".hero-brand-icon")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Make your codebase make sense");
  await expect(page.getByLabel("Public GitHub repository URL")).toBeVisible();
  await expect(page.getByRole("button", { name: /Tell the story/i })).toBeVisible();
  await expect(page.getByText("From repository to story")).toBeVisible();
});

test("edits a deterministic diagram and exports the saved Markdown", async ({ page }) => {
  const diagram = {
    id: "e2e-diagram", analysisId: "e2e-analysis", type: "repository-structure", title: "Repository structure", description: "Original map", direction: "TB",
    nodes: [{ id: "repo", technicalLabel: "repo", plainEnglishLabel: "Repository", explanation: "The codebase.", kind: "directory", visible: true, confidence: "high", evidence: [{ id: "e2e-evidence", filePath: "README.md", lineStart: 1, reason: "Describes the repository." }] }],
    edges: [{ id: "repo-edge", source: "repo", target: "repo", label: "contains", visible: true, confidence: "high", evidence: [] }],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let currentDiagram = structuredClone(diagram);
  await page.route("**/api/analysis/**", async (route) => route.fulfill({ json: { id: "e2e-analysis", repository: { owner: "fixture", name: "small-react", url: "https://github.com/fixture/small-react", defaultBranch: "main", selectedBranch: "main", sizeBytes: 10, fileCount: 1 }, status: "completed", stage: "completed", progressPercent: 100, filesDiscovered: 1, filesAnalyzed: 1, technologies: [], findings: [], diagramIds: [diagram.id], diagrams: [currentDiagram], createdAt: "2026-01-01T00:00:00.000Z" } }));
  await page.route("**/api/diagrams/e2e-diagram", async (route) => {
    if (route.request().method() === "PATCH") {
      const patch = route.request().postDataJSON() as { title?: string; direction?: string; nodeUpdates?: Array<{ nodeId: string; plainEnglishLabel?: string; visible?: boolean }>; edgeUpdates?: Array<{ edgeId: string; visible?: boolean }> };
      currentDiagram = { ...currentDiagram, title: patch.title ?? currentDiagram.title, direction: patch.direction ?? currentDiagram.direction, nodes: currentDiagram.nodes.map((node) => ({ ...node, ...(patch.nodeUpdates?.find((update) => update.nodeId === node.id) ?? {}) })), edges: currentDiagram.edges.map((edge) => ({ ...edge, ...(patch.edgeUpdates?.find((update) => update.edgeId === edge.id) ?? {}) })) };
      await route.fulfill({ json: { diagram: currentDiagram } });
      return;
    }
    await route.fulfill({ json: { diagram: currentDiagram, mermaid: "flowchart TB" } });
  });
  await page.route("**/api/exports", async (route) => route.fulfill({ json: { content: "# Edited title\n```mermaid\nflowchart LR\n```", filename: "diagram.md", mimeType: "text/markdown" } }));
  await page.goto("/analysis/e2e-analysis");
  await expect(page.getByText("Repository structure").first()).toBeVisible();
  await page.getByLabel("Title").fill("Edited title");
  await page.getByRole("combobox", { name: "Element" }).selectOption("node:repo");
  await page.getByLabel("Plain-English label").fill("The repository map");
  await page.getByRole("combobox", { name: "Element" }).selectOption("edge:repo-edge");
  await page.getByRole("button", { name: "Hide selected element" }).click();
  await page.getByLabel("Direction").selectOption("LR");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Edited title");
  await expect(page.getByLabel("Direction")).toHaveValue("LR");
  await page.getByRole("button", { name: "Copy README Markdown" }).click();
});

test("explains a deterministic fixture in plain English before technical evidence", async ({ page }) => {
  const evidence = [{ id: "fixture-evidence", filePath: "src/app/page.tsx", lineStart: 1, reason: "Shows the web interface." }];
  const systemDiagram = {
    id: "fixture-system", analysisId: "fixture-analysis", type: "system-overview", title: "System overview", description: "A simplified overview.", direction: "LR",
    nodes: [
      { id: "system-person", technicalLabel: "Browser user", plainEnglishLabel: "Person in a browser", explanation: "A person opens the application.", kind: "person", visible: true, confidence: "medium", evidence },
      { id: "system-frontend", technicalLabel: "React frontend", plainEnglishLabel: "Web interface", explanation: "The part a person uses in the browser.", kind: "frontend", visible: true, confidence: "high", evidence },
      { id: "system-backend", technicalLabel: "Application server", plainEnglishLabel: "Application server", explanation: "The part that receives requests.", kind: "backend", visible: true, confidence: "medium", evidence },
    ],
    edges: [{ id: "fixture-system-edge", source: "system-person", target: "system-frontend", label: "opens", inferred: true, visible: true, confidence: "medium", evidence }],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const apiDiagram = {
    id: "fixture-api", analysisId: "fixture-analysis", type: "api-request-flow", title: "API request flow", description: "A request path.", direction: "LR",
    nodes: [{ id: "fixture-route", technicalLabel: "GET /api/items", plainEnglishLabel: "GET API endpoint at /api/items", explanation: "The application exposes a request handler.", kind: "api", visible: true, confidence: "high", evidence }], edges: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const story = {
    id: "fixture-story", headline: "How fixture-app works", summary: "This fixture-app application appears to provide a web interface that sends requests to application handlers and returns results to the browser.", plainEnglishSummary: "This fixture-app application appears to provide a web interface that sends requests to application handlers and returns results to the browser.", confidence: "medium", evidence,
    actors: [
      { id: "fixture-person", kind: "person", label: "Browser user", technicalLabel: "Browser user", plainEnglishLabel: "Person in a browser", explanation: "A person opens the application.", inferred: true, confidence: "medium", evidence, sourceNodeIds: ["system-person"], sourceDiagramTypes: ["system-overview"] },
      { id: "fixture-frontend", kind: "frontend", label: "React frontend", technicalLabel: "React frontend", plainEnglishLabel: "Web interface", explanation: "The browser-facing interface.", inferred: false, confidence: "high", evidence, sourceNodeIds: ["system-frontend"], sourceDiagramTypes: ["system-overview"] },
      { id: "fixture-backend", kind: "backend", label: "Application server", technicalLabel: "Application server", plainEnglishLabel: "Application server", explanation: "The request handler.", inferred: false, confidence: "medium", evidence, sourceNodeIds: ["system-backend"], sourceDiagramTypes: ["system-overview"] },
    ],
    steps: [{ id: "fixture-step", kind: "api", order: 1, layerId: "fixture-layer", title: "GET API endpoint at /api/items", plainEnglishTitle: "GET API endpoint at /api/items", technicalLabel: "GET /api/items", plainEnglishLabel: "GET API endpoint at /api/items", explanation: "The application exposes a request handler.", confidence: "high", evidence, sourceNodeIds: ["fixture-route"], targetNodeIds: [], sourceDiagramTypes: ["api-request-flow"] }],
    layers: [{ id: "fixture-layer", kind: "request", order: 1, label: "request-handling", technicalLabel: "request-handling", plainEnglishLabel: "Request handling", purpose: "Detected request handling.", explanation: "Detected request handling.", nodeIds: ["fixture-route"], actorIds: [], stepIds: ["fixture-step"], relationshipIds: [], confidence: "high", evidence, sourceDiagramTypes: ["api-request-flow"] }],
    relationships: [], caveats: [], coverage: { status: "complete", partial: false, filesAnalyzed: 3, filesDiscovered: 3, analyzedFiles: 3, discoveredFiles: 3, evidenceBackedFindings: 3, evidenceBackedElements: 4, availableDiagramTypes: ["system-overview", "api-request-flow"], unavailableDiagramTypes: [], diagramAvailability: [{ type: "system-overview", available: true }, { type: "api-request-flow", available: true }, { type: "repository-structure", available: false, reason: "Fixture omits it." }, { type: "authentication-flow", available: false, reason: "No authentication evidence." }], repositoryStructureAvailable: false, systemOverviewAvailable: true, apiRequestFlowAvailable: true, authenticationFlowAvailable: false, caveats: [] },
  };
  let exportRequest: Record<string, unknown> | undefined;
  await page.route("**/api/explain", async (route) => route.fulfill({ json: { analysisId: "fixture-analysis", model: "openai/gpt-oss-120b", generatedAt: "2026-01-01T00:00:00.000Z", explanation: {
    projectSummary: { title: "A browser-facing fixture application", oneSentence: "A browser-facing fixture application.", plainEnglish: "A person uses the web interface to interact with the application.", evidenceIds: ["fixture-evidence"], confidence: "medium" },
    architectureAtAGlance: { plainEnglish: "The browser-facing interface connects to application handlers.", layers: [{ name: "request-handling", simpleName: "Request handling", purpose: "Receives the supplied API request.", components: ["GET /api/items"], evidenceIds: ["fixture-evidence"], confidence: "high" }], evidenceIds: ["fixture-evidence"] },
    mainComponents: [{ name: "Web interface", simpleName: "Web interface", whatItDoes: "Displays the application in a browser.", whyItMatters: "It is the part a person uses.", location: "src/app/page.tsx", evidenceIds: ["fixture-evidence"], confidence: "high" }],
    howTheSystemWorks: [{ step: 1, title: "Open the interface", plainEnglish: "A person opens the web interface.", technicalDetail: "The supplied fixture contains browser-facing UI evidence.", evidenceIds: ["fixture-evidence"], confidence: "medium" }],
    userJourney: [{ step: 1, title: "Open the interface", plainEnglish: "A person opens the web interface.", relatedRoutes: ["/api/items"], relatedComponents: ["Web interface"], evidenceIds: ["fixture-evidence"] }],
    technologyGuide: [],
    apiGuide: [{ route: "/api/items", method: "GET", simplePurpose: "Returns items for the interface.", requestFlow: "The fixture exposes the route as a request entry point.", evidenceIds: ["fixture-evidence"], confidence: "high" }],
    dataAndIntegrations: [],
    securityAndAuthentication: { plainEnglish: "No authentication evidence was supplied by this fixture.", confirmedControls: [], unknowns: ["Authentication was not confirmed."], evidenceIds: [], confidence: "needs-verification" },
    glossary: [{ technicalTerm: "API route", simpleMeaning: "A named request endpoint.", projectSpecificMeaning: "Here it refers to GET /api/items." }],
    knownLimitations: ["This fixture uses static evidence."],
    confidenceNote: "The main claims have direct fixture evidence.",
  } } }));
  await page.route("**/api/analysis/**", async (route) => route.fulfill({ json: { id: "fixture-analysis", repository: { owner: "fixture", name: "fixture-app", url: "https://github.com/fixture/fixture-app", defaultBranch: "main", selectedBranch: "main", sizeBytes: 30, fileCount: 3 }, status: "completed", stage: "completed", progressPercent: 100, filesDiscovered: 3, filesAnalyzed: 3, technologies: [], findings: [], diagramIds: [systemDiagram.id, apiDiagram.id], diagrams: [systemDiagram, apiDiagram], architectureStory: story, createdAt: "2026-01-01T00:00:00.000Z" } }));
  await page.route("**/api/exports", async (route) => { exportRequest = route.request().postDataJSON(); await route.fulfill({ json: { content: "## How the application works\n```mermaid\nflowchart LR\n```", filename: "system-overview.md", mimeType: "text/markdown" } }); });
  await page.goto("/analysis/fixture-analysis");
  await expect(page.getByRole("heading", { level: 1, name: "How fixture-app works" })).toBeVisible();
  await expect(page.getByText("A person starts an action.")).toBeVisible();
  await page.getByRole("button", { name: "Explain this project" }).click();
  await expect(page.getByText("Evidence-backed explanation")).toBeVisible();
  await expect(page.getByText("A browser-facing fixture application.")).toBeVisible();
  await page.getByText("Evidence references (1)").first().click();
  await expect(page.getByText("src/app/page.tsx:1").first()).toBeVisible();
  await expect(page.getByLabel("How to read this diagram")).toBeVisible();
  await page.getByRole("combobox", { name: "Element" }).selectOption("node:system-frontend");
  await expect(page.getByRole("heading", { level: 3, name: "Web interface" }).first()).toBeVisible();
  await expect(page.getByText("What it does")).toBeVisible();
  await page.getByRole("button", { name: "Technical" }).click();
  await expect(page.getByRole("button", { name: "Technical" })).toHaveClass(/selected/);
  await page.getByRole("button", { name: "Copy README Markdown" }).click();
  await expect.poll(() => exportRequest).toMatchObject({ format: "markdown", includeArchitectureSummary: true });
});
