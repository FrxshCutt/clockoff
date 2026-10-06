import { INTEGRATION_PROVIDERS } from "@workmode/shared/enums";
import { DEVICE_TO_SERVER_ALLOWED_FIELDS } from "@workmode/shared/privacyStatements";
import { PROVIDERS } from "@workmode/shared/providers/registry";

/**
 * The exact fields the iPhone app is allowed to send (`DEVICE_TO_SERVER_ALLOWED_FIELDS`, the same list the
 * mobile API enforces), one row per group. Server component.
 */
export function PrivacyAllowedFields() {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-sm">
        <caption className="sr-only">
          Fields the Work Mode app may send to the server, by group
        </caption>
        <thead className="bg-muted/50 border-b">
          <tr>
            <th
              scope="col"
              className="text-muted-foreground px-4 py-3 text-left text-xs font-medium tracking-wide uppercase"
            >
              What
            </th>
            <th
              scope="col"
              className="text-muted-foreground px-4 py-3 text-left text-xs font-medium tracking-wide uppercase"
            >
              Fields
            </th>
            <th
              scope="col"
              className="text-muted-foreground px-4 py-3 text-left text-xs font-medium tracking-wide uppercase"
            >
              Why
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {DEVICE_TO_SERVER_ALLOWED_FIELDS.map((group) => (
            <tr key={group.key} data-key={group.key} className="align-top">
              <th scope="row" className="px-4 py-3 text-left font-medium whitespace-nowrap">
                {group.label}
              </th>
              <td className="px-4 py-3">
                <ul className="flex flex-wrap gap-1.5">
                  {group.fields.map((field) => (
                    <li key={field}>
                      <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                        {field}
                      </code>
                    </li>
                  ))}
                </ul>
              </td>
              <td className="text-muted-foreground min-w-64 px-4 py-3 leading-relaxed">
                {group.detail}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "A, B and C" */
function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

/**
 * The integrations statement, derived from the provider registry so it can never claim a sync that does not
 * exist (mirrors `renderPrivacyMarkdown` in @workmode/shared).
 */
export function integrationsPrivacyStatement(): string {
  const names = formatList(INTEGRATION_PROVIDERS.map((id) => PROVIDERS[id].displayName));
  const anyAvailable = INTEGRATION_PROVIDERS.some((id) => PROVIDERS[id].status === "AVAILABLE");
  return anyAvailable
    ? `Workforce integrations (${names}) only bring employees, teams, locations, shifts and clock events into Work Mode. Nothing about the phone is sent to them.`
    : `Workforce integrations (${names}) are not available yet. When they are, they will only bring employees, teams, locations, shifts and clock events into Work Mode; nothing about the phone will be sent to them.`;
}
