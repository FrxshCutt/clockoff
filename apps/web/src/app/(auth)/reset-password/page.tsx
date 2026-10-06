import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { readParam, type PageSearchParams } from "../search-params";

export const metadata: Metadata = { title: "Choose a new password", referrer: "no-referrer" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const token = await readParam(searchParams, "token");
  return <ResetPasswordForm token={token} />;
}
