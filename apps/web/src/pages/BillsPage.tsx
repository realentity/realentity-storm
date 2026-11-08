import { type BillView, type BillsView } from "@realentity/storm-shared";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";

const DAY_MS = 24 * 60 * 60 * 1000;

/** M23: the bills read from email, by month; marked paid by hand (Storm pays nothing). */
export function BillsPage() {
  const bills = useLoad(() => api.bills.list(), []);
  if (!bills.data) return bills.error ? <ErrorAlert error={bills.error} /> : <Loading />;
  return (
    <>
      <PageHeader title="Bills" pretitle="From email, the last twelve months" />
      {bills.data.bills.length === 0 ? (
        <Empty>No bills yet. The Bills pipeline (pipelines/bills.yaml) reads them from email, PDFs too.</Empty>
      ) : (
        <Months view={bills.data} onChanged={bills.reload} />
      )}
    </>
  );
}

function Months({ view, onChanged }: { view: BillsView; onChanged: () => void }) {
  const months = [...new Set(view.bills.map((b) => b.month))];
  return (
    <div className="d-flex flex-column gap-3">
      {months.map((month) => (
        <div className="card" key={month}>
          <div className="card-header">
            <h3 className="card-title">{monthName(month)}</h3>
            <div className="card-actions text-secondary small">
              {view.totals
                .filter((t) => t.month === month)
                .map((t) => `${money(t.amount, t.currency)}${t.unpaid > 0 ? `, ${money(t.unpaid, t.currency)} unpaid` : ""}`)
                .join(" · ")}
            </div>
          </div>
          <div className="table-responsive">
            <table className="table table-vcenter card-table">
              <thead>
                <tr>
                  <th>Issuer</th>
                  <th className="text-end">Amount</th>
                  <th>Due</th>
                  <th>Reference</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {view.bills
                  .filter((b) => b.month === month)
                  .map((bill) => (
                    <BillRow key={bill.billId} bill={bill} onChanged={onChanged} />
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function BillRow({ bill, onChanged }: { bill: BillView; onChanged: () => void }) {
  const action = useAction();
  const toggle = async () => {
    if (await action.run(() => api.bills.paid(bill.billId, !bill.paidAt))) onChanged();
  };
  return (
    <tr data-testid="bill">
      <td>
        <div>{bill.issuer}</div>
        <div className="small text-secondary text-truncate" style={{ maxWidth: "24rem" }} title={bill.subject}>
          {bill.subject}
        </div>
        <ErrorAlert error={action.error} />
      </td>
      <td className="text-end text-nowrap">{money(bill.amount, bill.currency)}</td>
      <td className="text-nowrap">
        {bill.dueDate ?? "—"} <Due bill={bill} />
      </td>
      <td className="text-secondary">{bill.reference ?? ""}</td>
      <td className="text-end">
        <button type="button" className={`btn btn-sm ${bill.paidAt ? "btn-success" : "btn-outline-secondary"}`} disabled={action.busy} onClick={() => void toggle()}>
          {bill.paidAt ? "Paid" : "Mark paid"}
        </button>
      </td>
    </tr>
  );
}

function Due({ bill }: { bill: BillView }) {
  if (bill.paidAt || !bill.dueDate) return null;
  const days = Math.ceil((new Date(`${bill.dueDate}T23:59:59`).getTime() - Date.now()) / DAY_MS);
  if (days < 0) return <span className="badge bg-red-lt">overdue</span>;
  if (days <= 3) return <span className="badge bg-yellow-lt">{days === 0 ? "today" : `in ${days} d`}</span>;
  return null;
}

function money(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

function monthName(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
