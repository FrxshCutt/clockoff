import type { Metadata } from "next";
import { RegisterForm } from "@/components/auth/register-form";
import { safeRedirectPath } from "@/config/navigation";
import { readParam, type PageSearchParams } from "../search-params";

export const metadata: Metadata = { title: "Create your account" };

export default async function RegisterPage({ searchParams }: { searchParams: PageSearchParams }) {
  const next = safeRedirectPath(await readParam(searchParams, "next"));
  return <RegisterForm next={next} />;
}
