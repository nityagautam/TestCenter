import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CiSnippet } from "./ci-snippet";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CiSnippet", () => {
  it("renders identical markup on the server and the client's first pass", () => {
    const serverMarkup = renderToString(<CiSnippet projectKey="checkout" token={null} />);

    vi.stubGlobal("window", { location: { origin: "https://testcenter.example" } });
    const clientMarkup = renderToString(<CiSnippet projectKey="checkout" token={null} />);

    expect(clientMarkup).toBe(serverMarkup);
  });

  it("uses an explicit base URL consistently", () => {
    const markup = renderToString(
      <CiSnippet projectKey="checkout" token={null} baseUrl="https://testcenter.example/" />,
    );

    expect(markup).toContain(
      "https://testcenter.example/api/v1/ingest?project=checkout&amp;branch=$BRANCH",
    );
  });
});
