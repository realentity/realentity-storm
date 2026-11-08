import { type PriceHistoryView, type PricesStatusView, type WatchedProductRequest, type WatchedProductView } from "@realentity/storm-shared";
import { IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { PriceChart } from "../components/PriceChart";
import { Empty, ErrorAlert, Loading, Modal, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";

/** M24: the products price.watch checks, at each shop, with their history. */
export function PricesPage() {
  const products = useLoad(() => api.prices.list(), []);
  const status = useLoad(() => api.prices.status(), []);
  const [editing, setEditing] = useState<WatchedProductView | "new" | null>(null);
  if (!products.data) return products.error ? <ErrorAlert error={products.error} /> : <Loading />;
  return (
    <>
      <PageHeader
        title="Prices"
        pretitle="Watched products"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
            <IconPlus size={16} className="me-1" /> Watch a product
          </button>
        }
      />
      {status.data && <Checker status={status.data} />}
      {products.data.length === 0 ? (
        <Empty>Nothing watched yet. Add a product with its shops' pages; the Prices pipeline (pipelines/prices.yaml) checks them.</Empty>
      ) : (
        <div className="d-flex flex-column gap-3">
          {products.data.map((product) => (
            <ProductCard key={product.watchedProductId} product={product} onEdit={() => setEditing(product)} />
          ))}
        </div>
      )}
      {editing && (
        <ProductForm
          product={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            products.reload();
          }}
        />
      )}
    </>
  );
}

/** Nothing reads these prices without an enabled pipeline with price.watch: say so, and offer the template. */
function Checker({ status }: { status: PricesStatusView }) {
  const action = useAction();
  const navigate = useNavigate();
  if (status.pipelines.some((p) => p.enabled)) return null;
  const create = async () => {
    const pipeline = await action.run(() => api.prices.createPipeline());
    if (pipeline) void navigate(`/pipelines/${pipeline.pipelineId}`);
  };
  const off = status.pipelines[0];
  return (
    <div className="alert alert-warning" data-testid="prices-unchecked">
      <ErrorAlert error={action.error} />
      {off ? (
        <>
          Nothing checks these prices: <Link to={`/pipelines/${off.pipelineId}`}>{off.name}</Link> is off. Turn it on to check them every morning, or
          open it and press Run to check now.
        </>
      ) : (
        <div className="d-flex flex-wrap align-items-center gap-2">
          <span>Nothing checks these prices yet: the Prices pipeline reads every shop each morning and tells you only what's new.</span>
          <button type="button" className="btn btn-sm btn-primary" disabled={action.busy} onClick={() => void create()}>
            Create the Prices pipeline
          </button>
        </div>
      )}
    </div>
  );
}

