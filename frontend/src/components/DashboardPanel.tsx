import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getDashboard, runDashboardRow, saveDashboard, deleteDashboard } from '../lib/dashboardApi';
import { uploadAttachment } from '../lib/upload';
import type {
  ChatDashboard,
  DashboardButtonRow,
  DashboardConfig,
  DashboardRow,
  DashboardSection,
  DashboardStatusRow,
  DashboardTextRow,
} from '../lib/types';

const panelClass =
  'rounded-xl border border-white/10 bg-wizard-panel/80 px-2.5 py-2 text-sm text-wizard-text outline-none transition placeholder:text-wizard-muted/60 focus:border-wizard-green-500 focus:bg-white/[0.07] w-full';

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function textRow(): DashboardTextRow {
  return { kind: 'text', id: uid(), text: '' };
}

function statusRow(): DashboardStatusRow {
  return { kind: 'status', id: uid(), label: 'Status', url: '', jsonPath: null, refreshSec: 30 };
}

function buttonRow(): DashboardButtonRow {
  return { kind: 'button', id: uid(), label: 'Action', method: 'POST', url: '', headers: {}, body: '', confirm: null };
}

function emptyConfig(): DashboardConfig {
  return { sections: [{ id: uid(), title: 'General', rows: [] }] };
}

const METHODS: DashboardButtonRow['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const KIND_LABELS = { text: 'Text', status: 'Status', button: 'Button' } as const;

function now(): string {
  return new Date().toLocaleTimeString();
}

function StatusRowView({ chatId, row }: { chatId: string; row: DashboardStatusRow }) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await runDashboardRow(chatId, row.id);
      if (result.ok) {
        setValue(result.value ?? '(empty)');
        setError(null);
      } else {
        setValue(null);
        setError(result.error ?? 'Unreachable');
      }
      setLastRun(now());
    } catch {
      setValue(null);
      setError('Unreachable');
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  const secs = Math.max(5, row.refreshSec ?? 30);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), secs * 1000);
    return () => clearInterval(timer);
  }, [refresh, secs]);

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{row.label || 'Status'}</p>
        {lastRun && <p className="text-[10px] text-wizard-muted">updated {lastRun} · every {secs}s</p>}
      </div>
      <div className="flex items-center gap-2">
        {error ? (
          <span className="text-right text-xs font-medium text-red-400">{error}</span>
        ) : (
          <span className={`max-w-[16rem] truncate text-right text-sm font-semibold ${value ? 'text-wizard-green-400' : 'text-wizard-muted'}`}>
            {loading ? '…' : value ?? '—'}
          </span>
        )}
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className={`shrink-0 rounded-lg border border-white/10 px-2 py-1 text-xs text-wizard-muted transition hover:border-wizard-green-500/50 hover:text-wizard-green-400 disabled:opacity-50 ${loading ? 'animate-pulse' : ''}`}
          title="Refresh now"
          aria-label="Refresh status"
        >
          ↻
        </button>
      </div>
    </div>
  );
}

function ButtonRowView({ chatId, row }: { chatId: string; row: DashboardButtonRow }) {
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const fire = async () => {
    if (row.confirm && !window.confirm(row.confirm)) return;
    setWorking(true);
    setFeedback(null);
    try {
      const result = await runDashboardRow(chatId, row.id);
      setFeedback(result.ok ? { ok: true, text: `Done (${result.status})` } : { ok: false, text: result.error ?? 'Failed' });
    } catch {
      setFeedback({ ok: false, text: 'Failed' });
    } finally {
      setWorking(false);
      timerRef.current = window.setTimeout(() => setFeedback(null), 6000);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void fire()}
        disabled={working}
        className="w-full rounded-xl border border-wizard-green-500/40 bg-wizard-green-500/15 px-3 py-2 text-sm font-medium text-wizard-green-300 transition hover:bg-wizard-green-500/25 disabled:opacity-50"
      >
        {working ? 'Working…' : row.label}
      </button>
      {feedback && (
        <span className={`shrink-0 text-xs font-medium ${feedback.ok ? 'text-wizard-green-400' : 'text-red-400'}`}>
          {feedback.ok ? '✓' : '✕'} {feedback.text}
        </span>
      )}
    </div>
  );
}

