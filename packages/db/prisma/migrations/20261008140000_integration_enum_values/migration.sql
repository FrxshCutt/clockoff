-- Planday integration, part 1 of 2 (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md section 2.2): activity types
-- for the integration feed. In their own migration because PostgreSQL cannot use an enum value added by
-- ALTER TYPE … ADD VALUE in the same transaction (20261008140100_planday_integration may reference them).
-- Additive only: the previous web and worker deployments never write these values.

-- AlterEnum
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'INTEGRATION_CONNECTED';
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'INTEGRATION_DISCONNECTED';
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'INTEGRATION_SYNCED';
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'EMPLOYEE_DEACTIVATED';
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'EMPLOYEE_REACTIVATED';
