"use client";

import type { Policy } from "@workmode/validation/policies";
import { LoaderCircle, Rocket } from "lucide-react";
import { useId, useState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getErrorMessage } from "@/lib/errorMessages";
import { PUBLISH_IMPACT_HELP, nextVersionNumber, publishImpactText } from "./policy-view-model";

export const CHANGE_NOTE_MAX_LENGTH = 500;

export interface PublishPolicyDialogProps {
  policy: Policy;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs the publish request; the dialog stays open and shows the error if it rejects. */
  onPublish: (changeNote: string | undefined) => Promise<unknown>;
}

/** "Publish v2?" — change note plus the honest impact line ("v2 will be sent to N devices"). */
export function PublishPolicyDialog({
  policy,
  open,
  onOpenChange,
  onPublish,
}: PublishPolicyDialogProps) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const noteId = useId();
  const version = nextVersionNumber(policy);

  const close = (next: boolean) => {
    if (pending) return;
    if (!next) {
      setNote("");
      setError(null);
    }
    onOpenChange(next);
  };

  const publish = async () => {
    setPending(true);
    setError(null);
    try {
      const trimmed = note.trim();
      await onPublish(trimmed === "" ? undefined : trimmed);
      setPending(false);
      setNote("");
      onOpenChange(false);
    } catch (err) {
      setError(err);
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Publish v{version}?</DialogTitle>
          <DialogDescription>
            Publishing makes this the version employees&apos; phones enforce. Earlier versions stay
            in the history.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <InlineAlert variant="info" icon={Rocket} title={publishImpactText(policy)}>
            {PUBLISH_IMPACT_HELP}
          </InlineAlert>
          {error ? (
            <InlineAlert variant="danger" title="Couldn't publish">
              {getErrorMessage(error)}
            </InlineAlert>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor={noteId}>
              Change note <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Textarea
              id={noteId}
              value={note}
              maxLength={CHANGE_NOTE_MAX_LENGTH}
              rows={3}
              placeholder="What changed and why, for the version history."
              onChange={(event) => setNote(event.target.value)}
              disabled={pending}
              aria-describedby={`${noteId}-count`}
            />
            <p
              id={`${noteId}-count`}
              className="text-muted-foreground text-right text-xs tabular-nums"
            >
              {note.length} / {CHANGE_NOTE_MAX_LENGTH}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void publish()}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <Rocket aria-hidden="true" />
            )}
            Publish v{version}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
