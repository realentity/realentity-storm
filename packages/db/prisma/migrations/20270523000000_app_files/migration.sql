-- M46: files and images of entities' fields, uploaded on an App's forms (docs/capabilities.md, Apps).
-- CreateTable
CREATE TABLE "AppFiles" (
    "appFileId" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "key" TEXT,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "path" TEXT NOT NULL,
    "thumbPath" TEXT,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppFiles_pkey" PRIMARY KEY ("appFileId")
);

-- CreateIndex
CREATE INDEX "AppFiles_appId_type_key_idx" ON "AppFiles"("appId", "type", "key");

-- AddForeignKey
ALTER TABLE "AppFiles" ADD CONSTRAINT "AppFiles_appId_fkey" FOREIGN KEY ("appId") REFERENCES "Apps"("appId") ON DELETE CASCADE ON UPDATE CASCADE;

