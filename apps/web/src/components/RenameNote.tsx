import { type RenameView } from "@ai-me/shared";
import { IconArrowsExchange } from "@tabler/icons-react";

/** M39-T5: a rename, and what follows it: what refers to it does so by id, so nothing breaks. */
export function RenameNote({ renamed, what }: Readonly<{ renamed: RenameView; what: string }>) {
  const n = renamed.followers.length;
  return (
    <div className="alert alert-info mb-0 d-flex gap-2" data-testid="rename-followers">
      <IconArrowsExchange size={18} className="flex-shrink-0 mt-1" />
      <div>
        Renamed from <strong>{renamed.from}</strong> to <strong>{renamed.to}</strong>.{" "}
        {n === 0
          ? `Nothing refers to it by name.`
          : `${n === 1 ? `1 ${what} follows` : `${n} ${what}s follow`} the new name: ${renamed.followers.join(", ")}.`}
      </div>
    </div>
  );
}
