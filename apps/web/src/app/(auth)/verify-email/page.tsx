import type { Metadata } from "next";
import { VerifyEmailPanel } from "@/components/auth/verify-email-panel";
import { readParam, type PageSearchParams } from "../search-params";

export const metadata: Metadata = { title: "Verify your email", referrer: "no-referrer" };

export default async function VerifyEmailPage({ searchParams }: { searchParams: PageSearchParams }) {
  const token = await readParam(searchParams, "token");
  return <VerifyEmailPanel token={token} />;
}
