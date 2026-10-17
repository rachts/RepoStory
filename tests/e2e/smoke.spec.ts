import { expect, test } from "@playwright/test";

test("landing page exposes the RepoStory analysis flow", async ({ page }) => {
  await page.goto("/");
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
  await page.getByLabel("Element").selectOption("node:repo");
  await page.getByLabel("Plain-English label").fill("The repository map");
  await page.getByLabel("Element").selectOption("edge:repo-edge");
  await page.getByRole("button", { name: "Hide selected element" }).click();
  await page.getByLabel("Direction").selectOption("LR");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Edited title");
  await expect(page.getByLabel("Direction")).toHaveValue("LR");
  await page.getByRole("button", { name: "Copy README Markdown" }).click();
});
