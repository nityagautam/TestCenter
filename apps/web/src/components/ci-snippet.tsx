"use client";

import { useEffect, useState } from "react";

/**
 * The CI recipe, with a real token inlined.
 *
 * Shown immediately after a project is created, because that is the one moment
 * someone is actually ready to wire up their pipeline. If they have to go find a
 * settings page and mint a token themselves, most never do — and a test dashboard
 * with no CI integration is a dashboard nobody looks at.
 *
 * The token is displayed once and never stored in plaintext, so the copy button
 * matters more than it looks.
 */
export function CiSnippet({
  projectKey,
  token,
  baseUrl,
}: {
  projectKey: string;
  token: string | null;
  baseUrl?: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [browserOrigin, setBrowserOrigin] = useState("");

  /*
   * The server cannot know window.location.origin, so both the server and the client's
   * first render use a relative URL. Reading window during render made those two trees
   * disagree and caused React to discard this section during hydration. Once hydration
   * has completed, replacing the relative URL with the real origin is a normal update.
   */
  useEffect(() => {
    if (baseUrl === undefined) setBrowserOrigin(window.location.origin);
  }, [baseUrl]);

  const origin = (baseUrl ?? browserOrigin).replace(/\/$/, "");
  const shown = token ?? "$TESTCENTER_TOKEN";

  const curl = `curl -X POST "${origin}/api/v1/ingest?project=${projectKey}&branch=$BRANCH&tag=suite:regression" \\
  -H "Authorization: Bearer ${shown}" \\
  -F "report=@reports/junit.xml"`;

  const action = `- name: Publish test results
  if: always()
  run: |
    curl -X POST "${origin}/api/v1/ingest?project=${projectKey}&branch=\${{ github.ref_name }}&commit=\${{ github.sha }}&buildId=\${{ github.run_id }}" \\
      -H "Authorization: Bearer \${{ secrets.TESTCENTER_TOKEN }}" \\
      -F "report=@reports/junit.xml"`;

  async function copy(label: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="space-y-4">
      {token ? (
        <div className="rounded-md border border-[var(--color-status-flaky)]/40 bg-[var(--color-status-flaky)]/5 px-3 py-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium">API token — shown once, copy it now</span>
            <button
              type="button"
              onClick={() => void copy("token", token)}
              className="rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] hover:border-[var(--color-ink-muted)]"
            >
              {copied === "token" ? "copied" : "copy"}
            </button>
          </div>
          <code className="block overflow-x-auto font-mono text-[11px] break-all">{token}</code>
          <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-ink-muted)]">
            Only a hash is stored, so this cannot be shown again. Put it in your CI secret manager
            as <span className="font-mono">TESTCENTER_TOKEN</span>.
          </p>
        </div>
      ) : null}

      <Snippet
        title="Any CI — one command"
        body={curl}
        copied={copied === "curl"}
        onCopy={() => void copy("curl", curl)}
      />
      <Snippet
        title="GitHub Actions"
        body={action}
        copied={copied === "action"}
        onCopy={() => void copy("action", action)}
      />

      <p className="text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
        <span className="font-medium">if: always()</span> matters — without it the step is skipped
        exactly when tests fail, which is when you most want the results.
      </p>
    </div>
  );
}

function Snippet({
  title,
  body,
  copied,
  onCopy,
}: {
  title: string;
  body: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium">{title}</span>
        <button
          type="button"
          onClick={onCopy}
          className="rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] hover:border-[var(--color-ink-muted)]"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px] leading-relaxed">
        {body}
      </pre>
    </div>
  );
}
