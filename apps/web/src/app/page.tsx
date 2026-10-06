import { ArrowRight, CalendarClock, Coffee, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { BrandLogo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/config/navigation";
import { SITE } from "@/config/site";

const HIGHLIGHTS = [
  {
    icon: CalendarClock,
    title: "Follows your rota",
    body: "Work Mode switches on when a shift starts and off when it ends. No one has to remember.",
  },
  {
    icon: Coffee,
    title: "Breaks stay breaks",
    body: "Restrictions relax during breaks, exactly as your Break Rules allow.",
  },
  {
    icon: ShieldCheck,
    title: "Private by design",
    body: "Managers see whether Work Mode is on. Never which apps someone uses or for how long.",
  },
] as const;

/** Minimal landing page until the marketing site ships. */
export default function HomePage() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Link href={ROUTES.home} className="rounded-md" aria-label={`${SITE.name} home`}>
          <BrandLogo />
        </Link>
        <nav aria-label="Account" className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={ROUTES.login}>Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href={ROUTES.register}>Get started</Link>
          </Button>
        </nav>
      </header>
      <main id="main-content" tabIndex={-1} className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center gap-16 px-4 py-16 sm:px-6 outline-none">
        <section className="max-w-3xl space-y-6">
          <p className="text-primary text-sm font-semibold tracking-wide uppercase">{SITE.privacyLine}</p>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{SITE.tagline}</h1>
          <p className="text-muted-foreground max-w-2xl text-lg text-pretty">
            Your rota manages when your team works. Work Mode makes sure their phones know they&apos;re working too.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href={ROUTES.register}>
                Create your workspace
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href={ROUTES.login}>Sign in</Link>
            </Button>
          </div>
        </section>
        <section aria-label="Highlights" className="grid gap-4 sm:grid-cols-3">
          {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
            <div key={title} className="bg-card rounded-xl border p-6 shadow-xs">
              <span className="bg-primary/10 text-primary mb-4 flex size-10 items-center justify-center rounded-lg" aria-hidden="true">
                <Icon className="size-5" />
              </span>
              <h2 className="font-semibold">{title}</h2>
              <p className="text-muted-foreground mt-1 text-sm">{body}</p>
            </div>
          ))}
        </section>
      </main>
      <footer className="text-muted-foreground mx-auto w-full max-w-6xl px-4 py-8 text-sm sm:px-6">
        © {SITE.name}
      </footer>
    </div>
  );
}
