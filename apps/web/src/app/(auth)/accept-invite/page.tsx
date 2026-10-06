import type { Metadata } from "next";
import { AcceptInvitePanel } from "@/components/auth/accept-invite-panel";
import { readParam, type PageSearchParams } from "../search-params";

export const metadata: Metadata = { title: "Accept invitation", referrer: "no-referrer" };

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const token = await readParam(searchParams, "token");
  return <AcceptInvitePanel token={token} />;
}
