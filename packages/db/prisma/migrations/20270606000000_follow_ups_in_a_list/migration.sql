-- M71-T5: email.awaiting remembers nothing. The emails it proposed a follow-up for (FollowUps) go into the list the
-- Email follow-ups pipeline keeps (examples/pipelines/email-follow-ups.yaml: data.save into "follow-ups", by
-- message.messageId), so none is proposed again; then the table goes.
INSERT INTO "DataRecords" ("dataRecordId", "userId", "collection", "key", "value", "firstSeenAt", "lastSeenAt")
SELECT gen_random_uuid(), f."userId", 'follow-ups', f."messageId",
       jsonb_build_object('message', jsonb_build_object('messageId', f."messageId"), 'threadId', f."threadId", 'to', f."to", 'subject', f."subject"),
       f."dateCreated", f."dateCreated"
FROM "FollowUps" f
ON CONFLICT ("userId", "collection", "key") DO NOTHING;

DROP TABLE "FollowUps";
