import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { LoadingSkeleton } from '@/components/common';
import {
  cancelTelegramLogin,
  confirmTelegramLogin,
  disconnectTelegram,
  getTelegramReaderStatus,
  listTelegramDialogs,
  setTelegramChannels,
  startTelegramLogin,
  type TelegramDialog,
  type TelegramReaderStatus,
} from '@/services/telegramReader';
import {
  MAX_CHANNELS,
  cleanCode,
  errorMessage,
  sameSelection,
  stepFromStatus,
  toStartPayload,
  toggleChannel,
  validateCode,
  validateCredentials,
  type ConnectStep,
  type CredentialsForm,
} from './telegram-connect';

const input =
  'rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none';
const primary =
  'rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const subtle = 'text-[11px] text-gray-500 hover:text-gray-300 transition-colors';

const LISTENER_LABEL: Record<string, string> = {
  off: 'Reader switched off (TELEGRAM_READER=off)',
  idle: 'Idle',
  connecting: 'Connecting…',
  listening: 'Listening',
  backoff: 'Reconnecting…',
  revoked: 'Session revoked — reconnect',
};

/**
 * Owner-only "Telegram signals" settings: connect the owner's own Telegram account (MTProto,
 * not a bot), pick up to 10 channels to read, disconnect. The api hash, phone and login code
 * are only sent, never shown back.
 */
