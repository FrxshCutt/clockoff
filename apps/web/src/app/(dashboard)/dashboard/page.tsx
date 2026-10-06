import { redirect } from "next/navigation";
import { ROUTES } from "@/config/navigation";

/** `/dashboard` is a common guess (and an onboarding link target); the dashboard home is `/overview`. */
export default function DashboardIndexPage(): never {
  redirect(ROUTES.overview);
}
