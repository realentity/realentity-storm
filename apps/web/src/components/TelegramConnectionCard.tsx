import { type TelegramConnectionRequest, type TelegramConnectionView, type TelegramTestView } from "@realentity/storm-shared";
import { IconBrandTelegram, IconPlayerPlay, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";
import { validCode } from "../lib/code";
import { CodeField, CopyButton } from "./CodeField";
import { ErrorAlert, Loading, Modal } from "./ui";

/**
 * M63: the Storm bot (Settings → Telegram, docs/telegram.md): its token (write-only), your chat id, and the webhook
 * secret Telegram sends with each update: your gateway's, pasted, or one Storm generates and shows once. Storm keeps only
 * the secret's hash. A token, a chat or a secret is saved with the authenticator code.
 */
export function TelegramConnectionCard({ hooksPublicUrl, onChanged }: { hooksPublicUrl: string | null; onChanged: () => void }) {
  const connection = useLoad(() => api.telegram.connection.get(), []);
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [test, setTest] = useState<TelegramTestView | "running" | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const changed = () => {
    connection.reload();
    onChanged();
  };
  const toggle = async (enabled: boolean) => {
    if (await action.run(() => api.telegram.connection.save({ enabled }))) {
      toast.success(`The Storm bot is ${enabled ? "on" : "off"}`);
      changed();
    }
  };
  const runTest = async () => {
    setTest("running");
    try {
      setTest(await api.telegram.connection.test());
    } catch (error) {
      setTest({ ok: false, bot: null, error: (error as Error).message });
    }
  };
  const view = connection.data;

  return (
    <div className="card" data-testid="telegram-connection">
      <div className="card-header">
        <h3 className="card-title">
          <IconBrandTelegram size={18} className="me-2" />
          The Storm bot
        </h3>
        <div className="card-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing(true)} data-testid="telegram-edit">
            {view?.configured ? "Change" : "Set up"}
          </button>
        </div>
      </div>
      <ErrorAlert error={action.error ?? connection.error} />
      {!view ? (
        <Loading />
      ) : !view.configured ? (
        <div className="card-body text-secondary" data-testid="telegram-not-set-up">
          Not set up: a bot of your own from @BotFather, and your Telegram user id (your private chat with the bot). Until then
          nothing is sent and no command answers.
        </div>
      ) : (
        <div className="card-body">
          <div className="d-flex align-items-center gap-3">
            <label className="form-check form-switch m-0">
              <input type="checkbox" className="form-check-input" checked={view.enabled} disabled={action.busy} onChange={(e) => void toggle(e.target.checked)} aria-label="Storm bot on" />
            </label>
            <div className="flex-fill small">
              <div>
                Token {view.tokenHint ?? "set"} · chat {view.chatId}
              </div>
              <div className="text-secondary" data-testid="telegram-webhook">
                {view.webhookSecretSet ? "Webhook secret set" : "No webhook secret: commands and buttons don't reach Storm"}
                {view.webhookUrl ? ` · registered at ${view.webhookUrl}` : ""}
              </div>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => void runTest()} disabled={test === "running"} data-testid="telegram-test">
              <IconPlayerPlay size={16} className="me-1" />
              Test
            </button>
            <button type="button" className="btn btn-sm btn-ghost-danger" onClick={() => setRemoving(true)} aria-label="Remove the bot">
              <IconTrash size={16} />
            </button>
          </div>
          {test && test !== "running" && (
            <div className={`small mt-2 ${test.ok ? "text-green" : "text-red"}`} data-testid="telegram-test-result">
              {test.ok ? `${test.bot ?? "The bot"} works: a test message went to your chat.` : `${test.bot ? `${test.bot}: ` : ""}${test.error}`}
            </div>
          )}
        </div>
      )}
      {editing && (
        <TelegramForm
          view={view ?? null}
          hooksPublicUrl={hooksPublicUrl}
          onClose={() => setEditing(false)}
          onSaved={(secret) => {
            setEditing(false);
            if (secret) setShown(secret);
            changed();
          }}
        />
      )}
      {shown && (
        <Modal title="The webhook secret" onClose={() => setShown(null)} footer={<button type="button" className="btn btn-primary" onClick={() => setShown(null)}>Done</button>}>
          <p>Shown this once: Storm keeps only its hash. A gateway in front of Storm that checks it needs it too.</p>
          <div className="d-flex gap-1 align-items-start">
            <code className="text-break flex-fill" data-testid="telegram-secret">
              {shown}
            </code>
            <CopyButton text={shown} />
          </div>
        </Modal>
      )}
      {removing && (
        <Modal
          title="Remove the Storm bot?"
          onClose={() => setRemoving(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRemoving(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() =>
                  void action.run(() => api.telegram.connection.remove().then(() => true)).then((done) => {
                    setRemoving(false);
                    if (!done) return;
                    toast.success("The Storm bot is removed");
                    changed();
                  })
                }
              >
                Remove
              </button>
            </>
          }
        >
          Its token and the webhook secret are deleted: nothing is sent to Telegram, and /hooks/telegram answers nothing.
        </Modal>
      )}
    </div>
  );
}

type Webhook = "keep" | "paste" | "generate";

/** Setting the bot up, or changing it; the webhook secret pasted or generated, and registered with Telegram if asked. */
function TelegramForm({
  view,
  hooksPublicUrl,
  onClose,
  onSaved,
}: {
  view: TelegramConnectionView | null;
  hooksPublicUrl: string | null;
  onClose: () => void;
  onSaved: (generatedSecret: string | undefined) => void;
}) {
  const action = useAction();
  const first = !view?.configured;
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState(view?.chatId ?? "");
  const [webhook, setWebhook] = useState<Webhook>(view?.webhookSecretSet ? "keep" : "generate");
  const [pasted, setPasted] = useState("");
  const [register, setRegister] = useState(false);
  const [url, setUrl] = useState(view?.webhookUrl ?? (hooksPublicUrl ? `${hooksPublicUrl}/telegram` : ""));
  const [code, setCode] = useState("");
  const chatChanged = chatId.trim() !== (view?.chatId ?? "");
  const body: TelegramConnectionRequest = {
    ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
    ...(chatChanged ? { chatId: chatId.trim() } : {}),
    ...(webhook === "generate" ? { webhook: { secret: "generate" } } : webhook === "paste" ? { webhook: { secret: "paste", value: pasted.trim() } } : {}),
    ...(register && webhook !== "keep" ? { register: url.trim() } : {}),
  };
  const needsCode = body.botToken !== undefined || body.chatId !== undefined || body.webhook !== undefined;
  const ready = (!first || (botToken.trim() !== "" && chatId.trim() !== "")) && (!needsCode || validCode(code)) && (webhook !== "paste" || pasted.trim().length >= 32);
  const save = async () => {
    const saved = await action.run(() => api.telegram.connection.save({ ...body, ...(needsCode ? { code } : {}) }));
    if (!saved) return;
    if (saved.registered && !saved.registered.ok) toast.warning(`Saved, but Telegram didn't take the webhook: ${saved.registered.error}`);
    else toast.success(saved.registered?.ok ? "Saved, and the webhook is registered with Telegram" : "The Storm bot is saved");
    onSaved(saved.webhookSecret);
  };
  return (
    <Modal
      title={first ? "Set up the Storm bot" : "Change the Storm bot"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={action.busy || !ready} onClick={() => void save()} data-testid="telegram-save">
            Save
          </button>
        </>
      }
    >
      <ErrorAlert error={action.error} />
      <label className="form-label w-100">
        Bot token, from @BotFather
        <input
          type="password"
          className="form-control"
          autoComplete="off"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder={view?.tokenHint ? `set (${view.tokenHint}); type a new one to replace it` : "123456:ABC…"}
          data-testid="telegram-token"
        />
      </label>
      <label className="form-label w-100">
        Your chat id
        <input className="form-control" inputMode="numeric" value={chatId} onChange={(e) => setChatId(e.target.value)} data-testid="telegram-chat" />
        <span className="form-hint">Your Telegram user id: messages go to your private chat with the bot only, and commands are taken only from it.</span>
      </label>
      <div className="mb-2 form-label">Webhook secret</div>
      <div className="form-selectgroup mb-2">
        {view?.webhookSecretSet && (
          <label className="form-selectgroup-item">
            <input type="radio" className="form-selectgroup-input" checked={webhook === "keep"} onChange={() => setWebhook("keep")} />
            <span className="form-selectgroup-label">Keep</span>
          </label>
        )}
        <label className="form-selectgroup-item">
          <input type="radio" className="form-selectgroup-input" checked={webhook === "paste"} onChange={() => setWebhook("paste")} data-testid="telegram-webhook-paste" />
          <span className="form-selectgroup-label">Paste</span>
        </label>
        <label className="form-selectgroup-item">
          <input type="radio" className="form-selectgroup-input" checked={webhook === "generate"} onChange={() => setWebhook("generate")} data-testid="telegram-webhook-generate" />
          <span className="form-selectgroup-label">Generate</span>
        </label>
      </div>
      {webhook === "paste" && (
        <input
          type="password"
          className="form-control mb-1"
          autoComplete="off"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="the secret_token the webhook was registered with"
          data-testid="telegram-webhook-secret"
        />
      )}
      <div className="form-hint mb-3">
        Telegram sends it with every update; /hooks/telegram takes only updates that carry it. Paste the one your gateway checks,
        or generate one (shown once).
      </div>
      {webhook !== "keep" && (
        <div className="mb-3">
          <label className="form-check">
            <input type="checkbox" className="form-check-input" checked={register} onChange={(e) => setRegister(e.target.checked)} data-testid="telegram-register" />
            <span className="form-check-label">Register the webhook with Telegram (setWebhook)</span>
          </label>
          {register && (
            <input className="form-control" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/hooks/telegram" data-testid="telegram-register-url" />
          )}
          <div className="form-hint">Where Telegram posts the updates: Storm's /hooks/telegram, or your gateway's address for the bot.</div>
        </div>
      )}
      {needsCode && <CodeField value={code} onChange={setCode} hint="Asked again for a token, a chat or a secret: they decide where your messages go and whose commands are taken." testId="telegram-code" />}
    </Modal>
  );
}
