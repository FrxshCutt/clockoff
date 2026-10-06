"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Copies text using the async Clipboard API, falling back to a hidden textarea for older/insecure contexts. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

/** `copy(text)` resolves to success; `copied` stays true for `resetAfterMs` so the UI can show a check mark. */
export function useCopyToClipboard(resetAfterMs = 2000) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyTextToClipboard(text);
      if (timer.current) clearTimeout(timer.current);
      setCopied(ok);
      if (ok) timer.current = setTimeout(() => setCopied(false), resetAfterMs);
      return ok;
    },
    [resetAfterMs],
  );

  return { copy, copied };
}
