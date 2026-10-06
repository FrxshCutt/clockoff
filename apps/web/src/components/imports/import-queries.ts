"use client";

import type {
  CommitImportInput,
  CommitImportResponse,
  CreateImportResponse,
  ImportMappingInput,
  ImportResponse,
  ImportRow,
  ImportRowResponse,
  ListImportRowsResponse,
  UpdateImportRowInput,
  ValidateImportResponse,
} from "@workmode/validation/imports";
import type { ShiftImportRowStatus } from "@workmode/shared/enums";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { api, apiFetch } from "@/lib/api-client";
import { applySummaryToImport } from "./import-wizard-model";

/** Queries and mutations for the `/api/imports` wizard. Keys start with "org" like the rest of the dashboard. */
export const importKeys = {
  root: ["org", "imports"] as const,
  detail: (id: string) => ["org", "imports", "detail", id] as const,
  rows: (id: string, status: ShiftImportRowStatus | null, page: number, pageSize: number) =>
    ["org", "imports", "rows", id, status, page, pageSize] as const,
  rowsRoot: (id: string) => ["org", "imports", "rows", id] as const,
};

/** Shift range queries owned by the schedule page; a commit creates shifts, so they are refreshed. */
const SHIFTS_ROOT_KEY = ["org", "shifts"] as const;

const importPath = (id: string) => `/api/imports/${encodeURIComponent(id)}`;

export function useImport(id: string | null) {
  return useQuery({
    queryKey: importKeys.detail(id ?? ""),
    enabled: id !== null,
    queryFn: ({ signal }) => api.get<ImportResponse>(importPath(id ?? ""), undefined, signal),
  });
}

export interface ImportRowsInput {
  id: string;
  status: ShiftImportRowStatus | null;
  page: number;
  pageSize: number;
}

export function useImportRows(input: ImportRowsInput | null) {
  return useQuery({
    queryKey: input
      ? importKeys.rows(input.id, input.status, input.page, input.pageSize)
      : ["org", "imports", "rows", "disabled"],
    enabled: input !== null,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<ListImportRowsResponse>(
        `${importPath(input?.id ?? "")}/rows`,
        { status: input?.status ?? undefined, page: input?.page, pageSize: input?.pageSize },
        signal,
      ),
  });
}

function setImportDetail(queryClient: QueryClient, response: ImportResponse) {
  queryClient.setQueryData<ImportResponse>(importKeys.detail(response.import.id), (current) => ({
    ...current,
    ...response,
    // A later response without a suggestion must not drop the one we already have.
    suggestion: response.suggestion ?? current?.suggestion,
  }));
}

/** `POST /api/imports` (multipart). */
export function useUploadImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (formData: FormData) =>
      apiFetch<CreateImportResponse>("/api/imports", { method: "POST", body: formData }),
    onSuccess: (response) => {
      queryClient.setQueryData<ImportResponse>(importKeys.detail(response.import.id), {
        import: response.import,
        suggestion: response.suggestion,
      });
    },
  });
}

export function useSaveMapping(id: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportMappingInput) =>
      api.post<ImportResponse>(`${importPath(id ?? "")}/mapping`, input),
    onSuccess: (response) => setImportDetail(queryClient, response),
  });
}

export function useValidateImport(id: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ValidateImportResponse>(`${importPath(id ?? "")}/validate`, {}),
    onSuccess: async (response) => {
      setImportDetail(queryClient, {
        import: applySummaryToImport(response.import, response.summary),
      });
      await queryClient.invalidateQueries({ queryKey: importKeys.rowsRoot(response.import.id) });
    },
  });
}

export interface UpdateRowVariables {
  rowId: string;
  input: UpdateImportRowInput;
}

/**
 * `PATCH /api/imports/:id/rows/:rowId` — the returned row replaces the cached one and the import's counts
 * take the returned summary; the row lists are then refetched because a status change moves the row
 * between tabs.
 */
export function useUpdateImportRow(id: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rowId, input }: UpdateRowVariables) =>
      api.patch<ImportRowResponse>(
        `${importPath(id ?? "")}/rows/${encodeURIComponent(rowId)}`,
        input,
      ),
    onSuccess: async (response) => {
      if (!id) return;
      queryClient.setQueriesData<ListImportRowsResponse>(
        { queryKey: importKeys.rowsRoot(id) },
        (current) =>
          current
            ? {
                ...current,
                items: current.items.map((row: ImportRow) =>
                  row.id === response.row.id ? response.row : row,
                ),
              }
            : current,
      );
      queryClient.setQueryData<ImportResponse>(importKeys.detail(id), (current) =>
        current
          ? { ...current, import: applySummaryToImport(current.import, response.summary) }
          : current,
      );
      await queryClient.invalidateQueries({ queryKey: importKeys.rowsRoot(id) });
    },
  });
}

export function useCommitImport(id: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CommitImportInput) =>
      api.post<CommitImportResponse>(`${importPath(id ?? "")}/commit`, input),
    onSuccess: async (response) => {
      setImportDetail(queryClient, { import: response.import });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: importKeys.rowsRoot(response.import.id) }),
        queryClient.invalidateQueries({ queryKey: SHIFTS_ROOT_KEY }),
      ]);
    },
  });
}
