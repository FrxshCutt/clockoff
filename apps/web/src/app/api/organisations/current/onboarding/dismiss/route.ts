import { emptyBodySchema } from "@clockoff/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { dismissOnboarding } from "@/server/organisations";

/** `POST /api/organisations/current/onboarding/dismiss` (`org:manage`) → `onboardingResponseSchema`. Idempotent. */
export const POST = createHandler(
  { auth: "manager", permission: "org:manage", body: emptyBodySchema },
  async ({ ctx }) => dismissOnboarding(ctx),
);
