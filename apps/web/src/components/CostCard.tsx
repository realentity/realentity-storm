import { type PipelineCostView } from "@realentity/storm-shared";
import { formatUsd } from "../lib/format";

/** A pipeline's LLM cost (M17-T3): its last 30 days, per run, and per month on its schedule. */
export function CostCard({ cost }: { cost: PipelineCostView }) {
  return (
    <div className="card" data-testid="pipeline-cost">
      <div className="card-header">
        <h3 className="card-title">LLM cost</h3>
        <div className="card-actions small text-secondary">last {cost.days} days</div>
      </div>
      <div className="card-body">
        {cost.runs === 0 ? (
          <div className="text-secondary">No runs in the last {cost.days} days.</div>
        ) : (
          <div className="datagrid">
            <div className="datagrid-item">
              <div className="datagrid-title">Spent</div>
              <div className="datagrid-content">{formatUsd(cost.totalUsd)}</div>
            </div>
            <div className="datagrid-item">
              <div className="datagrid-title">Runs</div>
              <div className="datagrid-content">
                {cost.runs}
                {cost.dryRuns > 0 && <span className="text-secondary small"> ({cost.dryRuns} dry)</span>}
              </div>
            </div>
            <div className="datagrid-item">
              <div className="datagrid-title">Per run</div>
              <div className="datagrid-content">{cost.perRunUsd === null ? "—" : formatUsd(cost.perRunUsd)}</div>
            </div>
            {cost.perMonthUsd !== null && (
              <div className="datagrid-item">
                <div className="datagrid-title">Per month on its schedule</div>
                <div className="datagrid-content" data-testid="cost-per-month">
                  ≈ {formatUsd(cost.perMonthUsd)} <span className="text-secondary small">({cost.runsPerMonth} runs)</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
