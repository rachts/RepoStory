import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

describe("landing page", () => {
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
});
