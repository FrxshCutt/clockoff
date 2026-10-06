import { cn } from "@/lib/utils";
import { SITE } from "@/config/site";

/** Work Mode mark: a rounded square with a focus "shield" glyph. Decorative; pair with the visible name. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8 shrink-0", className)} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path
        d="M16 7.5 23.5 10v5.6c0 4.6-3.1 8.1-7.5 9.4-4.4-1.3-7.5-4.8-7.5-9.4V10L16 7.5Z"
        className="fill-primary-foreground/95"
      />
      <path d="m12.6 16.1 2.4 2.4 4.6-4.8" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="stroke-primary" />
    </svg>
  );
}

export function BrandLogo({ className, showName = true }: { className?: string; showName?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <BrandMark />
      {showName ? <span className="text-foreground text-base font-semibold tracking-tight">{SITE.name}</span> : null}
    </span>
  );
}
