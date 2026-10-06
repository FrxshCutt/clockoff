"use client";

import type { CommitImportResponse } from "@workmode/validation/imports";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { BackLink } from "@/components/placeholder-page";
import { CardSkeleton } from "@/components/loading-skeletons";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/config/navigation";
import { usePermission, useCurrentMembership } from "@/hooks/use-current-user";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { hasErrorCode } from "@/lib/api-client";
import { CommitStep } from "./commit-step";
import { useImport } from "./import-queries";
import { ImportStepper } from "./import-stepper";
import {
  IMPORT_STEP_META,
  importWizardSearch,
  stepForImportStatus,
  summaryFromImport,
  type ImportStep,
} from "./import-wizard-model";
import { MappingStep } from "./mapping-step";
import { ReviewStep } from "./review-step";
import { SummaryStep } from "./summary-step";
import { UploadStep } from "./upload-step";
import { ValidateStep } from "./validate-step";

export interface ImportWizardProps {
  /** `?import=<id>` — resume an import that was started earlier. */
  initialImportId: string | null;
}

/**
 * /schedule/import. The import record on the server is the source of truth: its status decides which steps
 * are reachable and where a resumed import lands, and every step hands its response back into the query
 * cache so the summary counts shown here are always the API's.
 */
export function ImportWizard({ initialImportId }: ImportWizardProps) {
  const canImport = usePermission("imports:write");
  const membership = useCurrentMembership();
  const organisation = useCurrentOrganisation();
  const organisationTimezone = membership?.timezone ?? "UTC";
  const defaultDateFormat = organisation.data?.organisation.dateFormat ?? "DMY";

  const [importId, setImportId] = useState<string | null>(initialImportId);
  const [chosenStep, setChosenStep] = useState<ImportStep | null>(
    initialImportId ? null : "upload",
  );
  const [sampleRows, setSampleRows] = useState<readonly Record<string, string>[]>([]);
  const [commitResult, setCommitResult] = useState<CommitImportResponse | null>(null);

  const importQuery = useImport(importId);
  const record = importQuery.data?.import ?? null;
  const step: ImportStep | null =
    chosenStep ?? (record ? stepForImportStatus(record.status) : null);

  // Keep the URL resumable.
  useEffect(() => {
    const search = importWizardSearch(importId);
    if (`${window.location.search}` !== search) {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${search}${window.location.hash}`,
      );
    }
  }, [importId]);

  const startOver = () => {
    setImportId(null);
    setChosenStep("upload");
    setSampleRows([]);
    setCommitResult(null);
  };

  const onValidated = useCallback(() => setChosenStep("review"), []);

  const meta = step ? IMPORT_STEP_META[step] : IMPORT_STEP_META.upload;

  let body: ReactNode;
  if (importId && importQuery.isError) {
    const notFound = hasErrorCode(importQuery.error, "NOT_FOUND");
    body = (
      <ErrorState
        title={notFound ? "This import wasn't found" : "Couldn't load the import"}
        description={
          notFound
            ? "It may have been removed, or the link belongs to another organisation."
            : undefined
        }
        error={notFound ? undefined : importQuery.error}
        onRetry={notFound ? undefined : () => void importQuery.refetch()}
        isRetrying={importQuery.isRefetching}
        actions={
          <Button type="button" size="sm" onClick={startOver}>
            Start a new import
          </Button>
        }
      />
    );
  } else if (importId && !record) {
    body = <CardSkeleton lines={6} />;
  } else if (!step || step === "upload" || !record) {
    body = (
      <UploadStep
        canImport={canImport}
        organisationTimezone={organisationTimezone}
        defaultDateFormat={defaultDateFormat}
        onUploaded={(response) => {
          setSampleRows(response.sampleRows);
          setCommitResult(null);
          setImportId(response.import.id);
          setChosenStep("map");
        }}
      />
    );
  } else if (step === "map") {
    body = (
      <MappingStep
        key={record.id}
        record={record}
        suggestion={importQuery.data?.suggestion}
        sampleRows={sampleRows}
        canImport={canImport}
        organisationTimezone={organisationTimezone}
        onSaved={() => setChosenStep("validate")}
        onBack={startOver}
      />
    );
  } else if (step === "validate") {
    body = (
      <ValidateStep
        key={record.id}
        importId={record.id}
        rowCount={record.rowCount}
        canImport={canImport}
        onValidated={onValidated}
        onBack={() => setChosenStep("map")}
      />
    );
  } else if (step === "review") {
    body = (
      <ReviewStep
        key={record.id}
        record={record}
        summary={summaryFromImport(record)}
        canImport={canImport}
        onContinue={() => setChosenStep("import")}
        onBack={() => setChosenStep("map")}
      />
    );
  } else if (step === "import") {
    body = (
      <CommitStep
        key={record.id}
        record={record}
        summary={summaryFromImport(record)}
        canImport={canImport}
        onCommitted={(response) => {
          setCommitResult(response);
          setChosenStep("summary");
        }}
        onBack={() => setChosenStep("review")}
      />
    );
  } else {
    body = <SummaryStep record={record} result={commitResult} onStartAnother={startOver} />;
  }

  return (
    <>
      <PageHeader
        title="Import schedule"
        description={meta.description}
        eyebrow={<BackLink href={ROUTES.schedule}>Schedule</BackLink>}
        actions={
          step && step !== "upload" && step !== "summary" ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={ROUTES.schedule}>Finish later</Link>
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-6">
        <ImportStepper
          current={step ?? "upload"}
          status={record?.status ?? null}
          onSelect={(next) => {
            if (next === "upload") startOver();
            else setChosenStep(next);
          }}
        />
        <section aria-label={meta.title} className="space-y-4">
          <div>
            <h2 className="text-foreground text-lg font-semibold tracking-tight">{meta.title}</h2>
          </div>
          {body}
        </section>
      </div>
    </>
  );
}
