/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiError } from "@syl/shared/types";

import { apiFailure, malformedResponse, networkFailure, asAdminApiError } from "../../src/api/errors";
import { Badge } from "../../src/ui/Badge";
import { Empty, ErrorNotice, Loading } from "../../src/ui/feedback";

afterEach(cleanup);

const rateLimited: ApiError = {
  code: "RATE_LIMITED",
  message: "Too many writes. Back off.",
  retryable: true,
  retryAfterMs: 2_000,
};

describe("ErrorNotice", () => {
  it("should name the code the server used, because that is the contract", () => {
    render(h(ErrorNotice, { error: apiFailure(429, rateLimited) }));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("RATE_LIMITED");
    expect(alert.textContent).toContain("Too many writes");
    expect(alert.textContent).toContain("HTTP 429");
    expect(alert.textContent).toContain("retryable");
    expect(alert.textContent).toContain("retry after 2000ms");
  });

  it("should say a network failure is a network failure, not a server error", () => {
    // Telling the operator "request failed" for both wastes the debugging
    // session this surface exists to shorten.
    render(h(ErrorNotice, { error: networkFailure(new TypeError("Failed to fetch")) }));
    expect(screen.getByRole("alert").textContent).toContain("No answer from Syl");
  });

  it("should call an off-contract body what it is", () => {
    render(h(ErrorNotice, { error: malformedResponse(502, "the body was not JSON") }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("off-contract");
    expect(alert.textContent).toContain("not retryable");
  });

  it("should have something to say about a throw it does not recognise", () => {
    render(h(ErrorNotice, { error: asAdminApiError(new RangeError("off the end")) }));
    expect(screen.getByRole("alert").textContent).toContain("Something threw");
  });

  it("should offer a retry only when one is wired", () => {
    const onRetry = vi.fn();
    const { unmount } = render(h(ErrorNotice, { error: apiFailure(429, rateLimited), onRetry }));
    screen.getByRole("button", { name: /try again/i }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);

    unmount();
    render(h(ErrorNotice, { error: apiFailure(429, rateLimited) }));
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });
});

describe("Loading and Empty", () => {
  it("should announce loading as a status, not silently", () => {
    render(h(Loading, null));
    expect(screen.getByRole("status").textContent).toContain("Loading");
  });

  it("should take a label for what is loading", () => {
    render(h(Loading, { label: "Loading runs…" }));
    expect(screen.getByRole("status").textContent).toBe("Loading runs…");
  });

  it("should render an empty message", () => {
    render(h(Empty, { children: "This job has never run." }));
    expect(screen.getByText("This job has never run.")).toBeTruthy();
  });
});

describe("Badge", () => {
  it("should colour from a token reference, never a literal", () => {
    // The same rule the overview's status dots follow: a palette swap must not
    // become a component audit.
    render(h(Badge, { tone: "fail", title: "failed", children: "failed" }));
    const badge = screen.getByTitle("failed");
    expect(badge.style.color).toMatch(/^var\(--syl-/);
    expect(badge.style.borderColor).toMatch(/^var\(--syl-/);
  });

  it("should map every tone to a declared token", () => {
    for (const tone of ["ok", "warn", "fail", "pending", "muted", "accent"] as const) {
      const { unmount } = render(h(Badge, { tone, title: tone, children: tone }));
      expect(screen.getByTitle(tone).style.color).toMatch(/^var\(--syl-/);
      unmount();
    }
  });
});