export function TelegramSignalsSection() {
  const [status, setStatus] = useState<TelegramReaderStatus | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [step, setStep] = useState<ConnectStep>('credentials');
  const [form, setForm] = useState<CredentialsForm>({ apiId: '', apiHash: '', phone: '' });
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialogs, setDialogs] = useState<TelegramDialog[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const s = await getTelegramReaderStatus();
      setStatus(s);
      setStep(stepFromStatus(s));
      setSelected(s.channels.map((c) => c.tgChannelId));
    } catch (err) {
      if ((err as { response?: { status?: number } }).response?.status === 403) setForbidden(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (forbidden) return <p className="text-xs text-gray-500">Only the owner account can connect Telegram.</p>;
  if (!status) return <LoadingSkeleton variant="card" count={1} className="h-24" />;

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(errorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const onStart = () => {
    const bad = validateCredentials(form);
    if (bad) return toast.error(bad);
    void run(async () => {
      const r = await startTelegramLogin(toStartPayload(form));
      setStep(r.stage);
      toast.success('Telegram sent a login code to your Telegram app.');
    }, 'Could not start the Telegram login.');
  };

  const onConfirm = () => {
    if (step === 'code') {
      const bad = validateCode(code);
      if (bad) return toast.error(bad);
    } else if (!password) {
      return toast.error('Enter your two-step verification password.');
    }
    void run(async () => {
      const r = await confirmTelegramLogin(step === 'code' ? { code: cleanCode(code) } : { password });
      setStep(r.stage);
      if (r.stage === 'connected') {
        setForm({ apiId: '', apiHash: '', phone: '' });
        setCode('');
        setPassword('');
        toast.success('Telegram connected.');
        await refresh();
      }
    }, 'Telegram did not accept that.');
  };

  const onCancel = () =>
    void run(async () => {
      await cancelTelegramLogin();
      setCode('');
      setPassword('');
      setStep('credentials');
    }, 'Could not cancel.');

  const onDisconnect = () => {
    if (!window.confirm('Disconnect Telegram? The reader stops and the saved session is deleted.')) return;
    void run(async () => {
      await disconnectTelegram();
      setDialogs(null);
      toast.success('Telegram disconnected.');
      await refresh();
    }, 'Could not disconnect.');
  };

  const onLoadDialogs = () =>
    void run(async () => {
      setDialogs(await listTelegramDialogs());
    }, 'Could not load your Telegram chats.');

  const savedIds = status.channels.map((c) => c.tgChannelId);
  const onSaveChannels = () =>
    void run(async () => {
      await setTelegramChannels(selected);
      toast.success('Channels saved.');
      await refresh();
    }, 'Could not save the channels.');

  if (step !== 'connected') {
    return (
      <div className="space-y-3">
        {step === 'credentials' && (
          <>
            <p className="text-[11px] text-gray-500">
              Uses your own Telegram account to read the channels you pick. Get <b>api_id</b> and <b>api_hash</b> at{' '}
              <a className="text-blue-400 underline" href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">
                my.telegram.org/apps
              </a>{' '}
              (log in with your phone, create an app once).
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="api_id">
                <input className={input} inputMode="numeric" autoComplete="off" value={form.apiId}
                  onChange={(e) => setForm({ ...form, apiId: e.target.value })} />
              </Field>
              <Field label="api_hash">
                <input className={input} type="password" autoComplete="off" value={form.apiHash}
                  onChange={(e) => setForm({ ...form, apiHash: e.target.value })} />
              </Field>
              <Field label="Phone (international)">
                <input className={input} type="tel" autoComplete="off" placeholder="+91…" value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </Field>
            </div>
            <button className={primary} disabled={busy} onClick={onStart}>Send login code</button>
          </>
        )}
        {step === 'code' && (
          <>
            <p className="text-[11px] text-gray-500">Enter the code Telegram just sent to your Telegram app.</p>
            <Field label="Login code">
              <input className={input} inputMode="numeric" autoComplete="one-time-code" value={code}
                onChange={(e) => setCode(e.target.value)} />
            </Field>
          </>
        )}
        {step === 'password' && (
          <>
            <p className="text-[11px] text-gray-500">This account has two-step verification. Enter its password.</p>
            <Field label="Two-step verification password">
              <input className={input} type="password" autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </>
        )}
        {step !== 'credentials' && (
          <div className="flex items-center gap-3">
            <button className={primary} disabled={busy} onClick={onConfirm}>Confirm</button>
            <button className={subtle} disabled={busy} onClick={onCancel}>Cancel</button>
          </div>
        )}
      </div>
    );
  }

  const l = status.listener;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
          Connected
        </span>
        <span className="text-sm text-gray-300">{status.session?.phoneMasked}</span>
        <span className="text-[11px] text-gray-500">
          {LISTENER_LABEL[l.state] ?? l.state}
          {l.lastMessageAt ? ` · last message ${new Date(l.lastMessageAt).toLocaleString()}` : ''}
        </span>
        <button
          onClick={onDisconnect}
          disabled={busy}
          className="ml-auto rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors"
        >
          Disconnect
        </button>
      </div>
      {l.lastError && l.state !== 'listening' && <p className="text-[11px] text-amber-400">Last error: {l.lastError}</p>}

      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
            Channels read ({selected.length}/{MAX_CHANNELS})
          </span>
          <button className={subtle} disabled={busy} onClick={onLoadDialogs}>
            {dialogs ? 'Reload chats' : 'Choose channels'}
          </button>
        </div>
        {!dialogs && (
          <ul className="mt-2 space-y-1">
            {status.channels.length === 0 && <li className="text-[11px] text-gray-500">No channels picked yet.</li>}
            {status.channels.map((c) => (
              <li key={c.id} className="text-xs text-gray-300">
                {c.title} {c.username && <span className="text-gray-500">@{c.username}</span>}
              </li>
            ))}
          </ul>
        )}
        {dialogs && (
          <>
            <ul className="mt-2 max-h-72 overflow-y-auto divide-y divide-gray-700/40">
              {dialogs.map((d) => {
                const on = selected.includes(d.tgChannelId);
                const full = !on && selected.length >= MAX_CHANNELS;
                return (
                  <li key={d.tgChannelId} className="flex items-center gap-2 py-1.5">
                    <input type="checkbox" checked={on} disabled={full}
                      onChange={() => setSelected(toggleChannel(selected, d.tgChannelId))} />
                    <span className="text-xs text-gray-200">{d.title}</span>
                    {d.username && <span className="text-[11px] text-gray-500">@{d.username}</span>}
                    <span className="ml-auto text-[11px] text-gray-500">
                      {d.kind}
                      {d.memberCount !== null ? ` · ${d.memberCount.toLocaleString()}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
            <button className={`${primary} mt-2`} disabled={busy || sameSelection(selected, savedIds)} onClick={onSaveChannels}>
              Save channels
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-medium text-gray-400">{label}</label>
      {children}
    </div>
  );
}
