import {
  IMPORT_LIMITS,
  importFileErrorToAppError,
  validateImportFile,
} from "@workmode/shared/csv/csvImport";
import { AppError } from "@workmode/shared/errors";
import {
  IMPORT_ACCEPTED_MIME_TYPES,
  importMetadataSchema,
  type ImportMetadataInput,
} from "@workmode/validation/imports";
import { z } from "zod";

/**
 * Reads the `POST /api/imports` multipart body. The route declares no `body` schema (so the handler
 * does not try to parse JSON) and the limits are enforced here instead:
 *
 * - the request must be `multipart/form-data`                    → UNSUPPORTED_MEDIA_TYPE (415)
 * - the body may not exceed the file limit plus form overhead    → PAYLOAD_TOO_LARGE (413)
 * - `file` must be present                                       → VALIDATION_ERROR (400)
 * - its MIME type must be a CSV type (or absent)                 → UNSUPPORTED_MEDIA_TYPE (415)
 * - name / size checks from the shared `validateImportFile`      → INVALID_CSV (400) / PAYLOAD_TOO_LARGE (413)
 * - the other fields must satisfy `importMetadataSchema`         → VALIDATION_ERROR (400)
 */

/** Room for the form fields and multipart framing around a 5 MB file. */
export const IMPORT_UPLOAD_MAX_BODY_BYTES = IMPORT_LIMITS.maxFileBytes + 64 * 1024;

export interface ImportUpload {
  file: File;
  /** The file decoded as UTF-8 (a BOM is handled by the CSV parser). */
  text: string;
  metadata: ImportMetadataInput;
}

const ACCEPTED_TYPES: ReadonlySet<string> = new Set(IMPORT_ACCEPTED_MIME_TYPES);

export function isAcceptedImportMimeType(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  // Browsers leave the type empty for unknown extensions; the extension check still applies.
  return type === "" || ACCEPTED_TYPES.has(type);
}

async function readBodyWithLimit(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", `The upload exceeds ${maxBytes} bytes`);
  }
  if (!req.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError("PAYLOAD_TOO_LARGE", `The upload exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function fieldError(field: string, message: string): AppError {
  return new AppError("VALIDATION_ERROR", "Invalid body", {
    details: { source: "body", formErrors: [], fieldErrors: { [field]: [message] } },
  });
}

export async function readImportUpload(
  req: Request,
  maxBodyBytes: number = IMPORT_UPLOAD_MAX_BODY_BYTES,
): Promise<ImportUpload> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\b/i.test(contentType)) {
    throw new AppError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Expected multipart/form-data with a `file` field",
    );
  }
  const bytes = await readBodyWithLimit(req, maxBodyBytes);

  let form: FormData;
  try {
    form = await new Request(req.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: bytes,
    }).formData();
  } catch {
    throw new AppError("VALIDATION_ERROR", "The multipart body could not be read");
  }

  const entry = form.get("file");
  if (entry === null || typeof entry === "string") {
    throw fieldError("file", "A CSV file is required");
  }
  const file = entry;
  if (!isAcceptedImportMimeType(file.type)) {
    throw new AppError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Upload a CSV file (text/csv, application/csv, application/vnd.ms-excel or text/plain)",
      { details: { contentType: file.type } },
    );
  }
  const fileProblems = validateImportFile({ name: file.name, size: file.size });
  if (fileProblems.length > 0) throw importFileErrorToAppError(fileProblems);

  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key === "file" || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") fields[key] = trimmed;
  }
  const metadata = importMetadataSchema.safeParse(fields);
  if (!metadata.success) {
    throw new AppError("VALIDATION_ERROR", "Invalid body", {
      details: { source: "body", ...z.flattenError(metadata.error) },
    });
  }

  return { file, text: await file.text(), metadata: metadata.data };
}
