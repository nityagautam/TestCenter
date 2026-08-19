import type { ReactNode } from "react";
import { RememberedOrgAppShell } from "@/features/org-app-shell";

/** Creating another organisation keeps the viewer inside the normal application chrome. */
export default function OrganizationsLayout({ children }: { children: ReactNode }) {
  return <RememberedOrgAppShell>{children}</RememberedOrgAppShell>;
}
