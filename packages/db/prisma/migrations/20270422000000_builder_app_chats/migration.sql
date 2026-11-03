-- M34: a builder chat about an App.
ALTER TABLE "BuilderChats" ADD COLUMN "appId" UUID;
ALTER TABLE "BuilderChats" ADD CONSTRAINT "BuilderChats_appId_fkey" FOREIGN KEY ("appId") REFERENCES "Apps"("appId") ON DELETE SET NULL ON UPDATE CASCADE;
