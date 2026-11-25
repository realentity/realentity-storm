-- M60: local models switched on in Settings (off by default), and the local model of every task without its own.
ALTER TABLE "UserSettings" ADD COLUMN "localModels" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserSettings" ADD COLUMN "localModel" TEXT;
