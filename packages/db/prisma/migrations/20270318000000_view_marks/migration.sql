-- M27: marks I set on a row of a pipeline's page; data.save never writes them.
ALTER TABLE "DataRecords" ADD COLUMN "marks" JSONB NOT NULL DEFAULT '{}';
