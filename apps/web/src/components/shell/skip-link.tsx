/** First focusable element on every page: jumps keyboard users past the navigation to `#main-content`. */
export function SkipLink({ targetId = "main-content" }: { targetId?: string }) {
  return (
    <a
      href={`#${targetId}`}
      className="bg-background text-foreground focus-visible:ring-ring sr-only z-[100] rounded-md border px-4 py-2 text-sm font-medium shadow-lg focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus-visible:ring-2"
    >
      Skip to main content
    </a>
  );
}
