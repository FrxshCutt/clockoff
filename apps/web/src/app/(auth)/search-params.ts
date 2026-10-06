/** Next.js 15 page `searchParams` (a Promise in server components). */
export type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

/** First value of a query parameter, or null. */
export async function readParam(
  searchParams: PageSearchParams,
  key: string,
): Promise<string | null> {
  const value = (await searchParams)[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.length > 0 ? first : null;
}
