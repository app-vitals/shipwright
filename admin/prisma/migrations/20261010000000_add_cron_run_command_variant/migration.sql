-- Records which slash-command variant a loop dispatch ran (additive, nullable).
ALTER TABLE "AgentCronRun" ADD COLUMN "commandVariant" TEXT;
