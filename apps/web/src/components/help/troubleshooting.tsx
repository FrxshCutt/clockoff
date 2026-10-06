import { StatusBadge } from "@/components/status/status-badge";
import { TROUBLESHOOTING } from "./help-content";

/** Symptom → cause → steps for the problems managers hit most, tagged with the badge they show as. */
export function Troubleshooting() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {TROUBLESHOOTING.map((item) => (
        <article
          key={item.id}
          id={item.id}
          className="bg-card flex flex-col gap-4 rounded-xl border p-5 shadow-xs"
        >
          <div className="space-y-2">
            {item.badge ? <StatusBadge kind="deviceStatus" value={item.badge} size="sm" /> : null}
            <h3 className="font-semibold">{item.title}</h3>
          </div>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                What you see
              </dt>
              <dd className="mt-1 leading-relaxed">{item.symptom}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Why
              </dt>
              <dd className="mt-1 leading-relaxed">{item.cause}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                What to do
              </dt>
              <dd className="mt-1">
                <ol className="list-decimal space-y-1.5 pl-5 leading-relaxed">
                  {item.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}
