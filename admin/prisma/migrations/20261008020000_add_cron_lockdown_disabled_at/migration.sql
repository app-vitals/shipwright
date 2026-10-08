-- Records which crons the trial-expiry lockdown disabled (additive, nullable)
-- so they can be restored without touching crons the user disabled manually.
ALTER TABLE "AgentCronJob" ADD COLUMN "lockdownDisabledAt" TIMESTAMP(3);
