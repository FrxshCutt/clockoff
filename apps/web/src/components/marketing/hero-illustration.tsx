import { cn } from "@/lib/utils";

/**
 * A day on one phone: the shift bar with Work Mode on, a break that relaxes it and the evening free again.
 * Inline SVG (CSP allows no third-party images) using theme tokens so it reads in both colour schemes.
 * Decorative; the visible copy next to it carries the meaning.
 */
export function HeroIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 560 340"
      className={cn("h-auto w-full", className)}
      aria-hidden="true"
      focusable="false"
    >
      {/* card */}
      <rect
        x="20"
        y="20"
        width="520"
        height="300"
        rx="22"
        className="fill-card stroke-border"
        strokeWidth="1.5"
      />
      <text x="48" y="64" className="fill-foreground" fontSize="16" fontWeight="600">
        Tuesday · Harbour Street
      </text>
      <text x="48" y="88" className="fill-muted-foreground" fontSize="12">
        Shift 09:00–17:00 · Break Rules: 30 min, up to 2 per shift
      </text>

      {/* timeline axis */}
      {["07", "09", "11", "13", "15", "17", "19"].map((hour, i) => {
        const x = 48 + i * 77;
        return (
          <g key={hour}>
            <line
              x1={x}
              y1="130"
              x2={x}
              y2="218"
              className="stroke-border"
              strokeWidth="1"
              strokeDasharray="2 4"
            />
            <text x={x} y="240" className="fill-muted-foreground" fontSize="11" textAnchor="middle">
              {hour}:00
            </text>
          </g>
        );
      })}

      {/* off shift (left) */}
      <rect x="48" y="150" width="77" height="48" rx="10" className="fill-muted" />
      <text x="86" y="178" className="fill-muted-foreground" fontSize="11" textAnchor="middle">
        Off shift
      </text>

      {/* working 09–13 */}
      <rect x="125" y="150" width="154" height="48" rx="10" className="fill-primary" />
      <text
        x="202"
        y="170"
        className="fill-primary-foreground"
        fontSize="12"
        fontWeight="600"
        textAnchor="middle"
      >
        Work Mode on
      </text>
      <text
        x="202"
        y="186"
        className="fill-primary-foreground"
        fontSize="10"
        textAnchor="middle"
        opacity="0.85"
      >
        social, games, streaming paused
      </text>

      {/* break 13:00–13:30 */}
      <rect x="279" y="150" width="19" height="48" rx="6" className="fill-warning" />
      <text
        x="289"
        y="128"
        className="fill-foreground"
        fontSize="11"
        textAnchor="middle"
        fontWeight="600"
      >
        Break
      </text>

      {/* working 13:30–17 */}
      <rect x="298" y="150" width="135" height="48" rx="10" className="fill-primary" />
      <text
        x="365"
        y="170"
        className="fill-primary-foreground"
        fontSize="12"
        fontWeight="600"
        textAnchor="middle"
      >
        Back to work
      </text>
      <text
        x="365"
        y="186"
        className="fill-primary-foreground"
        fontSize="10"
        textAnchor="middle"
        opacity="0.85"
      >
        shields return automatically
      </text>

      {/* off shift (right) */}
      <rect x="433" y="150" width="79" height="48" rx="10" className="fill-muted" />
      <text x="472" y="178" className="fill-muted-foreground" fontSize="11" textAnchor="middle">
        Home time
      </text>

      {/* status pills */}
      <g>
        <rect
          x="48"
          y="266"
          width="150"
          height="30"
          rx="15"
          className="fill-success/15 stroke-success/40"
          strokeWidth="1"
        />
        <circle cx="66" cy="281" r="5" className="fill-success" />
        <text x="80" y="285" className="fill-foreground" fontSize="12" fontWeight="500">
          Phone connected
        </text>
      </g>
      <g>
        <rect
          x="210"
          y="266"
          width="186"
          height="30"
          rx="15"
          className="fill-primary/10 stroke-primary/30"
          strokeWidth="1"
        />
        <circle cx="228" cy="281" r="5" className="fill-primary" />
        <text x="242" y="285" className="fill-foreground" fontSize="12" fontWeight="500">
          Manager sees: Working
        </text>
      </g>
      <g>
        <rect
          x="408"
          y="266"
          width="104"
          height="30"
          rx="15"
          className="fill-muted stroke-border"
          strokeWidth="1"
        />
        <text x="460" y="285" className="fill-muted-foreground" fontSize="12" textAnchor="middle">
          Never: screens
        </text>
      </g>
    </svg>
  );
}
