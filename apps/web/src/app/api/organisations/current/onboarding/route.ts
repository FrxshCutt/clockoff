import { createHandler } from "@/server/http/apiHandler";
import { getOnboarding } from "@/server/organisations";

/** `GET /api/organisations/current/onboarding` → `onboardingResponseSchema` (computed from real data). */
export const GET = createHandler({ auth: "manager" }, async ({ ctx }) => getOnboarding(ctx));
