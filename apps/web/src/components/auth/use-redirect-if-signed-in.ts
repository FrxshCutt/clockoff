"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { getPostAuthRedirect } from "@/config/navigation";
import { useCurrentUser } from "@/hooks/use-current-user";
import { isUnauthenticatedError } from "@/lib/api-client";

/** On sign-in/sign-up pages: a manager who is already signed in goes straight to where they belong. */
export function useRedirectIfSignedIn(next: string | null) {
  const router = useRouter();
  const { data, error } = useCurrentUser();
  // Cached data from a session that has since ended must not count as signed in.
  const me = isUnauthenticatedError(error) ? undefined : data;
  useEffect(() => {
    if (me)
      router.replace(getPostAuthRedirect({ organisationCount: me.organisations.length, next }));
  }, [me, next, router]);
  return Boolean(me);
}
