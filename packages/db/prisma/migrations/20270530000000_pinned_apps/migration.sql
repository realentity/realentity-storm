-- An App pinned to the sidebar: a square there, first in the Start menu.
ALTER TABLE "Apps" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
