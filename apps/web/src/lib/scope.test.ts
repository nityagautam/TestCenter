import { describe, expect, it } from "vitest";
import {
  orgScopeHref,
  projectKeyFromPath,
  projectScopeHref,
  sharedSectionFromPath,
} from "./scope.js";

const ORG = "acme";

describe("projectKeyFromPath", () => {
  it("reads the project from a project-scoped path", () => {
    expect(projectKeyFromPath("/o/acme/p/checkout-web/runs", ORG)).toBe("checkout-web");
    expect(projectKeyFromPath("/o/acme/p/checkout-web", ORG)).toBe("checkout-web");
  });

  it("returns null for org-scoped paths", () => {
    expect(projectKeyFromPath("/o/acme", ORG)).toBeNull();
    expect(projectKeyFromPath("/o/acme/runs", ORG)).toBeNull();
    expect(projectKeyFromPath("/o/acme/settings/members", ORG)).toBeNull();
  });

  it("does not match a different organisation", () => {
    // Otherwise the shell would show another org's project as selected.
    expect(projectKeyFromPath("/o/other/p/checkout-web/runs", ORG)).toBeNull();
  });

  it("treats a trailing slash as no project", () => {
    expect(projectKeyFromPath("/o/acme/p/", ORG)).toBeNull();
  });
});

describe("sharedSectionFromPath", () => {
  it("recognises sections that exist at both scopes", () => {
    expect(sharedSectionFromPath("/o/acme/runs", ORG)).toBe("runs");
    expect(sharedSectionFromPath("/o/acme/tests", ORG)).toBe("tests");
    expect(sharedSectionFromPath("/o/acme/flaky", ORG)).toBe("flaky");
    expect(sharedSectionFromPath("/o/acme/p/checkout-web/runs", ORG)).toBe("runs");
    expect(sharedSectionFromPath("/o/acme/p/checkout-web/tests", ORG)).toBe("tests");
    expect(sharedSectionFromPath("/o/acme/p/checkout-web/flaky", ORG)).toBe("flaky");
  });

  it("ignores anything below the section", () => {
    // A run detail page is still the runs section for scope purposes.
    expect(sharedSectionFromPath("/o/acme/runs/019fae-1234", ORG)).toBe("runs");
    expect(sharedSectionFromPath("/o/acme/tests/430130", ORG)).toBe("tests");
  });

  it("returns null for sections that exist at only one scope", () => {
    // Carrying these across would land on a page that does not exist, or one whose
    // meaning changes with the scope.
    expect(sharedSectionFromPath("/o/acme/p/checkout-web/upload", ORG)).toBeNull();
    expect(sharedSectionFromPath("/o/acme/p/checkout-web/settings", ORG)).toBeNull();
    expect(sharedSectionFromPath("/o/acme/settings/members", ORG)).toBeNull();
    expect(sharedSectionFromPath("/o/acme", ORG)).toBeNull();
    expect(sharedSectionFromPath("/o/acme/p/checkout-web", ORG)).toBeNull();
  });
});

describe("switching scope keeps you where you are", () => {
  it("moves between projects within the same section", () => {
    // The bug this replaces: selecting a project from the test list dropped the scope
    // entirely, so the user landed back on organisation-wide results.
    expect(projectScopeHref("/o/acme/p/checkout-web/tests", ORG, "payments")).toBe(
      "/o/acme/p/payments/tests",
    );
    expect(projectScopeHref("/o/acme/p/checkout-web/runs", ORG, "payments")).toBe(
      "/o/acme/p/payments/runs",
    );
  });

  it("narrows an organisation-wide list to a project, staying on the list", () => {
    expect(projectScopeHref("/o/acme/tests", ORG, "payments")).toBe("/o/acme/p/payments/tests");
    expect(projectScopeHref("/o/acme/runs", ORG, "payments")).toBe("/o/acme/p/payments/runs");
    expect(projectScopeHref("/o/acme/flaky", ORG, "payments")).toBe("/o/acme/p/payments/flaky");
  });

  it("widens back to the organisation, staying on the list", () => {
    expect(orgScopeHref("/o/acme/p/checkout-web/tests", ORG)).toBe("/o/acme/tests");
    expect(orgScopeHref("/o/acme/p/checkout-web/runs", ORG)).toBe("/o/acme/runs");
    expect(orgScopeHref("/o/acme/p/checkout-web/flaky", ORG)).toBe("/o/acme/flaky");
  });

  it("falls back to the overview when the section cannot cross scopes", () => {
    // Nowhere sensible to land, so go somewhere that certainly exists.
    expect(projectScopeHref("/o/acme/p/checkout-web/settings", ORG, "payments")).toBe(
      "/o/acme/p/payments",
    );
    // `flaky` exists at both scopes now, so it is carried rather than dropped; `settings`
    // still falls back because it means something different at each level.
    expect(orgScopeHref("/o/acme/p/checkout-web/settings", ORG)).toBe("/o/acme");
  });
});
