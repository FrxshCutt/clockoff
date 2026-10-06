import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { BrandLogo } from "@/components/brand";
import { ROUTES } from "@/config/navigation";
import { SITE } from "@/config/site";

/** Centered single-card layout for sign-in, sign-up and account recovery pages. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-svh flex-col overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60rem_30rem_at_50%_-10%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
      />
      <header className="flex justify-center px-4 pt-10 pb-6 sm:pt-16">
        <Link href={ROUTES.home} className="rounded-md" aria-label={`${SITE.name} home`}>
          <BrandLogo />
        </Link>
      </header>
      <main id="main-content" tabIndex={-1} className="flex flex-1 items-start justify-center px-4 pb-10 outline-none">
        <div className="w-full max-w-[26rem]">{children}</div>
      </main>
      <footer className="text-muted-foreground flex flex-col items-center gap-2 px-4 pb-8 text-center text-xs">
        <p className="inline-flex items-center gap-1.5 font-medium">
          <ShieldCheck className="text-primary size-4" aria-hidden="true" />
          {SITE.privacyLine}
        </p>
        <p>
          Need help?{" "}
          <a href={`mailto:${SITE.supportEmail}`} className="hover:text-foreground underline underline-offset-4">
            {SITE.supportEmail}
          </a>
        </p>
      </footer>
    </div>
  );
}
