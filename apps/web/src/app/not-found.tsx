import { Compass } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { BrandLogo } from "@/components/brand";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/config/navigation";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-svh flex-col items-center justify-center gap-8 p-4 outline-none"
    >
      <Link href={ROUTES.home} aria-label="ClockOff home" className="rounded-md">
        <BrandLogo />
      </Link>
      <EmptyState
        className="bg-card w-full max-w-lg border-solid"
        icon={Compass}
        title="We couldn't find that page"
        description="The link may be broken, or the page may have moved. Check the address or head back to your overview."
        action={
          <Button asChild>
            <Link href={ROUTES.overview}>Go to overview</Link>
          </Button>
        }
        secondaryAction={
          <Button asChild variant="outline">
            <Link href={ROUTES.help}>Get help</Link>
          </Button>
        }
      />
    </main>
  );
}
