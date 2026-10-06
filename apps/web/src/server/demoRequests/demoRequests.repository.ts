import { prisma, type DemoRequest, type Prisma } from "@workmode/db";

/** Marketing demo requests. Not tenant-owned: there is no organisation yet. */

export type Db = Prisma.TransactionClient | typeof prisma;

export interface DemoRequestData {
  name: string;
  email: string;
  company: string;
  teamSize: string | null;
  message: string | null;
  source: string | null;
}

export async function createDemoRequest(
  data: DemoRequestData,
  db: Db = prisma,
): Promise<DemoRequest> {
  return db.demoRequest.create({ data });
}
