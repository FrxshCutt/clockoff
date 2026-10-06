"use client";

import { Plus, X } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface AlwaysAllowedEditorProps {
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  maxItems: number;
  maxLength: number;
  /** Id of the field error element (for `aria-describedby`). */
  errorId?: string;
}

/**
 * Editable chips for the "Always available" list shown to employees (Phone, Messages, Maps…). Each line is
 * plain text the employee sees in the app; it does not change what the phone restricts.
 */
export function AlwaysAllowedEditor({ value, onChange, disabled, maxItems, maxLength, errorId }: AlwaysAllowedEditorProps) {
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const listId = useId();
  const full = value.length >= maxItems;

  const add = () => {
    const text = draft.trim();
    if (text === "" || full) return;
    if (value.some((item) => item.toLowerCase() === text.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...value, text.slice(0, maxLength)]);
    setDraft("");
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-3">
      {value.length > 0 ? (
        <ul id={listId} className="flex flex-wrap gap-2" aria-label="Always available">
          {value.map((item, index) => (
            <li
              key={`${item}-${index}`}
              className="bg-muted text-foreground inline-flex max-w-full items-center gap-1 rounded-full border py-1 pr-1 pl-3 text-sm"
            >
              <span className="truncate">{item}</span>
              {disabled ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-full"
                  aria-label={`Remove ${item}`}
                  onClick={() => remove(index)}
                >
                  <X aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">Nothing listed yet. Employees see this list in the app.</p>
      )}
      {disabled ? null : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor={inputId} className="sr-only">
              Add an always-available item
            </Label>
            <Input
              id={inputId}
              value={draft}
              maxLength={maxLength}
              placeholder={full ? `Up to ${maxItems} items` : "e.g. Phone, Messages and FaceTime"}
              disabled={full}
              aria-describedby={errorId}
              aria-controls={listId}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
            />
          </div>
          <Button type="button" variant="outline" onClick={add} disabled={full || draft.trim() === ""}>
            <Plus aria-hidden="true" />
            Add
          </Button>
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        {value.length} of {maxItems} items. Press Enter to add.
      </p>
    </div>
  );
}
