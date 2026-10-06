"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errorMessages";

export interface ApiErrorToastOptions {
  /** Short headline, e.g. "Couldn't save changes". The mapped error copy becomes the description. */
  title?: string;
  /** Copy used when the error has no known code. */
  fallback?: string;
}

/** Shows an error toast with human copy for any thrown value (API errors, network errors, unknown errors). */
export function showApiErrorToast(error: unknown, options: ApiErrorToastOptions = {}): void {
  const message = getErrorMessage(error, options.fallback);
  if (options.title) {
    toast.error(options.title, { description: message });
  } else {
    toast.error(message);
  }
}

export function useApiErrorToast(): (error: unknown, options?: ApiErrorToastOptions) => void {
  return useCallback((error: unknown, options?: ApiErrorToastOptions) => showApiErrorToast(error, options), []);
}