function ProductCard({ product, onEdit }: { product: WatchedProductView; onEdit: () => void }) {
  const history = useLoad<PriceHistoryView>(() => api.prices.history(product.watchedProductId), [product]);
  const cheapest = product.cheapest;
  return (
    <div className="card" data-testid="watched-product">
      <div className="card-header">
        <div>
          <h3 className="card-title">
            {product.name} {!product.enabled && <span className="badge bg-secondary-lt ms-1">paused</span>}
          </h3>
          <div className="small text-secondary">
            {cheapest ? `Cheapest now: ${money(cheapest.price!, cheapest.currency)} at ${cheapest.shop}` : "No price yet"}
            {product.targetPrice !== null && ` · target ${money(product.targetPrice, product.currency)}`}
          </div>
        </div>
        <div className="card-actions">
          <button type="button" className="btn btn-sm" onClick={onEdit}>
            Edit
          </button>
        </div>
      </div>
      <div className="card-body">
        {history.data ? <PriceChart history={history.data} /> : <ErrorAlert error={history.error} />}
      </div>
      <div className="table-responsive">
        <table className="table table-vcenter card-table">
          <thead>
            <tr>
              <th>Shop</th>
              <th className="text-end">Price</th>
              <th>Stock</th>
              <th>Checked</th>
            </tr>
          </thead>
          <tbody>
            {product.offers.map((offer) => (
              <tr key={offer.watchedOfferId}>
                <td>
                  <a href={offer.url} target="_blank" rel="noreferrer">
                    {offer.shop}
                  </a>
                  {offer.select && <span className="text-secondary small ms-1">({Object.values(offer.select).join(", ")})</span>}
                  {offer.problem && <div className="small text-danger">{offer.problem}</div>}
                </td>
                <td className="text-end text-nowrap">{offer.price === null ? "—" : money(offer.price, offer.currency)}</td>
                <td>{offer.inStock === null ? "—" : offer.inStock ? "in stock" : "sold out"}</td>
                <td className="text-secondary small">{offer.checkedAt ? new Date(offer.checkedAt).toLocaleString("en-GB") : "not yet"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One shop page per line: the address, then optionally the variant as "size=M, color=Black". */
function ProductForm({ product, onClose, onSaved }: { product: WatchedProductView | null; onClose: () => void; onSaved: () => void }) {
  const action = useAction();
  const [name, setName] = useState(product?.name ?? "");
  const [target, setTarget] = useState(product?.targetPrice?.toString() ?? "");
  const [currency, setCurrency] = useState(product?.currency ?? "");
  const [enabled, setEnabled] = useState(product?.enabled ?? true);
  const [offers, setOffers] = useState(
    product?.offers.map((o) => `${o.url}${o.select ? ` ${Object.entries(o.select).map(([k, v]) => `${k}=${v}`).join(", ")}` : ""}`).join("\n") ?? "",
  );

  const save = async () => {
    const body: WatchedProductRequest = {
      name,
      targetPrice: target.trim() ? Number(target) : null,
      currency: currency.trim() ? currency.trim().toUpperCase() : null,
      enabled,
      offers: offers
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseOffer),
    };
    const saved = await action.run(() => (product ? api.prices.update(product.watchedProductId, body) : api.prices.create(body)));
    if (!saved) return;
    toast.success(`${saved.name} saved`);
    onSaved();
  };
  const remove = async () => {
    if (!product || !window.confirm(`Stop watching ${product.name}? Its price history goes too.`)) return;
    const removed = await action.run(async () => {
      await api.prices.remove(product.watchedProductId);
      return true;
    });
    if (removed) onSaved();
  };

  return (
    <Modal
      title={product ? `Edit ${product.name}` : "Watch a product"}
      size="lg"
      onClose={onClose}
      footer={
        <>
          {product && (
            <button type="button" className="btn btn-outline-danger me-auto" disabled={action.busy} onClick={() => void remove()}>
              Stop watching
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={action.busy || !name.trim() || !offers.trim()} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <ErrorAlert error={action.error} />
      <div className="mb-3">
        <label className="form-label">Name</label>
        <input className="form-control" value={name} onChange={(e) => setName(e.target.value)} placeholder="Skogsö jacket, M, black" />
      </div>
      <div className="row g-2 mb-3">
        <div className="col-8">
          <label className="form-label">Target price</label>
          <input type="number" min="0.01" step="0.01" className="form-control" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="none" />
        </div>
        <div className="col-4">
          <label className="form-label">Currency</label>
          <input className="form-control" value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="EUR" maxLength={3} />
        </div>
      </div>
      <div className="mb-3">
        <label className="form-label">Shop pages</label>
        <textarea
          className="form-control font-monospace"
          rows={4}
          value={offers}
          onChange={(e) => setOffers(e.target.value)}
          placeholder={"https://shop-one.example/jacket size=M, color=Black\nhttps://shop-two.example/p/123"}
        />
        <div className="form-hint">One page per line; after the address, the variant in the page's own words (size=M, color=Black).</div>
      </div>
      <label className="form-check form-switch">
        <input className="form-check-input" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="form-check-label">Watching</span>
        <div className="small text-secondary">Off: paused. The Prices pipeline skips it; its shops and price history are kept.</div>
      </label>
    </Modal>
  );
}

function parseOffer(line: string): WatchedProductRequest["offers"][number] {
  const [url = "", ...rest] = line.split(/\s+/);
  const variant = rest.join(" ").trim();
  if (!variant) return { url };
  const select = Object.fromEntries(
    variant
      .split(",")
      .map((pair) => pair.split("=").map((part) => part.trim()))
      .filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== "" && pair[1] !== ""),
  );
  return Object.keys(select).length ? { url, select } : { url };
}

function money(amount: number, currency: string | null): string {
  return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
}
