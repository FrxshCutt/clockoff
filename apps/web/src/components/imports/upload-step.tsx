"use client";

import type { DateFormat } from "@workmode/shared/enums";
import { IMPORT_LIMITS } from "@workmode/shared/csv/types";
import type { CreateImportResponse } from "@workmode/validation/imports";
import { Download, FileSpreadsheet, FileUp, LoaderCircle, X } from "lucide-react";
import { useId, useRef, useState, type DragEvent } from "react";
import { FormErrorAlert } from "@/components/forms/form-fields";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { EMPTY_STATES } from "@/config/emptyStates";
import { hasErrorCode, isApiClientError } from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ImportOptionsFields } from "./import-options-fields";
import { useUploadImport } from "./import-queries";
import {
  IMPORT_FILE_ACCEPT,
  IMPORT_TEMPLATE_URL,
  checkImportFile,
  formatFileSize,
  readFileProblems,
  uploadMetadataEntries,
  type ImportOptionsInput,
} from "./import-wizard-model";

export interface UploadStepProps {
  canImport: boolean;
  organisationTimezone: string;
  defaultDateFormat: DateFormat;
  onUploaded: (response: CreateImportResponse) => void;
}

/**
 * Step 1: pick a CSV (drop zone or file dialog), choose the import options and upload. The file is checked
 * in the browser first (extension, size, not empty) so an obviously wrong file never leaves the machine.
 */
export function UploadStep({
  canImport,
  organisationTimezone,
  defaultDateFormat,
  onUploaded,
}: UploadStepProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [contentType, setContentType] = useState<string>("text/csv");
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [options, setOptions] = useState<ImportOptionsInput>({
    dateFormat: defaultDateFormat,
    timezone: null,
    locationId: null,
  });
  const upload = useUploadImport();

  const pick = (candidate: File | null | undefined) => {
    upload.reset();
    if (!candidate) return;
    const check = checkImportFile(candidate);
    if (!check.ok) {
      setFile(null);
      setFileError(check.message);
      return;
    }
    setFile(candidate);
    setContentType(check.contentType);
    setFileError(null);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!canImport) return;
    pick(event.dataTransfer.files?.[0]);
  };

  const submit = async () => {
    if (!file || !canImport) return;
    const formData = new FormData();
    // Browsers often report no MIME type for .csv; send the one derived from the extension so the API's
    // content-type check passes for a file we already know is CSV-like.
    formData.append(
      "file",
      file.type === contentType ? file : new File([file], file.name, { type: contentType }),
      file.name,
    );
    for (const [key, value] of uploadMetadataEntries(options)) formData.append(key, value);
    try {
      const response = await upload.mutateAsync(formData);
      onUploaded(response);
    } catch {
      // Shown inline below.
    }
  };

  const clear = () => {
    upload.reset();
    setFile(null);
    setFileError(null);
  };

  const fileProblems = isApiClientError(upload.error) ? readFileProblems(upload.error.details) : [];
  const copy = EMPTY_STATES.scheduleImport;
  const Icon = copy.icon;

  return (
    <div className="space-y-6">
      {!canImport ? (
        <InlineAlert variant="info" title="View only">
          Your role can view imports but not upload new ones.
        </InlineAlert>
      ) : null}

      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (canImport && !dragging) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "bg-card/50 flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed px-6 py-12 text-center transition-colors",
          dragging && "border-primary bg-primary/5",
          !canImport && "opacity-70",
        )}
      >
        <div
          className="bg-primary/10 text-primary ring-primary/15 flex size-12 items-center justify-center rounded-full ring-8"
          aria-hidden="true"
        >
          <Icon className="size-6" />
        </div>
        <div className="max-w-md space-y-1.5">
          <h2 className="text-foreground text-lg font-semibold tracking-tight">{copy.title}</h2>
          <p className="text-muted-foreground text-sm text-pretty">{copy.description}</p>
        </div>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={IMPORT_FILE_ACCEPT}
          className="sr-only"
          aria-label="Choose a CSV file"
          disabled={!canImport}
          onChange={(event) => {
            pick(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" onClick={() => inputRef.current?.click()} disabled={!canImport}>
            <FileUp aria-hidden="true" />
            {copy.action.label}
          </Button>
          <span className="text-muted-foreground text-sm">or drag a file here</span>
        </div>
        <p className="text-muted-foreground text-xs">
          CSV up to {formatFileSize(IMPORT_LIMITS.maxFileBytes)} and{" "}
          {formatNumber(IMPORT_LIMITS.maxRows)} rows. Comma, semicolon or tab separated.{" "}
          <a
            href={IMPORT_TEMPLATE_URL}
            download
            className="text-primary inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
          >
            <Download className="size-3.5" aria-hidden="true" />
            Download the template
          </a>
        </p>
      </div>

      {fileError ? (
        <InlineAlert variant="danger" title="That file can't be imported">
          {fileError}
        </InlineAlert>
      ) : null}

      {file ? (
        <div className="bg-card flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <FileSpreadsheet className="text-muted-foreground size-5 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{file.name}</p>
              <p className="text-muted-foreground text-xs">{formatFileSize(file.size)}</p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove file"
            onClick={clear}
            disabled={upload.isPending}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      <section aria-labelledby={`${inputId}-options`} className="space-y-3">
        <div>
          <h3 id={`${inputId}-options`} className="text-sm font-semibold">
            Import options
          </h3>
          <p className="text-muted-foreground text-sm">
            You can change these again when mapping columns.
          </p>
        </div>
        <ImportOptionsFields
          value={options}
          onChange={setOptions}
          organisationTimezone={organisationTimezone}
          disabled={!canImport || upload.isPending}
        />
      </section>

      {upload.error ? (
        hasErrorCode(upload.error, "INVALID_CSV", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE") &&
        fileProblems.length > 0 ? (
          <InlineAlert variant="danger" title="We couldn't read that file">
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {fileProblems.map((problem, index) => (
                <li key={`${problem.code}-${index}`}>{problem.message}</li>
              ))}
            </ul>
          </InlineAlert>
        ) : (
          <FormErrorAlert error={upload.error} title="Couldn't upload the file" />
        )
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={!file || !canImport || upload.isPending}
          aria-busy={upload.isPending || undefined}
        >
          {upload.isPending ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <FileUp aria-hidden="true" />
          )}
          {upload.isPending ? "Uploading…" : "Upload and continue"}
        </Button>
      </div>
    </div>
  );
}
