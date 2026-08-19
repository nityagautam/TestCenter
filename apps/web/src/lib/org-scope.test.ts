import { describe, expect, it } from "vitest";
import { preferredLandingOrg, readOrgScope } from "./org-scope.js";

const orgs = [
  { slug: "admin-visible", viaPlatformAdmin: true, isPersonal: false },
  { slug: "personal", viaPlatformAdmin: false, isPersonal: true },
  { slug: "shared", viaPlatformAdmin: false, isPersonal: false },
];

describe("remembered organisation scope", () => {
  it("reads a selected organisation", () => {
    expect(readOrgScope("acme")).toBe("acme");
  });

  it("treats absent and blank values as no selection", () => {
    expect(readOrgScope(undefined)).toBeNull();
    expect(readOrgScope("")).toBeNull();
    expect(readOrgScope("   ")).toBeNull();
  });

  it("trims cookie whitespace before access validation", () => {
    expect(readOrgScope("  acme  ")).toBe("acme");
  });

  it("returns to the remembered organisation when it remains accessible", () => {
    expect(preferredLandingOrg(orgs, "admin-visible")?.slug).toBe("admin-visible");
  });

  it("ignores stale memory and applies the normal membership preference", () => {
    expect(preferredLandingOrg(orgs, "revoked")?.slug).toBe("shared");
  });
});
