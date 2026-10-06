import { Lightbulb, Smartphone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { IOS_MAIN_SCREENS, SETUP_STEPS } from "./help-content";

/** The employee's path through the iPhone app, screen by screen, with tips for the manager. */
export function SetupGuide() {
  return (
    <div className="space-y-8">
      <ol className="relative space-y-6 border-l pl-8">
        {SETUP_STEPS.map((step, index) => (
          <li key={step.key} className="relative">
            <span
              className="bg-primary text-primary-foreground ring-background absolute top-0 -left-[calc(2rem+1px)] flex size-8 -translate-x-1/2 items-center justify-center rounded-full text-sm font-semibold tabular-nums ring-4"
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{step.title}</h3>
                <Badge variant="outline" className="gap-1 font-mono text-[11px] font-normal">
                  <Smartphone className="size-3" aria-hidden="true" />
                  {step.screen}
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm leading-relaxed">{step.detail}</p>
              {step.managerTip ? (
                <p className="bg-muted/60 flex gap-2 rounded-lg px-3 py-2 text-sm">
                  <Lightbulb className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>
                    <span className="font-medium">Your part: </span>
                    {step.managerTip}
                  </span>
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">After setup</h3>
        <dl className="grid gap-3 sm:grid-cols-3">
          {IOS_MAIN_SCREENS.map((screen) => (
            <div key={screen.name} className="rounded-lg border p-4">
              <dt className="flex items-center gap-2 font-medium">
                <Smartphone className="text-muted-foreground size-4" aria-hidden="true" />
                {screen.name}
              </dt>
              <dd className="text-muted-foreground mt-1 text-sm">{screen.detail}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
