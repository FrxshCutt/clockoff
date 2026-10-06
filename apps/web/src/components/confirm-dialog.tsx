"use client";

import { LoaderCircle } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ConfirmDialogProps {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for irreversible actions. */
  destructive?: boolean;
  /**
   * Runs on confirm. The dialog stays open (with a spinner) until the promise settles and closes only on
   * success, so a failed request leaves the user where they were (show the error via toast in the caller).
   */
  onConfirm: () => Promise<unknown> | void;
  /** Require typing this exact text (e.g. the organisation name) before confirming. */
  confirmationText?: string;
  /** Uncontrolled usage: the element that opens the dialog (rendered with `asChild`). */
  trigger?: ReactNode;
  /** Controlled usage. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  confirmationText,
  trigger,
  open: openProp,
  onOpenChange,
  children,
}: ConfirmDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const open = openProp ?? uncontrolledOpen;

  const setOpen = (next: boolean) => {
    if (pending && !next) return; // don't close mid-request
    if (!next) setTyped("");
    if (openProp === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const confirmDisabled = pending || (confirmationText !== undefined && typed.trim() !== confirmationText);

  const handleConfirm = async () => {
    setPending(true);
    try {
      await onConfirm();
      setPending(false);
      setTyped("");
      if (openProp === undefined) setUncontrolledOpen(false);
      onOpenChange?.(false);
    } catch {
      // The caller reports the error; keep the dialog open so the user can retry or cancel.
      setPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children}
        {confirmationText !== undefined ? (
          <div className="space-y-2">
            <Label htmlFor={inputId} className="text-sm font-normal">
              Type <span className="font-semibold">{confirmationText}</span> to confirm
            </Label>
            <Input
              id={inputId}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
            />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={confirmDisabled}
            aria-busy={pending || undefined}
          >
            {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
