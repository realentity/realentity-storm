-- M37-T3: a dry run that stops after this step ("try up to here").
ALTER TABLE "Runs" ADD COLUMN "stopAfter" TEXT;
