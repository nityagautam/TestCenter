import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { eq } from "drizzle-orm";
import { schema } from "@testcenter/db";
import { getServices } from "@/lib/services";

/**
 * Authentication — Google Workspace OIDC.
 *
 * A JWT session strategy is used rather than an Auth.js database adapter: this
 * product already owns a `users` table with org membership, and adding the
 * adapter's parallel account/session tables would give us two sources of truth
 * for identity. Sign-in upserts into our own table instead.
 *
 * SAML/SCIM are deliberately out of scope until a team outside Google Workspace
 * needs access (docs/test-center-plan.md §1b).
 */
function allowedDomains(): string[] {
  return (process.env.AUTH_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

const googleConfigured = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

/** Exported so the UI can explain *why* there is no sign-in button yet. */
export const authProvidersConfigured = googleConfigured;

const config: NextAuthConfig = {
  providers: googleConfigured
    ? [
        Google({
          clientId: process.env.AUTH_GOOGLE_ID,
          clientSecret: process.env.AUTH_GOOGLE_SECRET,
          // Workspace accounts only; skips the consent screen for returning users.
          authorization: { params: { prompt: "select_account" } },
        }),
      ]
    : [],
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  pages: { signIn: "/signin" },
  callbacks: {
    async signIn({ user }) {
      const email = user.email?.toLowerCase();
      if (!email) return false;

      // Domain allow-list is enforced here rather than in Google console config so
      // it is visible in this repo and testable.
      const domains = allowedDomains();
      if (domains.length > 0) {
        const domain = email.split("@")[1] ?? "";
        if (!domains.includes(domain)) return false;
      }

      const { db } = getServices();
      const existing = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);

      if (existing[0]) {
        await db
          .update(schema.users)
          .set({
            name: user.name ?? null,
            avatarUrl: user.image ?? null,
            lastSeenAt: new Date(),
          })
          .where(eq(schema.users.id, existing[0].id));
      } else {
        await db.insert(schema.users).values({
          email,
          name: user.name ?? null,
          avatarUrl: user.image ?? null,
          lastSeenAt: new Date(),
        });
      }

      return true;
    },
    async session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
  trustHost: true,
};

export const { handlers, auth, signIn, signOut } = NextAuth(config);
