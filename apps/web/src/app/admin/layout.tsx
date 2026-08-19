import type { ReactNode } from "react";
import { RememberedOrgAppShell } from "@/features/org-app-shell";

/** Platform administration uses the same authenticated chrome as every tenant page. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <RememberedOrgAppShell>{children}</RememberedOrgAppShell>;
}
