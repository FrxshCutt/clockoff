"use client";

import { Check, Copy } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

export interface CopyButtonProps extends Omit<ComponentProps<typeof Button>, "onClick" | "children" | "value"> {
  /** Text placed on the clipboard. */
  value: string;
  /** Accessible name, e.g. "Copy join code". Also the tooltip. */
  label?: string;
  /** Toast shown on success. Set to `null` to suppress. */
  successMessage?: string | null;
  /** Visible content; defaults to an icon-only button. */
  children?: ReactNode;
}

export function CopyButton({
  value,
  label = "Copy to clipboard",
  successMessage = "Copied to clipboard",
  children,
  variant = "outline",
  size,
  className,
  ...props
}: CopyButtonProps) {
  const { copy, copied } = useCopyToClipboard();

  const onClick = async () => {
    const ok = await copy(value);
    if (!ok) {
      toast.error("Couldn't copy. Select the text and copy it manually.");
      return;
    }
    if (successMessage) toast.success(successMessage);
  };

  const Icon = copied ? Check : Copy;
  return (
    <Button
      type="button"
      variant={variant}
      size={size ?? (children ? "sm" : "icon-sm")}
      aria-label={children ? undefined : label}
      title={label}
      onClick={onClick}
      className={cn(className)}
      {...props}
    >
      <Icon className={cn(copied && "text-emerald-600 dark:text-emerald-400")} aria-hidden="true" />
      {children}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </Button>
  );
}
