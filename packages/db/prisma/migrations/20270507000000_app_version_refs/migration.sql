-- M39-T2: the pipelines an App version's buttons run, by id, as resolved when it was saved.
ALTER TABLE "AppVersions" ADD COLUMN "refs" JSONB;