function DashboardEditRow({ row, onPatch, onRemove, onMove }: {
  row: DashboardRow;
  onPatch: (patch: Partial<DashboardRow>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-wizard-muted">{KIND_LABELS[row.kind]}</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => onMove(-1)} className="rounded px-1.5 text-xs text-wizard-muted hover:text-wizard-text" title="Move up" aria-label="Move row up">
            ↑
          </button>
          <button type="button" onClick={() => onMove(1)} className="rounded px-1.5 text-xs text-wizard-muted hover:text-wizard-text" title="Move down" aria-label="Move row down">
            ↓
          </button>
          <button type="button" onClick={onRemove} className="rounded px-1.5 text-xs text-red-400 hover:text-red-300" title="Delete row" aria-label="Delete row">
            ✕
          </button>
        </div>
      </div>
      {row.kind === 'text' && (
        <textarea
          value={row.text}
          onChange={(e) => onPatch({ text: e.target.value })}
          rows={2}
          className={panelClass}
          placeholder="Text to display"
          maxLength={500}
        />
      )}
      {row.kind === 'status' && (
        <div className="space-y-2">
          <input value={row.label ?? ''} onChange={(e) => onPatch({ label: e.target.value || null })} className={panelClass} placeholder="Label (e.g. Players online)" />
          <input value={row.url} onChange={(e) => onPatch({ url: e.target.value })} className={panelClass} placeholder="https://api.mcsrvstat.us/3/server" />
          <div className="flex gap-2">
            <input value={row.jsonPath ?? ''} onChange={(e) => onPatch({ jsonPath: e.target.value || null })} className={panelClass} placeholder="jsonPath e.g. players.online" />
            <input
              type="number"
              value={row.refreshSec ?? 30}
              min={5}
              max={600}
              onChange={(e) => onPatch({ refreshSec: Number(e.target.value) || 30 })}
              className="w-28"
              placeholder="secs"
              title="Refresh seconds"
            />
          </div>
        </div>
      )}
      {row.kind === 'button' && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input value={row.label} onChange={(e) => onPatch({ label: e.target.value })} className={panelClass} placeholder="Button label" />
            <select value={row.method} onChange={(e) => onPatch({ method: e.target.value as DashboardButtonRow['method'] })} className="w-28 rounded-xl border border-white/10 bg-wizard-panel/80 px-2 py-2 text-sm outline-none">
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <input value={row.url} onChange={(e) => onPatch({ url: e.target.value })} className={panelClass} placeholder="Endpoint URL" />
          <input value={row.confirm ?? ''} onChange={(e) => onPatch({ confirm: e.target.value || null })} className={panelClass} placeholder="Confirm prompt (optional)" />
          <textarea
            value={Object.entries(row.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
            onChange={(e) => {
              const headers: Record<string, string> = {};
              for (const line of e.target.value.split('\n')) {
                const idx = line.indexOf(':');
                if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
              }
              onPatch({ headers });
            }}
            rows={2}
            className={panelClass}
            placeholder={'Headers (one per line)\ne.g. X-Api-Key: secret'}
          />
          <textarea value={row.body ?? ''} onChange={(e) => onPatch({ body: e.target.value || null })} rows={2} className={panelClass} placeholder="Request body (optional)" maxLength={2000} />
        </div>
      )}
    </div>
  );
}

export default function DashboardPanel({ chatId, chatName, canEdit, onClose, onSavedIcon }: {
  chatId: string;
  chatName: string;
  canEdit: boolean;
  onClose: () => void;
  onSavedIcon?: (iconUrl: string | null) => void;
}) {
  const [dashboard, setDashboard] = useState<ChatDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<DashboardConfig>(emptyConfig());
  const [draftIcon, setDraftIcon] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const iconInputRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { dashboard: d } = await getDashboard(chatId);
      setDashboard(d);
      setDraft(d.blocks?.sections?.length ? d.blocks : emptyConfig());
      setDraftIcon(d.iconUrl);
    } catch {
      setDashboard(null);
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const beginEdit = () => {
    setDraft(dashboard?.blocks?.sections?.length ? dashboard.blocks : emptyConfig());
    setDraftIcon(dashboard?.iconUrl ?? null);
    setSaveMsg(null);
    setEdit(true);
  };

  const endEdit = () => {
    setEdit(false);
    setSaveMsg(null);
    void reload();
  };

  const patchSection = (sectionId: string, patch: Partial<DashboardSection>) => {
    setDraft((prev) => ({
      ...prev,
      sections: prev.sections.map((s) => (s.id === sectionId ? { ...s, ...patch } : s)),
    }));
  };

  const moveSection = (index: number, dir: -1 | 1) => {
    setDraft((prev) => {
      const next = [...prev.sections];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      const a = next[index];
      const b = next[target];
      if (!a || !b) return prev;
      next[index] = b;
      next[target] = a;
      return { sections: next };
    });
  };

  const patchRow = (sectionId: string, rowId: string, patch: Partial<DashboardRow>) => {
    setDraft((prev) => ({
      ...prev,
      sections: prev.sections.map((s) =>
        s.id === sectionId ? { ...s, rows: s.rows.map((r) => (r.id === rowId ? ({ ...r, ...patch } as DashboardRow) : r)) } : s,
      ),
    }));
  };

  const moveRow = (sectionId: string, index: number, dir: -1 | 1) => {
    setDraft((prev) => ({
      ...prev,
      sections: prev.sections.map((s) => {
        if (s.id !== sectionId) return s;
        const next = [...s.rows];
        const target = index + dir;
        if (target < 0 || target >= next.length) return s;
        const a = next[index];
        const b = next[target];
        if (!a || !b) return s;
        next[index] = b;
        next[target] = a;
        return { ...s, rows: next };
      }),
    }));
  };

  const removeRow = (sectionId: string, rowId: string) => {
    setDraft((prev) => ({
      ...prev,
      sections: prev.sections.map((s) => (s.id === sectionId ? { ...s, rows: s.rows.filter((r) => r.id !== rowId) } : s)),
    }));
  };

  const handleIconFile = async (file: File) => {
    setUploadingIcon(true);
    try {
      const attachment = await uploadAttachment(file);
      setDraftIcon(attachment.url);
    } catch {
      setSaveMsg('Icon upload failed');
    } finally {
      setUploadingIcon(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await saveDashboard(chatId, { iconUrl: draftIcon, blocks: draft });
      setEdit(false);
      onSavedIcon?.(draftIcon);
      void reload();
      setSaveMsg('Saved.');
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Could not save dashboard');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm('Remove this dashboard entirely?')) return;
    try {
      await deleteDashboard(chatId);
      setEdit(false);
      setSaveMsg(null);
      onSavedIcon?.(null);
      void reload();
    } catch {
      setSaveMsg('Could not remove dashboard');
    }
  };

  const emptyBlocks = !dashboard || !dashboard.blocks?.sections?.length || dashboard.blocks.sections.every((s) => s.rows.length === 0);
  const icon = dashboard?.iconUrl ?? null;
  const initial = chatName.slice(0, 2).toUpperCase();

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Chat dashboard">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-md flex-col border-l border-white/10 bg-wizard-panel shadow-2xl shadow-black/50">
        <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          {icon ? (
            <img src={icon} alt={initial} className="h-10 w-10 shrink-0 rounded-xl object-cover ring-1 ring-white/10" />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-wizard-green-500 to-wizard-green-700 text-sm font-bold uppercase text-white ring-1 ring-white/10">
              {initial}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold">Dashboard</h2>
            <p className="truncate text-xs text-wizard-muted">{chatName}</p>
          </div>
          {canEdit && !edit && (
            <button
              type="button"
              onClick={beginEdit}
              className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-wizard-muted transition hover:border-wizard-green-500/50 hover:text-wizard-green-400"
            >
              {emptyBlocks ? 'Create' : 'Edit'}
            </button>
          )}
          <button type="button" onClick={onClose} className="shrink-0 rounded-lg px-2 py-1 text-lg leading-none text-wizard-muted transition hover:text-wizard-text" aria-label="Close dashboard" title="Close">
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {loading ? (
            <p className="animate-pulse text-sm text-wizard-muted">Loading…</p>
          ) : edit ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                {draftIcon ? (
                  <img src={draftIcon} alt="dashboard icon" className="h-12 w-12 rounded-xl object-cover ring-1 ring-white/10" />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/5 text-sm text-wizard-muted ring-1 ring-white/10">None</div>
                )}
                <input ref={iconInputRef} type="file" className="hidden" accept="image/*" onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void handleIconFile(file);
                }} />
                <button type="button" disabled={uploadingIcon} onClick={() => iconInputRef.current?.click()} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs transition hover:border-wizard-green-500/50 hover:text-wizard-green-400 disabled:opacity-50">
                  {uploadingIcon ? 'Uploading…' : 'Upload icon'}
                </button>
                {draftIcon && (
                  <button type="button" onClick={() => setDraftIcon(null)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-red-400 transition hover:border-red-400/50">
                    Remove
                  </button>
                )}
              </div>

              {draft.sections.map((section, si) => (
                <div key={section.id} className="rounded-2xl border border-white/10 bg-black/20 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <input
                      value={section.title ?? ''}
                      onChange={(e) => patchSection(section.id, { title: e.target.value || null })}
                      className={`${panelClass} font-semibold`}
                      placeholder="Section title"
                      maxLength={60}
                    />
                    <button type="button" onClick={() => moveSection(si, -1)} className="shrink-0 rounded px-1.5 text-xs text-wizard-muted hover:text-wizard-text" title="Move section up" aria-label="Move section up">↑</button>
                    <button type="button" onClick={() => moveSection(si, 1)} className="shrink-0 rounded px-1.5 text-xs text-wizard-muted hover:text-wizard-text" title="Move section down" aria-label="Move section down">↓</button>
                    <button
                      type="button"
                      onClick={() => setDraft((prev) => ({ sections: prev.sections.filter((s) => s.id !== section.id) }))}
                      className="shrink-0 rounded px-1.5 text-xs text-red-400 hover:text-red-300"
                      title="Delete section"
                      aria-label="Delete section"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="space-y-2">
                    {section.rows.map((row, ri) => (
                      <div key={row.id} className="relative">
                        <NameTag row={row} />
                        <DashboardEditRow
                          row={row}
                          onPatch={(patch) => patchRow(section.id, row.id, patch)}
                          onRemove={() => removeRow(section.id, row.id)}
                          onMove={(dir) => moveRow(section.id, ri, dir)}
                        />
                      </div>
                    ))}
                    <div className="flex gap-2">
                      {(['text', 'status', 'button'] as const).map((kind) => (
                        <button
                          key={kind}
                          type="button"
                          onClick={() =>
                            setDraft((prev) => ({
                              sections: prev.sections.map((s) =>
                                s.id === section.id ? { ...s, rows: [...s.rows, kind === 'text' ? textRow() : kind === 'status' ? statusRow() : buttonRow()] } : s,
                              ),
                            }))
                          }
                          className="flex-1 rounded-lg border border-dashed border-white/15 px-2 py-1.5 text-xs text-wizard-muted transition hover:border-wizard-green-500/50 hover:text-wizard-green-400"
                        >
                          + {KIND_LABELS[kind]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ))}

              <button
                type="button"
                onClick={() =>
                  setDraft((prev) => ({ sections: [...prev.sections, { id: uid(), title: null, rows: [] }] }))
                }
                className="w-full rounded-lg border border-dashed border-white/15 px-2 py-2 text-sm text-wizard-muted transition hover:border-wizard-green-500/50 hover:text-wizard-green-400"
              >
                + Add section
              </button>

              {saveMsg && <p className="text-xs text-wizard-muted">{saveMsg}</p>}
              <div className="flex gap-2 pb-4">
                <button type="button" disabled={saving} onClick={() => void save()} className="flex-1 rounded-xl bg-wizard-green-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-wizard-green-600 disabled:opacity-50">
                  {saving ? 'Saving…' : 'Save dashboard'}
                </button>
                <button type="button" onClick={endEdit} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-wizard-muted transition hover:border-white/25">
                  Cancel
                </button>
              </div>
              <div className="pb-6 text-center">
                <button type="button" onClick={() => void reset()} className="text-xs text-red-400/80 transition hover:text-red-300">
                  Remove dashboard
                </button>
              </div>
            </div>
          ) : emptyBlocks ? (
            <div className="px-2 py-8 text-center">
              <p className="text-sm text-wizard-muted">{canEdit ? 'No dashboard yet — create one to show server stats, status, and actions.' : 'No dashboard configured for this chat yet.'}</p>
            </div>
          ) : (
            <div className="space-y-5">
              {dashboard!.blocks.sections.map((section) => (
                <section key={section.id}>
                  {section.title && <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-wizard-muted">{section.title}</h3>}
                  <div className="space-y-2">
                    {section.rows.map((row) => (
                      <DashboardRowView key={row.id} chatId={chatId} row={row} />
                    ))}
                  </div>
                </section>
              ))}
              {saveMsg && <p className="text-xs text-wizard-muted">{saveMsg}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NameTag({ row }: { row: DashboardRow }) {
  return (
    <span className="pointer-events-none absolute -top-2 left-2 z-10 rounded bg-wizard-panel px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-wizard-muted ring-1 ring-white/10">
      {KIND_LABELS[row.kind]}
    </span>
  );
}

function DashboardRowView({ chatId, row }: { chatId: string; row: DashboardRow; children?: ReactNode }) {
  switch (row.kind) {
    case 'text':
      return (
        <p className="whitespace-pre-wrap rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-wizard-text">
          {row.text}
        </p>
      );
    case 'status':
      return <StatusRowView chatId={chatId} row={row} />;
    case 'button':
      return <ButtonRowView chatId={chatId} row={row} />;
    default:
      return null;
  }
}