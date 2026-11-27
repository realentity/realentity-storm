-- M71-T2: the hand-built Bills, Prices and Jobs pages are gone (their Apps replaced them, M33); so are their tables.
DROP TABLE "Applications";
DROP TABLE "JobPostings";
DROP TABLE "WatchedOffers";
DROP TABLE "WatchedProducts";
DROP TABLE "Bills";

DROP TYPE "ApplicationStatus";
DROP TYPE "JobPostingStatus";

-- M27's pipeline pages are gone: a stored version's `view` is dropped, and a trigger that no longer exists
-- (view.action, application.status) becomes manual, so the pipeline still opens and saves.
UPDATE "PipelineVersions" SET "definition" = "definition" - 'view' WHERE "definition" ? 'view';
UPDATE "PipelineVersions" SET "definition" = jsonb_set("definition", '{trigger}', '"manual"')
WHERE jsonb_typeof("definition" -> 'trigger') = 'object'
  AND "definition" -> 'trigger' ->> 'on' IN ('view.action', 'application.status');
