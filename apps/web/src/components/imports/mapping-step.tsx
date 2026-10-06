"use client";

import type { ColumnMapping, ImportField } from "@workmode/shared/csv/types";
import type { ImportResponse, ShiftImport } from "@workmode/validation/imports";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  CircleDashed,
  LoaderCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { FormErrorAlert } from "@/components/forms/form-fields";
import { InlineAlert } from "@/components/inline-alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { hasErrorCode } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useLocations } from "@/components/schedule/schedule-queries";
import { ImportOptionsFields } from "./import-options-fields";
import { useSaveMapping } from "./import-queries";
import {
  FIELD_OPTIONS,
  IGNORE_COLUMN,
  confidenceLabel,
  effectiveImportTimezone,
  fieldOf,
  initialMapping,
  isImportField,
  mappingRequirements,
  mappingStatus,
  readMappingCheckDetails,
  sampleValues,
  setMappingField,
  unconfirmedHeaders,
  type ImportOptionsInput,
} from "./import-wizard-model";

export type MappingSuggestion = NonNullable<ImportResponse["suggestion"]>;

export interface MappingStepProps {
  record: ShiftImport;
  suggestion: MappingSuggestion | undefined;
  /** First rows from the upload response (empty when the import was resumed). */
  sampleRows: readonly Record<string, string>[];
  canImport: boolean;
  organisationTimezone: string;
  onSaved: (response: ImportResponse) => void;
  onBack: () => void;
}

const CONFIDENCE_COPY = {
  exact: { label: "Matched", tone: "secondary" },
  alias: { label: "Suggested", tone: "secondary" },
  partial: { label: "Guessed", tone: "outline" },
  none: null,
} as const;

/**
 * Step 2: one row per CSV column with up to three sample values and a field selector. Suggestions that need
 * confirmation (generic headers such as "ID" or "Name") block "Continue" until confirmed or changed; each
 * field can be supplied by one column, so picking it elsewhere un-maps the previous column.
 */
