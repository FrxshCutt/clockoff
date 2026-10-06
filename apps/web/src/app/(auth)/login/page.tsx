import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";
import { safeRedirectPath } from "@/config/navigation";
import { readParam, type PageSearchParams } from "../search-params";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: PageSearchParams }) {
  const next = safeRedirectPath(await readParam(searchParams, "next"));
  return <LoginForm next={next} />;
}
