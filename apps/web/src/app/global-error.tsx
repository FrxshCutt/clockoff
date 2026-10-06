"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary for errors thrown by the root layout itself. It must render its own <html>/<body>
 * and cannot rely on providers, fonts or the design system (they may be what failed), so it uses plain
 * markup and inline styles. Never shows the error message or stack; the digest matches the server log.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100svh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          background: "#fafafa",
          color: "#171717",
          padding: 16,
        }}
      >
        <main
          id="main-content"
          tabIndex={-1}
          style={{ maxWidth: 480, textAlign: "center", outline: "none" }}
        >
          <p style={{ fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 8 }}>Work Mode</p>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 8px" }}>Something went wrong</h1>
          <p style={{ color: "#525252", lineHeight: 1.5, margin: "0 0 20px" }}>
            An unexpected error stopped the app from loading. Try again, or reload the page.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button
              type="button"
              onClick={reset}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                border: "1px solid #171717",
                background: "#171717",
                color: "#fff",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.assign("/")}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                border: "1px solid #d4d4d4",
                background: "#fff",
                color: "#171717",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Go to the home page
            </button>
          </div>
          {error.digest ? (
            <p style={{ color: "#737373", fontSize: 12, marginTop: 20 }}>
              Reference:{" "}
              <span style={{ fontFamily: "ui-monospace, monospace" }}>{error.digest}</span>
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