export function MappingStep({
  record,
  suggestion,
  sampleRows,
  canImport,
  organisationTimezone,
  onSaved,
  onBack,
}: MappingStepProps) {
  const [mapping, setMapping] = useState<ColumnMapping>(() =>
    initialMapping(record.headers, record.columnMapping, suggestion?.mapping),
  );
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(() => new Set());
  const [options, setOptions] = useState<ImportOptionsInput>({
    dateFormat: record.options.dateFormat,
    timezone: record.options.timezone,
    locationId: record.options.locationId,
  });
  const save = useSaveMapping(record.id);
  const locations = useLocations();

  const status = useMemo(() => mappingStatus(mapping), [mapping]);
  const requirements = useMemo(() => mappingRequirements(mapping), [mapping]);
  const unconfirmed = useMemo(
    () => unconfirmedHeaders(mapping, suggestion, confirmed),
    [mapping, suggestion, confirmed],
  );
  const duplicatedFields = new Set<ImportField>(status.check.duplicated);

  const setField = (header: string, value: string) => {
    save.reset();
    setMapping((current) => setMappingField(current, header, isImportField(value) ? value : null));
    setConfirmed((current) => new Set([...current, header]));
  };
  const confirm = (header: string) => setConfirmed((current) => new Set([...current, header]));

  const canContinue =
    canImport && status.canContinue && unconfirmed.length === 0 && !save.isPending;

  const submit = async () => {
    if (!canContinue) return;
    try {
      // The stored options always hold a resolved zone, and the API keeps it when none is sent — so "Use default"
      // has to send the default (location zone, else organisation zone) explicitly to take effect.
      const timezone =
        options.timezone ??
        (locations.data
          ? effectiveImportTimezone(options, locations.data, organisationTimezone)
          : undefined);
      const response = await save.mutateAsync({
        mapping,
        options: { dateFormat: options.dateFormat, timezone, locationId: options.locationId },
      });
      onSaved(response);
    } catch {
      // Shown inline below.
    }
  };

  const incompleteDetails = hasErrorCode(save.error, "IMPORT_MAPPING_INCOMPLETE")
    ? readMappingCheckDetails(save.error.details)
    : [];

  return (
    <div className="space-y-6">
      {!canImport ? (
        <InlineAlert variant="info" title="View only">
          Your role can view this import but not change its mapping.
        </InlineAlert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="bg-card overflow-hidden rounded-xl border shadow-xs">
          <Table>
            <TableHeader className="bg-muted/60">
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className="px-4">
                  Column in your file
                </TableHead>
                <TableHead scope="col" className="px-4">
                  Sample values
                </TableHead>
                <TableHead scope="col" className="w-64 px-4">
                  Maps to
                </TableHead>
                <TableHead scope="col" className="w-40 px-4">
                  <span className="sr-only">Status</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {record.headers.map((header) => {
                const field = fieldOf(mapping, header);
                const samples = sampleValues(sampleRows, header);
                const confidence = CONFIDENCE_COPY[confidenceLabel(suggestion?.confidence[header])];
                const needsConfirm = unconfirmed.includes(header);
                const duplicated = field !== null && duplicatedFields.has(field);
                return (
                  <TableRow key={header}>
                    <TableCell className="px-4 py-3 align-top">
                      <div className="flex flex-col gap-1">
                        <span className="font-medium break-all">{header}</span>
                        {confidence && field !== null ? (
                          <Badge variant={confidence.tone} className="w-fit">
                            {confidence.label}
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-3 align-top">
                      {samples.length > 0 ? (
                        <ul
                          className="flex flex-wrap gap-1"
                          aria-label={`Sample values for ${header}`}
                        >
                          {samples.map((sample) => (
                            <li
                              key={sample}
                              className="bg-muted text-muted-foreground max-w-48 truncate rounded px-1.5 py-0.5 font-mono text-xs"
                            >
                              {sample}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          {sampleRows.length === 0
                            ? "Samples are only shown right after upload"
                            : "No values in the first rows"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-3 align-top">
                      <Select
                        value={field ?? IGNORE_COLUMN}
                        onValueChange={(value) => setField(header, value)}
                        disabled={!canImport || save.isPending}
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label={`Field for column ${header}`}
                          aria-invalid={duplicated || undefined}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FIELD_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              <span className="flex items-center gap-2">
                                <span>{option.label}</span>
                                {option.requirement === "required" ? (
                                  <span className="text-muted-foreground text-xs">required</span>
                                ) : option.requirement === "identifier" ? (
                                  <span className="text-muted-foreground text-xs">identifier</span>
                                ) : null}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="px-4 py-3 align-top">
                      {duplicated ? (
                        <span className="text-destructive flex items-center gap-1 text-xs font-medium">
                          <CircleAlert className="size-3.5" aria-hidden="true" />
                          Mapped twice
                        </span>
                      ) : needsConfirm ? (
                        <div className="flex flex-col items-start gap-1">
                          <span className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                            <CircleAlert className="size-3.5" aria-hidden="true" />
                            Please confirm
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            onClick={() => confirm(header)}
                            disabled={!canImport}
                          >
                            <Check aria-hidden="true" />
                            Confirm
                          </Button>
                        </div>
                      ) : field !== null ? (
                        <span className="text-muted-foreground flex items-center gap-1 text-xs">
                          <Check
                            className="size-3.5 text-emerald-600 dark:text-emerald-400"
                            aria-hidden="true"
                          />
                          Mapped
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">Ignored</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <aside className="space-y-4" aria-label="Required fields">
          <div className="bg-card rounded-xl border p-4 shadow-xs">
            <h3 className="text-sm font-semibold">Required fields</h3>
            <ul className="mt-3 space-y-2">
              {requirements.map((requirement) => (
                <li key={requirement.key} className="flex items-start gap-2 text-sm">
                  {requirement.satisfied ? (
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                      aria-hidden="true"
                    />
                  ) : (
                    <CircleDashed
                      className="text-muted-foreground mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0">
                    <p className={cn(!requirement.satisfied && "text-muted-foreground")}>
                      {requirement.label}
                    </p>
                    {requirement.headers.length > 0 ? (
                      <p className="text-muted-foreground truncate text-xs">
                        from {requirement.headers.join(", ")}
                      </p>
                    ) : null}
                  </div>
                  <span className="sr-only">{requirement.satisfied ? "mapped" : "not mapped"}</span>
                </li>
              ))}
            </ul>
            {unconfirmed.length > 0 ? (
              <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
                {unconfirmed.length === 1
                  ? "1 suggested column needs confirming."
                  : `${unconfirmed.length} suggested columns need confirming.`}
              </p>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">
            Unmapped columns are ignored but kept in the error report. Separate first/last name
            columns must be joined in the spreadsheet first.
          </p>
        </aside>
      </div>

      <section className="space-y-3" aria-label="Import options">
        <div>
          <h3 className="text-sm font-semibold">Import options</h3>
          <p className="text-muted-foreground text-sm">
            Change these if dates or times come out wrong, then re-validate.
          </p>
        </div>
        <ImportOptionsFields
          value={options}
          onChange={(next) => {
            save.reset();
            setOptions(next);
          }}
          organisationTimezone={organisationTimezone}
          disabled={!canImport || save.isPending}
        />
      </section>

      {save.error ? (
        hasErrorCode(save.error, "IMPORT_MAPPING_INCOMPLETE") ? (
          <InlineAlert variant="danger" title="The mapping isn't complete yet">
            {incompleteDetails.length > 0 ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {incompleteDetails.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              "Map a date, start time, end time and at least one employee identifier."
            )}
          </InlineAlert>
        ) : (
          <FormErrorAlert error={save.error} title="Couldn't save the mapping" />
        )
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="outline" onClick={onBack} disabled={save.isPending}>
          <ArrowLeft aria-hidden="true" />
          Back
        </Button>
        <div className="flex items-center gap-3">
          {!status.canContinue ? (
            <p className="text-muted-foreground text-sm">
              Still needed:{" "}
              {status.missing.concat(status.duplicated.map((d) => `${d} mapped once`)).join(", ")}
            </p>
          ) : null}
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!canContinue}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {save.isPending ? "Saving…" : "Save mapping and validate"}
            {!save.isPending ? <ArrowRight aria-hidden="true" /> : null}
          </Button>
        </div>
      </div>
    </div>
  );
}
