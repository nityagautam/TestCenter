import { describe, expect, it } from "vitest";
import { encodeProjectScope, readProjectScope } from "./project-scope.js";

describe("remembered project scope", () => {
  it("round-trips a selection", () => {
    expect(readProjectScope(encodeProjectScope("acme", "checkout-web"), "acme")).toBe(
      "checkout-web",
    );
  });

  it("does not leak a selection across organisations", () => {
    /*
     * The reason the value is qualified at all. Two organisations can each have a project
     * called `web`; a bare key would mean selecting one and then switching organisation
     * silently selected the other's — a header claiming a project the viewer may not even
     * have access to.
     */
    expect(readProjectScope(encodeProjectScope("acme", "web"), "other-org")).toBeNull();
  });

  it("treats absent or malformed values as no selection", () => {
    expect(readProjectScope(undefined, "acme")).toBeNull();
    expect(readProjectScope("", "acme")).toBeNull();
    expect(readProjectScope("no-separator", "acme")).toBeNull();
    expect(readProjectScope(":leading-colon", "acme")).toBeNull();
    expect(readProjectScope("acme:", "acme")).toBeNull();
  });

  it("keeps a project key that contains a colon intact", () => {
    // Only the first colon separates; the rest belongs to the key.
    expect(readProjectScope("acme:odd:key", "acme")).toBe("odd:key");
  });
});
