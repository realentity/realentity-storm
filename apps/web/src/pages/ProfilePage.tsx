import { DOCUMENT_NAME_PATTERN, type DocumentView } from "@realentity/storm-shared";
import { IconDownload, IconTrash, IconUpload } from "@tabler/icons-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "react-toastify";
import { FactsCard } from "../components/FactsCard";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";

/**
 * What application forms are filled from (M10, M15): my profile (browser.mapForm proposes every value from it, and
 * nothing it doesn't state), my facts (answers I gave or approved) and my documents (a pipeline attaches my CV by
 * name; at the gate I can attach others).
 */
export function ProfilePage() {
  return (
    <>
      <PageHeader title="Profile" pretitle="For application forms" />
      <div className="row g-3">
        <div className="col-lg-6">
          <About />
        </div>
        <div className="col-lg-6 d-flex flex-column gap-3">
          <FactsCard />
          <Documents />
        </div>
      </div>
    </>
  );
}

function About() {
  const settings = useLoad(() => api.settings.get(), []);
  const [text, setText] = useState("");
  useEffect(() => setText(settings.data?.profile ?? ""), [settings.data?.profile]);
  const action = useAction();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await action.run(() => api.settings.update({ profile: text }));
    if (saved) toast.success("Profile saved");
  };
  return (
    <form className="card" onSubmit={(e) => void save(e)}>
      <div className="card-header">
        <h3 className="card-title">About me</h3>
      </div>
      <div className="card-body">
        <ErrorAlert error={settings.error ?? action.error} />
        <textarea
          className="form-control"
          rows={14}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="About me"
          placeholder={"Name: …\nEmail: …\nPhone: …\nLinkedIn: …\nLives in: Sofia, Bulgaria (EU citizen)\nNotice period: 1 month\nSalary expectation: …\nOpen to: remote, hybrid in Sofia"}
        />
        <div className="form-hint">
          Forms are filled only from this and the posting: a question it doesn't answer stays empty for me to fill at the gate.
        </div>
      </div>
      <div className="card-footer text-end">
        <button type="submit" className="btn btn-primary" disabled={action.busy || !settings.data}>
          Save
        </button>
      </div>
    </form>
  );
}

function Documents() {
  const documents = useLoad(() => api.documents.list(), []);
  const [name, setName] = useState("cv-main");
  const [file, setFile] = useState<File | null>(null);
  const upload = useAction();
  const remove = useAction();
  const nameOk = DOCUMENT_NAME_PATTERN.test(name);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    const saved = await upload.run(() => api.documents.upload(name, file));
    if (!saved) return;
    toast.success(`Saved ${saved.name}`);
    setFile(null);
    (event.target as HTMLFormElement).reset();
    documents.reload();
  };
  const drop = async (document: DocumentView) => {
    const done = await remove.run(async () => {
      await api.documents.remove(document.name);
      return true;
    });
    if (done) documents.reload();
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Documents</h3>
      </div>
      <div className="card-body">
        <ErrorAlert error={documents.error ?? upload.error ?? remove.error} />
        <form className="row g-2 mb-3" onSubmit={(e) => void submit(e)}>
          <div className="col-sm-4">
            <input className={`form-control ${nameOk ? "" : "is-invalid"}`} value={name} onChange={(e) => setName(e.target.value.trim())} aria-label="Document name" />
          </div>
          <div className="col-sm-5">
            <input type="file" className="form-control" accept=".pdf,.docx,.odt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="File" />
          </div>
          <div className="col-sm-3">
            <button type="submit" className="btn btn-primary w-100" disabled={!file || !nameOk || upload.busy}>
              <IconUpload size={16} className="me-1" />
              Upload
            </button>
          </div>
          <div className="form-hint">
            PDF, DOCX or ODT. A pipeline attaches one by its name (<code>cv: cv-main</code>); the same name again replaces it, and
            applications approved before keep the file they had.
          </div>
        </form>
        {!documents.data && documents.loading && <Loading />}
        {documents.data?.length === 0 && <Empty>No documents yet. Upload your CV as cv-main.</Empty>}
        {documents.data && documents.data.length > 0 && (
          <div className="list-group" data-testid="documents">
            {documents.data.map((d) => (
              <div key={d.documentId} className="list-group-item d-flex align-items-center gap-2">
                <div className="flex-fill overflow-hidden">
                  <code>{d.name}</code> <span className="text-truncate">{d.filename}</span>
                  <div className="small text-secondary">
                    {Math.ceil(d.size / 1024)} KB · {formatDateTime(d.dateCreated)}
                  </div>
                </div>
                <a className="btn btn-icon" href={api.documents.fileUrl(d.documentId)} title="Download">
                  <IconDownload size={16} />
                </a>
                <button type="button" className="btn btn-icon btn-ghost-danger" title="Remove" disabled={remove.busy} onClick={() => void drop(d)}>
                  <IconTrash size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
