import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { upsertUserOnSignIn } from "@testcenter/db";
import { getServices } from "@/lib/services";

/**
 * Authentication.
 *
 * Two providers with very different purposes:
 *
 *   Google OIDC is the real one. A JWT session strategy is used rather than an
 *   Auth.js database adapter because this product already owns a `users` table with
 *   org membership; adding the adapter's parallel account/session tables would give
 *   us two sources of truth for identity.
 *
 *   A dev-only email provider exists so multi-tenant isolation can actually be
 *   tested — verifying that org A cannot see org B needs several users, and creating
 *   several real Google accounts to check a WHERE clause is absurd. It is gated on
 *   NODE_ENV so it cannot become a production authentication bypass.
 */
function allowedDomains(): string[] {
  return (process.env.AUTH_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

function adminEmails(): string[] {
  return (process.env.TESTCENTER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

const googleConfigured = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

/**
 * The dev provider is enabled only outside production *and* only when explicitly
 * switched on. Two conditions rather than one, because a single accidental
 * NODE_ENV would otherwise be the whole defence.
 */
const devLoginEnabled =
  process.env.NODE_ENV !== "production" && process.env.AUTH_DEV_LOGIN !== "false";

export const authStatus = {
  googleConfigured,
  devLoginEnabled,
  anyProvider: googleConfigured || devLoginEnabled,
};

function isDomainAllowed(email: string): boolean {
  const domains = allowedDomains();
  if (domains.length === 0) return true;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return domains.includes(domain);
}

const providers: NextAuthConfig["providers"] = [];

if (googleConfigured) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: { params: { prompt: "select_account" } },
    }),
  );
}

if (devLoginEnabled) {
  providers.push(
    Credentials({
      id: "dev",
      name: "Development sign-in",
      credentials: {
        email: { label: "Email", type: "email" },
        name: { label: "Display name", type: "text" },
      },
      authorize(credentials) {
        // No password on purpose: this is a local testing shortcut, not a weak
        // password check that might be mistaken for a real one.
        const email = String(credentials?.email ?? "")
          .trim()
          .toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;

        const name = String(credentials?.name ?? "").trim() || email.split("@")[0] || email;
        return { id: email, email, name };
      },
    }),
  );
}

const config: NextAuthConfig = {
  providers,
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  pages: { signIn: "/signin" },
  callbacks: {
    async signIn({ user, account }) {
      const email = user.email?.toLowerCase();
      if (!email) return false;

      // The domain allow-list applies to real sign-ins. The dev provider bypasses it
      // so isolation tests can create users on arbitrary domains.
      if (account?.provider !== "dev" && !isDomainAllowed(email)) return false;

      const { db } = getServices();
      await upsertUserOnSignIn(db, {
        email,
        name: user.name ?? null,
        avatarUrl: user.image ?? null,
        googleSub: account?.provider === "google" ? (account.providerAccountId ?? null) : null,
        adminEmails: adminEmails(),
      });

      return true;
    },

    async jwt({ token, user }) {
      // Email is the join key to our own users table; keep it on the token so the
      // session callback does not need a database round trip.
      if (user?.email) token.email = user.email.toLowerCase();
      return token;
    },

    async session({ session, token }) {
      if (session.user && token.email) session.user.email = token.email;
      return session;
    },
  },
  trustHost: true,
};

export const { handlers, auth, signIn, signOut } = NextAuth(config);
