"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BrandLogo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { SITE } from "@/config/site";
import { cn } from "@/lib/utils";
import { MARKETING_CTA, MARKETING_NAV, MARKETING_ROUTES } from "./marketing-content";

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Public site header: logo, the five section links (collapsed into a sheet on small screens), "Log in" and
 * the "Request a demo" call to action. Sticky with a translucent backdrop so the nav stays reachable.
 */
export function MarketingHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // The sheet closes when a link inside it is chosen (client navigation keeps the header mounted).
  const closeMenu = () => setOpen(false);

  return (
    <header className="bg-background/85 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href={MARKETING_ROUTES.home} className="rounded-md" aria-label={`${SITE.name} home`}>
          <BrandLogo />
        </Link>

        <nav aria-label="Primary" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {MARKETING_NAV.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "focus-visible:ring-ring/50 inline-flex h-9 items-center rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px]",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/60",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href={MARKETING_CTA.login.href}>{MARKETING_CTA.login.label}</Link>
          </Button>
          <Button asChild size="sm">
            <Link href={MARKETING_CTA.primary.href}>{MARKETING_CTA.primary.label}</Link>
          </Button>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="lg:hidden"
                aria-label="Open menu"
              >
                <Menu aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full sm:max-w-sm">
              <SheetHeader>
                <SheetTitle>Menu</SheetTitle>
                <SheetDescription>{SITE.tagline}</SheetDescription>
              </SheetHeader>
              <nav aria-label="Primary" className="px-4">
                <ul className="flex flex-col gap-1">
                  {MARKETING_NAV.map((item) => {
                    const active = isActive(pathname, item.href);
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={closeMenu}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "focus-visible:ring-ring/50 flex h-11 items-center rounded-md px-3 text-base font-medium outline-none focus-visible:ring-[3px]",
                            active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                          )}
                        >
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </nav>
              <div className="mt-auto flex flex-col gap-2 border-t px-4 py-4">
                <Button asChild>
                  <Link href={MARKETING_CTA.primary.href} onClick={closeMenu}>
                    {MARKETING_CTA.primary.label}
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href={MARKETING_CTA.login.href} onClick={closeMenu}>
                    {MARKETING_CTA.login.label}
                  </Link>
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
