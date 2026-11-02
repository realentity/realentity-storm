-- AlterTable
ALTER TABLE "SiteRecipes" ADD COLUMN     "lastItemsAt" TIMESTAMP(3),
ADD COLUMN     "quietToldAt" TIMESTAMP(3);

-- A recipe that worked before counts as having found items then.
UPDATE "SiteRecipes" SET "lastItemsAt" = "lastVerifiedAt";
