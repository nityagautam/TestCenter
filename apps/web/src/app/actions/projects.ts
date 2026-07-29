"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { schema } from "@testcenter/db";
import { getServices } from "@/lib/services";
import { can, requirePageContext } from "@/lib/viewer";

/**
 * Project lifecycle: archive, restore, delete.
 *
 * Kept in a server-action module rather than inline in the settings page because the
 * projects list needs restore too — an archived project is easier to find in a list of
 * archived projects than by typing its settings URL from memory.
 *
 * Every action re-resolves the viewer and re-checks the capability. The forms already only
 * render for permitted roles, but a server action is a public endpoint: anything that
 * trusts the button's absence as the check is not actually checked.
 */

/** Both archive and restore write the same column, so they share the guard and the plumbing. */
async function setArchived(
  orgSlug: string,
  projectKey: string,
  archivedAt: Date | null,
): Promise<void> {
  const context = await requirePageContext(orgSlug);
  if (!can(context, "project:archive")) {
    redirect(
      `/o/${orgSlug}/p/${projectKey}/settings?error=${encodeURIComponent(
        `Archiving requires the admin role — yours is ${context.org.role}.`,
      )}`,
    );
  }

  const { db } = getServices();
  const updated = await db
    .update(schema.projects)
    .set({ archivedAt })
    .where(and(eq(schema.projects.orgId, context.org.id), eq(schema.projects.key, projectKey)))
    .returning({ id: schema.projects.id });

  if (updated.length === 0) {
    redirect(
      `/o/${orgSlug}/projects?error=${encodeURIComponent("That project no longer exists.")}`,
    );
  }

  revalidatePath(`/o/${orgSlug}/projects`);
  revalidatePath(`/o/${orgSlug}/p/${projectKey}/settings`);
}

export async function archiveProject(orgSlug: string, projectKey: string): Promise<void> {
  await setArchived(orgSlug, projectKey, new Date());
  // Back to the list, because the project just stopped being somewhere to work.
  redirect(
    `/o/${orgSlug}/projects?ok=${encodeURIComponent(
      `Archived ${projectKey}. Its results are kept, and it can be restored from Archived.`,
    )}`,
  );
}

export async function restoreProject(orgSlug: string, projectKey: string): Promise<void> {
  await setArchived(orgSlug, projectKey, null);
  // Into the project, because that is presumably why it was restored.
  redirect(`/o/${orgSlug}/p/${projectKey}?ok=${encodeURIComponent(`Restored ${projectKey}.`)}`);
}

/**
 * Permanently deletes a project and everything under it.
 *
 * Two guards, because this is the one project action that destroys evidence and cannot be
 * undone. The capability is `project:delete`, which is owner-only — archiving already
 * serves "we have stopped using this" and is reversible. And the confirmation is the
 * project key typed by hand: a button that only needs a click is a button that gets clicked
 * by accident, and there is nothing to click afterwards to put it back.
 */
export async function deleteProject(
  orgSlug: string,
  projectKey: string,
  formData: FormData,
): Promise<void> {
  const context = await requirePageContext(orgSlug);
  const settings = `/o/${orgSlug}/p/${projectKey}/settings`;

  if (!can(context, "project:delete")) {
    redirect(
      `${settings}?error=${encodeURIComponent(
        `Deleting a project requires the owner role — yours is ${context.org.role}.`,
      )}`,
    );
  }

  const typed = String(formData.get("confirm") ?? "").trim();
  if (typed !== projectKey) {
    redirect(
      `${settings}?error=${encodeURIComponent(
        `Type ${projectKey} exactly to confirm deletion. Nothing was deleted.`,
      )}`,
    );
  }

  const { db } = getServices();
  // Runs, results, test cases and tokens cascade from the project's foreign keys — the
  // payoff for declaring them rather than relying on application-level cleanup.
  const deleted = await db
    .delete(schema.projects)
    .where(and(eq(schema.projects.orgId, context.org.id), eq(schema.projects.key, projectKey)))
    .returning({ id: schema.projects.id });

  if (deleted.length === 0) {
    redirect(
      `/o/${orgSlug}/projects?error=${encodeURIComponent("That project no longer exists.")}`,
    );
  }

  revalidatePath(`/o/${orgSlug}/projects`);
  redirect(
    `/o/${orgSlug}/projects?ok=${encodeURIComponent(
      `Deleted ${projectKey} and all of its runs and results.`,
    )}`,
  );
}
