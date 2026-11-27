-- M71-T3: the Prices and Bills Apps on generic steps (examples/apps/prices.yaml, bills.yaml).

-- A Product's shop lines ("https://shop/p/7 | size: M, color: Black", a line each) become Shops of mine: its
-- product, its page and its variant, named "<product> · <host>[, <variant>]" (a number after a name twice). The
-- variant is written as the old step wrote it ("size: M, color: Black"), so each Offer keeps its key and its price
-- history. A line that isn't an address is left out, as the old step did. Each App's Products and Shops are its own.
INSERT INTO "DataEntities" ("dataEntityId", "appId", "type", "key", "value", "mine", "firstSeenAt", "lastSeenAt")
SELECT gen_random_uuid(), s."appId", 'Shop', s.name, jsonb_build_object('name', s.name),
       jsonb_strip_nulls(jsonb_build_object('product', s.product, 'url', s.url, 'variant', NULLIF(s.variant, ''))), now(), now()
FROM (
  SELECT l."appId", l.product, l.url, l.variant,
         l.product || ' · ' || l.host || COALESCE(', ' || NULLIF(l.variant, ''), '') ||
           CASE WHEN count(*) OVER (PARTITION BY l."appId", l.product, l.host, l.variant) > 1
                THEN ' (' || row_number() OVER (PARTITION BY l."appId", l.product, l.host, l.variant ORDER BY l.url) || ')'
                ELSE '' END AS name
  FROM (
    SELECT e."appId", e."key" AS product,
           -- As the old step's key had it (a URL's href): the scheme and host in lower case, a bare host ending in "/".
           lower(substring(btrim(split_part(line, '|', 1)) FROM '^https?://[^/?#]+')) ||
             COALESCE(NULLIF(substring(btrim(split_part(line, '|', 1)) FROM '^https?://[^/?#]+(.*)$'), ''), '/') AS url,
           regexp_replace(regexp_replace(btrim(split_part(line, '|', 2)), '\s*:\s*', ': ', 'g'), '\s*,\s*', ', ', 'g') AS variant,
           lower(substring(btrim(split_part(line, '|', 1)) FROM '^https?://([^/:?#]+)')) AS host
    FROM "DataEntities" e,
         jsonb_array_elements_text(CASE
           WHEN jsonb_typeof(e."mine" -> 'shops') = 'array' THEN e."mine" -> 'shops'
           WHEN jsonb_typeof(e."value" -> 'shops') = 'array' THEN e."value" -> 'shops'
           ELSE '[]'::jsonb END) AS line
    WHERE e."type" = 'Product' AND e."removedAt" IS NULL
  ) l
  WHERE l.host IS NOT NULL
) s
ON CONFLICT ("appId", "type", "key") DO NOTHING;

UPDATE "DataEntities" SET "mine" = "mine" - 'shops', "value" = "value" - 'shops'
WHERE "type" = 'Product' AND ("mine" ? 'shops' OR "value" ? 'shops');

-- The amounts the Bills App compares a new bill with (data.history in bill-amounts, by the sender's domain): the
-- last seven of each sender's Bills so far, as the old step read them from the Bills themselves.
INSERT INTO "DataPoints" ("dataPointId", "userId", "collection", "key", "value", "at")
SELECT gen_random_uuid(), b."userId", 'bill-amounts', b.sender, b.amount, b.seen
FROM (
  SELECT a."userId", e."value" ->> 'issuerKey' AS sender, (e."value" ->> 'amount')::double precision AS amount, e."firstSeenAt" AS seen,
         row_number() OVER (PARTITION BY e."appId", e."value" ->> 'issuerKey' ORDER BY e."value" ->> 'period' DESC NULLS LAST, e."firstSeenAt" DESC) AS n
  FROM "DataEntities" e JOIN "Apps" a ON a."appId" = e."appId"
  WHERE e."type" = 'Bill' AND e."value" ? 'issuerKey' AND jsonb_typeof(e."value" -> 'amount') = 'number'
) b
WHERE b.n <= 7
  AND NOT EXISTS (SELECT 1 FROM "DataPoints" p WHERE p."userId" = b."userId" AND p."collection" = 'bill-amounts');
