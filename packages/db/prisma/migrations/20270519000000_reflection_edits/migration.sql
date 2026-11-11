-- M44-T3: the edited replies a reflection showed with their topics, to turn an edit into a fact.
-- AlterTable
ALTER TABLE "Reflections" ADD COLUMN     "edits" JSONB NOT NULL DEFAULT '[]';

