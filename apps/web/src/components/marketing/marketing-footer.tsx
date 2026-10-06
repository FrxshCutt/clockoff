import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { BrandLogo } from "@/components/brand";
import { SITE } from "@/config/site";
import { FOOTER_GROUPS, MARKETING_ROUTES } from "./marketing-content";

const linkClass =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm text-sm outline-none underline-offset-4 hover:underline focus-visible:ring-[3px]";

/** Public site footer: brand and privacy line, link groups, copyright. Server component. */
export function MarketingFooter() {
  return (
    <footer className="bg-muted/30 border-t">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="space-y-4">
          <Link
            href={MARKETING_ROUTES.home}
            className="inline-block rounded-md"
            aria-label={`${SITE.name} home`}
          >
            <BrandLogo />
          </Link>
          <p className="text-muted-foreground max-w-xs text-sm">{SITE.description}</p>
          <p className="inline-flex items-center gap-1.5 text-sm font-medium">
            <ShieldCheck className="text-primary size-4" aria-hidden="true" />
            {SITE.privacyLine}
          </p>
        </div>
        {FOOTER_GROUPS.map((group) => (
          <nav key={group.title} aria-label={group.title} className="space-y-3">
            <h2 className="text-sm font-semibold">{group.title}</h2>
            <ul className="space-y-2">
              {group.links.map((link) => (
                <li key={link.href}>
                  {link.external ? (
                    <a href={link.href} className={linkClass}>
                      {link.label}
                    </a>
                  ) : (
                    <Link href={link.href} className={linkClass}>
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t">
        <div className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-5 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            © {new Date().getFullYear()} {SITE.name}. For iPhone, built on Apple Screen Time.
          </p>
          <p>Apple, iPhone and Screen Time are trademarks of Apple Inc.</p>
        </div>
      </div>
    </footer>
  );
}
