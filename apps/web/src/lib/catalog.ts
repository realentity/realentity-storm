import { type StepTypeView } from "@ai-me/shared";
import { useEffect, useState } from "react";
import { api } from "./endpoints";

let cached: Promise<StepTypeView[]> | null = null;

/** The step catalog; loaded once per page load (it changes only with a deploy). */
export function useCatalog(): StepTypeView[] {
  const [steps, setSteps] = useState<StepTypeView[]>([]);
  useEffect(() => {
    cached ??= api.steps.list().catch((error: unknown) => {
      cached = null;
      throw error;
    });
    let alive = true;
    cached.then(
      (list) => alive && setSteps(list),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return steps;
}
