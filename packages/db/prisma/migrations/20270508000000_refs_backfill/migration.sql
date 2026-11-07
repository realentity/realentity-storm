-- M39-T3: the versions saved before M39 get their refs too, so renaming an App or a pipeline breaks none of them: a
-- pipeline version its App's id and the ids of the pipelines its run.finished trigger and flow.later steps name; an App
-- version the ids of the pipelines its buttons run. Names are unique by now (the migration before this one).
UPDATE "PipelineVersions" v
SET definition = v.definition || jsonb_build_object('refs', jsonb_strip_nulls(jsonb_build_object(
  'appId', (SELECT a."appId" FROM "Apps" a WHERE a."userId" = p."userId" AND a.name = v.definition->>'app'),
  'pipelines', COALESCE((
    SELECT jsonb_object_agg(t.name, t."pipelineId")
    FROM "Pipelines" t
    WHERE t."userId" = p."userId" AND t."currentVersionId" IS NOT NULL AND t.name IN (
      SELECT v.definition->'trigger'->>'pipeline' WHERE v.definition->'trigger'->>'on' = 'run.finished'
      UNION
      SELECT s->'with'->>'pipeline' FROM jsonb_array_elements(COALESCE(v.definition->'steps', '[]'::jsonb)) s WHERE s->>'type' = 'flow.later'
    )
  ), '{}'::jsonb)
)))
FROM "Pipelines" p
WHERE p."pipelineId" = v."pipelineId" AND NOT (v.definition ? 'refs');

UPDATE "AppVersions" av
SET refs = jsonb_build_object('pipelines', COALESCE((
  SELECT jsonb_object_agg(t.name, t."pipelineId")
  FROM "Pipelines" t
  JOIN "Apps" a ON a."appId" = av."appId"
  WHERE t."userId" = a."userId" AND t."currentVersionId" IS NOT NULL AND t.name IN (
    SELECT action->>'run'
    FROM jsonb_array_elements(COALESCE(av.definition->'pages', '[]'::jsonb)) page,
         jsonb_array_elements(COALESCE(page->'actions', '[]'::jsonb)) action
  )
), '{}'::jsonb))
WHERE av.refs IS NULL;
