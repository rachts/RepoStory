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
});
