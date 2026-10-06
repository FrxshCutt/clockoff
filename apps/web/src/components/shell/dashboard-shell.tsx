"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { ErrorState } from "@/components/error-state";
import { FullPageShellSkeleton } from "@/components/loading-skeletons";
import { InlineAlert } from "@/components/inline-alert";
import { RealtimeProvider } from "@/components/realtime";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ROUTES, loginRedirectUrl } from "@/config/navigation";
import { useResendVerification, useSwitchOrganisation } from "@/hooks/use-auth";
import { getCurrentMembership, useCurrentUser } from "@/hooks/use-current-user";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { SidebarNav } from "./app-sidebar";
import { resolveGateState, type GateState } from "./gate";
import { TopBar } from "./top-bar";

export { resolveGateState, type GateState } from "./gate";

/**
 * Client-side auth gate + app frame for every dashboard route.
 * - Signed out → `/login?next=<current path>`; no organisation → `/create-organisation`.
 * - While the session loads (or a redirect is pending) the full shell skeleton renders, so protected content
 *   never flashes.
 */
export function DashboardShell({
  children,
  defaultSidebarOpen = true,
}: {
  children: ReactNode;
  defaultSidebarOpen?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { data: me, error, isPending, refetch, isRefetching } = useCurrentUser();
  const { mutate: selectOrganisation, isError: autoSelectFailed } = useSwitchOrganisation({
    navigateTo: null,
  });
  const autoSelected = useRef(false);

  // A failed background refetch keeps the last good `me`; only an ended session (401) overrides it.
  const state = resolveGateState({
    isPending,
    error,
    organisationCount: me ? me.organisations.length : null,
  });

  // Redirect once per episode: clearing the cache below can briefly flip the state back to "loading".
  const redirectedFor = useRef<GateState | null>(null);
  useEffect(() => {
    if (state === "ready") {
      redirectedFor.current = null;
      return;
    }
    if (
      (state !== "unauthenticated" && state !== "no-organisation") ||
      redirectedFor.current === state
    )
      return;
    redirectedFor.current = state;
    if (state === "unauthenticated") {
      // Drop every cached response (the previous session's organisation data, and the stale `me` that would
      // otherwise bounce /login straight back here).
      queryClient.removeQueries();
      router.replace(loginRedirectUrl(`${pathname ?? ROUTES.overview}${window.location.search}`));
    } else {
      router.replace(ROUTES.createOrganisation);
    }
  }, [state, router, pathname, queryClient]);

  // Memberships exist but none is selected yet (e.g. first sign-in after accepting an invite): pick the first.
  const firstOrganisationId = me?.organisations[0]?.id;
  const needsSelection =
    state === "ready" && me?.currentOrganisationId === null && firstOrganisationId !== undefined;
  useEffect(() => {
    if (needsSelection && firstOrganisationId && !autoSelected.current) {
      autoSelected.current = true;
      selectOrganisation(firstOrganisationId);
    }
  }, [needsSelection, firstOrganisationId, selectOrganisation]);

  if (state === "error") {
    return (
      <main
        id="main-content"
        tabIndex={-1}
        className="flex min-h-svh items-center justify-center p-4 outline-none"
      >
        <ErrorState
          className="w-full max-w-lg"
          title="We couldn't load your workspace"
          error={error}
          onRetry={() => void refetch()}
          isRetrying={isRefetching}
        />
      </main>
    );
  }

  // If auto-selection fails, render anyway: the shell falls back to the first membership and pages show
  // their own errors, rather than an endless skeleton.
  if (state !== "ready" || !me || (needsSelection && !autoSelectFailed)) {
    return <FullPageShellSkeleton />;
  }

  const membership = getCurrentMembership(me);

  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <SidebarNav organisationName={membership?.name ?? null} />
      <div className="bg-background relative flex min-h-svh w-full min-w-0 flex-1 flex-col">
        <TopBar me={me} />
        <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            {me.user.emailVerified ? null : <VerifyEmailBanner email={me.user.email} />}
            <RealtimeProvider>{children}</RealtimeProvider>
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}

function VerifyEmailBanner({ email }: { email: string }) {
  const resend = useResendVerification();
  const toastError = useApiErrorToast();
  return (
    <InlineAlert
      variant="warning"
      className="mb-6"
      title="Verify your email address"
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={resend.isPending || resend.isSuccess}
          onClick={() =>
            resend.mutate(undefined, {
              onSuccess: () => toast.success(`Verification email sent to ${email}`),
              onError: (err) => toastError(err, { title: "Couldn't send the email" }),
            })
          }
        >
          {resend.isSuccess ? "Email sent" : resend.isPending ? "Sending…" : "Resend email"}
        </Button>
      }
    >
      We sent a verification link to {email}. Didn&apos;t get it? Check spam or send a new one.
    </InlineAlert>
  );
}
