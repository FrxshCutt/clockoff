"use client";

import { FormErrorAlert } from "@/components/forms/form-fields";
import { InlineAlert } from "@/components/inline-alert";
import { describeStructureConflict, type StructureKind } from "./locations-view-model";

/**
 * Form-level error for the location / department / team forms. A duplicate-name CONFLICT is shown on the
 * Name field by the form (nothing here), a plan-limit CONFLICT gets its own copy, and everything else falls
 * back to the generic `FormErrorAlert`.
 */
export function StructureErrorAlert({
  error,
  kind,
  title,
}: {
  error: unknown;
  kind: StructureKind;
  title: string;
}) {
  const conflict = describeStructureConflict(error, kind);
  if (conflict?.field) return null;
  if (conflict) {
    return (
      <InlineAlert variant="danger" title={title}>
        {conflict.message}
      </InlineAlert>
    );
  }
  return <FormErrorAlert error={error} title={title} />;
}
