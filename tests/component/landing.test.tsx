import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

describe("landing page", () => {
  afterEach(cleanup);

  beforeEach(() => {
    push.mockReset();
  });

  it("explains invalid repository URLs without submitting", () => {
    render(<Home />);
    fireEvent.change(screen.getByLabelText("Public GitHub repository URL"), { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByRole("button", { name: /tell the story/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid GitHub URL");
    expect(push).not.toHaveBeenCalled();
  });

  it("rejects GitHub paths that are not repository or tree URLs", () => {
    render(<Home />);
    fireEvent.change(screen.getByLabelText("Public GitHub repository URL"), { target: { value: "https://github.com/facebook/react/issues" } });
    fireEvent.click(screen.getByRole("button", { name: /tell the story/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("optional /tree/{branch}");
    expect(push).not.toHaveBeenCalled();
  });

  it("renders the official mark as decorative beside the accessible wordmark", () => {
    render(<Home />);
    const brand = screen.getByRole("link", { name: "RepoStory home" });
    const image = brand.querySelector("img");

    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveAttribute("src", expect.stringContaining("repostory-icon-mark.png"));
  });

  it("displays the structured error message returned by /api/analyze", async () => {
    const mockError = "In production, REPO_STORY_JOB_STORE must be explicitly set ('supabase', 'file', or 'memory').";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "CONFIG_ERROR", message: mockError } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<Home />);
    fireEvent.change(screen.getByLabelText("Public GitHub repository URL"), {
      target: { value: "https://github.com/facebook/react" },
    });
    fireEvent.click(screen.getByRole("button", { name: /tell the story/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(mockError);
    fetchSpy.mockRestore();
  });

  it("displays the string error returned by CORS middleware", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Cross-origin request forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<Home />);
    fireEvent.change(screen.getByLabelText("Public GitHub repository URL"), {
      target: { value: "https://github.com/facebook/react" },
    });
    fireEvent.click(screen.getByRole("button", { name: /tell the story/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Cross-origin request forbidden");
    fetchSpy.mockRestore();
  });
});
