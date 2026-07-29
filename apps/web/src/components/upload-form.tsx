"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardHeader } from "@/components/ui";

/**
 * Drag-and-drop report upload.
 *
 * Uses the single-shot ingest endpoint: one request per file, so a partial failure
 * loses only that file rather than the whole batch, and each file reports its own
 * status. Uploads go through the browser session, so no token is needed here.
 */
interface ProjectOption {
  key: string;
  name: string;
}

type FileState =
  | { status: "queued"; file: File }
  | { status: "uploading"; file: File }
  | { status: "done"; file: File; runId: string; tests: number | null }
  | { status: "error"; file: File; message: string };

export function UploadForm({
  projects,
  orgSlug,
  defaultBranch = "",
}: {
  projects: ProjectOption[];
  orgSlug: string;
  defaultBranch?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [project, setProject] = useState(projects[0]?.key ?? "");
  const [branch, setBranch] = useState(defaultBranch);
  const [environment, setEnvironment] = useState("");
  const [tagText, setTagText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<FileState[]>([]);
  const [busy, setBusy] = useState(false);

  function addFiles(incoming: FileList | null): void {
    if (!incoming) return;
    const accepted = Array.from(incoming).filter(
      (file) => file.name.toLowerCase().endsWith(".xml") || file.type.includes("xml"),
    );
    const rejected = Array.from(incoming).length - accepted.length;

    setFiles((current) => [
      ...current,
      ...accepted.map((file) => ({ status: "queued" as const, file })),
      // Rejections are shown rather than silently dropped, so a mis-drag is obvious.
      ...(rejected > 0
        ? [
            {
              status: "error" as const,
              file: new File([], `${rejected} non-XML file(s)`),
              message: "only JUnit/xUnit XML is supported in Phase 1",
            },
          ]
        : []),
    ]);
  }

  function buildQuery(): string {
    const params = new URLSearchParams({ project });
    if (branch.trim()) params.set("branch", branch.trim());
    if (environment.trim()) params.set("env", environment.trim());
    for (const entry of tagText.split(/[\s,]+/).filter(Boolean)) {
      params.append("tag", entry);
    }
    return params.toString();
  }

  async function uploadAll(): Promise<void> {
    const pending = files
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.status === "queued");
    if (pending.length === 0 || !project) return;

    setBusy(true);
    const query = buildQuery();
    let lastRunId: string | null = null;

    for (const { entry, index } of pending) {
      setFiles((current) =>
        current.map((item, i) => (i === index ? { status: "uploading", file: entry.file } : item)),
      );

      try {
        const body = new FormData();
        body.append("report", entry.file);
        const response = await fetch(`/api/v1/ingest?${query}`, { method: "POST", body });
        const payload = (await response.json().catch(() => null)) as {
          runId?: string;
          error?: { message?: string };
        } | null;

        if (!response.ok || !payload?.runId) {
          const message = payload?.error?.message ?? `upload failed (${response.status})`;
          setFiles((current) =>
            current.map((item, i) =>
              i === index ? { status: "error", file: entry.file, message } : item,
            ),
          );
          continue;
        }

        lastRunId = payload.runId;
        setFiles((current) =>
          current.map((item, i) =>
            i === index
              ? { status: "done", file: entry.file, runId: payload.runId as string, tests: null }
              : item,
          ),
        );
      } catch (error) {
        setFiles((current) =>
          current.map((item, i) =>
            i === index
              ? {
                  status: "error",
                  file: entry.file,
                  message: error instanceof Error ? error.message : "network error",
                }
              : item,
          ),
        );
      }
    }

    setBusy(false);
    // Land on the run so parse progress is visible immediately; a single upload is
    // the common case and an extra click to find it would be friction.
    if (lastRunId) router.push(`/o/${orgSlug}/runs/${lastRunId}`);
  }

  const queued = files.filter((entry) => entry.status === "queued").length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Report details" />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <Field label="Project">
            <select
              value={project}
              onChange={(event) => setProject(event.target.value)}
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-ink-muted)]"
            >
              {projects.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.name} ({option.key})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Branch">
            <TextInput value={branch} onChange={setBranch} placeholder="main" />
          </Field>
          <Field label="Environment">
            <TextInput value={environment} onChange={setEnvironment} placeholder="staging" />
          </Field>
          <Field label="Tags" hint="space separated key:value">
            <TextInput
              value={tagText}
              onChange={setTagText}
              placeholder="suite:regression browser:chromium"
            />
          </Field>
        </div>
      </Card>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(event.dataTransfer.files);
        }}
        className={`rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging
            ? "border-[var(--color-status-passed)] bg-[var(--color-status-passed)]/5"
            : "border-[var(--color-border-subtle)]"
        }`}
      >
        <p className="text-sm font-medium">Drop JUnit XML files here</p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          or{" "}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="underline hover:text-[var(--color-ink)]"
          >
            choose files
          </button>
          . Multiple files are treated as separate runs.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".xml,application/xml,text/xml"
          onChange={(event) => addFiles(event.target.files)}
          className="hidden"
        />
      </div>

      {files.length > 0 ? (
        <Card>
          <CardHeader
            title="Files"
            action={
              <Button onClick={uploadAll} disabled={busy || queued === 0} variant="primary">
                {busy ? "Uploading…" : `Upload ${queued || ""}`.trim()}
              </Button>
            }
          />
          <ul className="divide-y divide-[var(--color-border-subtle)]">
            {files.map((entry, index) => (
              <li
                key={`${entry.file.name}-${index}`}
                className="flex items-center gap-3 px-5 py-2.5"
              >
                <StatusIcon status={entry.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{entry.file.name}</div>
                  <div className="font-mono text-[11px] text-[var(--color-ink-muted)]">
                    {entry.status === "error"
                      ? entry.message
                      : entry.status === "done"
                        ? "queued for parsing"
                        : entry.file.size > 0
                          ? `${(entry.file.size / 1024).toFixed(1)} KB`
                          : ""}
                  </div>
                </div>
                {entry.status === "done" ? (
                  <a href={`/o/${orgSlug}/runs/${entry.runId}`} className="text-[11px] underline">
                    view run
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium">
        {label}
        {hint ? (
          <span className="ml-1.5 font-normal text-[var(--color-ink-muted)]">({hint})</span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 font-mono text-xs outline-none focus:border-[var(--color-ink-muted)]"
    />
  );
}

function StatusIcon({ status }: { status: FileState["status"] }) {
  const style =
    status === "done"
      ? "bg-[var(--color-status-passed)]"
      : status === "error"
        ? "bg-[var(--color-status-failed)]"
        : status === "uploading"
          ? "bg-sky-500 animate-pulse"
          : "bg-[var(--color-status-skipped)]";
  return <span className={`inline-block size-2 shrink-0 rounded-full ${style}`} aria-hidden />;
}
