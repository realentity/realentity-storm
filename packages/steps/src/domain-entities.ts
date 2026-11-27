import { type DataType } from "@realentity/storm-shared";
import { type EntityContract } from "./catalog";

/**
 * What a type lacks for a step that writes entities of its own (M33): its key, a field of the kind written, a state it
 * sets. Empty: the type fits.
 */
export function contractProblems(type: DataType, contract: EntityContract): string[] {
  const problems: string[] = [];
  if (type.key !== contract.key) problems.push(`its key must be ${contract.key}`);
  if (contract.mine && !type.mine) problems.push("it must be a type of mine (mine: true)");
  if (!contract.mine && type.mine) problems.push("it can't be a type of mine");
  for (const [name, kind] of Object.entries(contract.fields)) {
    const field = type.fields[name];
    if (!field) problems.push(`${name} (${kind}) is missing`);
    else if (field.type !== kind) problems.push(`${name} must be ${kind}, not ${field.type}`);
    else if (field.mine && !contract.mine) problems.push(`${name} can't be mine`);
  }
  for (const state of contract.states ?? []) {
    if (!type.stages?.states.includes(state)) problems.push(`its stages need the state "${state}"`);
  }
  return problems;
}
