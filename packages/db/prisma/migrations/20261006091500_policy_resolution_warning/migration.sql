-- §6.1: record a WARNING activity when policy resolution is ambiguous (multiple team assignments).
ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS 'POLICY_RESOLUTION_WARNING';
