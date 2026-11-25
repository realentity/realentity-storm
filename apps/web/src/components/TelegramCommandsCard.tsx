import { IconBrandTelegram } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { api } from "../lib/endpoints";
import { useLoad } from "../lib/use-load";
import { ErrorAlert, Loading } from "./ui";

/**
 * M49: the Storm bot's commands in one place: Storm's own, then each pipeline's with the pipeline it starts, those that
 * are off too (they answer once on). Read again whenever the page is opened.
 */
export function TelegramCommandsCard() {
  const view = useLoad(() => api.telegram.commands(), []);
  const own = view.data?.commands.filter((c) => c.pipeline === null) ?? [];
  const theirs = view.data?.commands.filter((c) => c.pipeline !== null) ?? [];
  return (
    <div className="card" data-testid="telegram-commands">
      <div className="card-header">
        <h3 className="card-title d-flex align-items-center gap-2">
          <IconBrandTelegram size={18} />
          Telegram commands
        </h3>
      </div>
      <ErrorAlert error={view.error} />
      {!view.data && view.loading && <Loading />}
      {view.data && (
        <>
          {!view.data.configured && (
            <div className="card-body border-bottom small text-secondary" data-testid="telegram-not-configured">
              The Storm bot isn't set up or is off (above): no command answers yet.
            </div>
          )}
          <div className="list-group list-group-flush">
            <div className="list-group-item small text-uppercase text-secondary py-1">Your pipelines'</div>
            {theirs.length === 0 && (
              <div className="list-group-item small text-secondary">
                None yet: a pipeline gets one with <code>trigger: {"{ on: telegram.command, command: task }"}</code>.
              </div>
            )}
            {theirs.map((c) => (
              <div key={c.pipeline!.pipelineId} className="list-group-item" data-testid="telegram-command" data-answers={c.answers}>
                <div className="d-flex align-items-center gap-2">
                  <code className={c.answers ? undefined : "text-secondary"}>/{c.command}</code>
                  <Link to={`/pipelines/${c.pipeline!.pipelineId}`} className="small">
                    {c.pipeline!.name}
                  </Link>
                  {!c.answers && <span className="badge bg-yellow-lt ms-auto">off</span>}
                </div>
                <div className="small text-secondary">{c.description}</div>
                {!c.answers && (
                  <div className="small text-secondary" data-testid="telegram-command-off">
                    {c.takenBy
                      ? `"${c.takenBy}" has /${c.command} now: switch that one off first, or give this one another command.`
                      : "Answers once the pipeline is switched on."}
                  </div>
                )}
              </div>
            ))}
            <div className="list-group-item small text-uppercase text-secondary py-1">Storm's own</div>
            {own.map((c) => (
              <div key={c.command} className="list-group-item py-2" data-testid="telegram-command" data-answers={c.answers}>
                <code>/{c.command}</code> <span className="small text-secondary ms-1">{c.description}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
