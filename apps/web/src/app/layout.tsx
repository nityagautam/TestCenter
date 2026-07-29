import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Test Center",
  description: "Test intelligence for every framework — ingest, triage, and trend test results.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
