import type { Disposable, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { pick } from '../../../../base/language.ts';
import { S } from './strings.ts';

interface ReceiptFile {
  path: string;
  digest: string;
  bytes: number;
  mime: string;
}

interface ReceiptEvidence {
  source: string;
  status: string;
  summary?: string;
  digest?: string;
  observedAt: number;
}

interface ActionReceiptView {
  id: string;
  taskId: string;
  intent: string;
  action: string;
  phase: string;
  target: Record<string, unknown>;
  payloadDigest: string;
  files: ReceiptFile[];
  dispatchState: string;
  evidence: ReceiptEvidence[];
  createdAt: number;
  updatedAt: number;
  outcome?: string;
  note?: string;
}

interface ReceiptList {
  available: boolean;
  receipts: ActionReceiptView[];
}

type ReviewDecision = 'verified' | 'review-pending' | 'failed';

function targetText(target: Record<string, unknown>): string {
  if (target.surface === 'browser') {
    let location = typeof target.url === 'string' ? target.url.split(/[?#]/, 1)[0] : '';
    try {
      const url = new URL(String(target.url ?? ''));
      location = `${url.origin}${url.pathname}`;
    } catch {
      // Keep malformed persisted URLs visible without query or fragment data.
    }
    return [location, target.accountRef, target.control].filter((part): part is string => typeof part === 'string' && !!part).join(' · ');
  }
  if (target.surface === 'desktop') {
    return [target.bundleId, typeof target.windowId === 'number' ? `window ${target.windowId}` : ''].filter(Boolean).join(' · ');
  }
  return [target.workspaceRoot, target.path].filter((part): part is string => typeof part === 'string' && !!part).join('/');
}

const when = (value: number, language: string): string => Number.isFinite(value)
  ? new Date(value).toLocaleString(language)
  : '';

export const panel: WebUiPanel = {
  async mount(ctx: WebUiPanelContext): Promise<Disposable> {
    const ui = ctx.ui;
    const t = pick(S);
    const root = ui.h('div', 'hindsight-panel');
    const status = ui.msgline(t.loading);
    const header = ui.rowbar();
    const refresh = ui.button(t.refresh, { size: 'sm', onClick: () => void load() });
    header.append(refresh);
    const list = ui.h('div', 'hindsight-list');
    root.append(header, status, list);
    ctx.root.append(root);

    async function review(receipt: ActionReceiptView, decision: ReviewDecision, button: HTMLButtonElement, note: HTMLTextAreaElement): Promise<void> {
      const detail = note.value.trim();
      if (!detail) {
        ui.toast(t.noteRequired, 'bad');
        return;
      }
      const label = decision === 'verified' ? t.verified : decision === 'review-pending' ? t.reviewPending : t.failed;
      const ok = await ui.confirm({ title: t.confirmTitle, body: t.confirmBody(label, targetText(receipt.target)) });
      if (!ok || ctx.signal.aborted) return;
      button.disabled = true;
      try {
        const result = await ctx.invoke<{ ok: boolean; error?: string }>('reconcile', [receipt.id, decision, detail]);
        if (ctx.signal.aborted) return;
        if (!result.ok) {
          ui.toast(result.error === 'unavailable' ? t.reconcileUnavailable
            : result.error === 'invalid' ? t.reconcileInvalid
              : t.reconcileStale, 'bad');
          return;
        }
        ui.toast(t.done, 'ok');
        await load();
      } catch (error) {
        if (ctx.signal.aborted) return;
        ui.toast(error instanceof Error ? error.message : String(error), 'bad');
      } finally {
        button.disabled = false;
      }
    }

    function receiptCard(receipt: ActionReceiptView): HTMLElement {
      const card = ui.sheet({
        title: receipt.action,
        desc: `${t.phaseName(receipt.phase)} · ${when(receipt.createdAt, ctx.language)}`,
      });
      card.body.append(
        ui.h('div', 'stloc', `${t.target}: ${targetText(receipt.target)}`),
        ui.h('div', 'stloc', `${t.dispatch}: ${t.dispatchName(receipt.dispatchState)}`),
        ui.h('div', 'stloc', `${t.payload}: sha256:${receipt.payloadDigest}`),
        ...(receipt.note ? [ui.h('div', 'stloc', receipt.note)] : []),
      );
      for (const file of receipt.files) {
        card.body.append(ui.h('div', 'stloc', `${t.files}: ${file.path} · ${file.bytes} bytes · ${file.mime} · sha256:${file.digest}`));
      }
      for (const evidence of receipt.evidence) {
        card.body.append(ui.h('div', 'stloc', `${t.evidence}: ${evidence.status} · ${evidence.source}${evidence.summary ? ` · ${evidence.summary}` : ''} · ${when(evidence.observedAt, ctx.language)}`));
      }
      if (!['unknown', 'submitted', 'review-pending'].includes(receipt.phase)) return card.el;
      const note = ui.textarea({ placeholder: t.notePlaceholder, cls: 'grow' });
      const actions = ui.actions();
      const verify = ui.button(t.verified, { size: 'sm', variant: 'primary', onClick: () => void review(receipt, 'verified', verify, note) });
      const fail = ui.button(t.failed, { size: 'sm', variant: 'danger', onClick: () => void review(receipt, 'failed', fail, note) });
      actions.append(verify);
      if (receipt.target.surface === 'browser' && receipt.intent === 'platform-write' && receipt.phase !== 'review-pending') {
        const pending = ui.button(t.reviewPending, { size: 'sm', onClick: () => void review(receipt, 'review-pending', pending, note) });
        actions.append(pending);
      }
      actions.append(fail);
      card.body.append(ui.h('div', 'stlabel', t.note), note, actions);
      return card.el;
    }

    async function load(): Promise<void> {
      status.textContent = t.loading;
      status.className = 'msgline';
      list.replaceChildren();
      try {
        const result = await ctx.invoke<ReceiptList>('list');
        if (ctx.signal.aborted) return;
        if (!result.available) {
          status.textContent = t.unavailable;
          status.classList.add('bad');
          return;
        }
        if (result.receipts.length === 0) {
          status.textContent = t.empty;
          return;
        }
        status.textContent = t.count(result.receipts.length);
        for (const receipt of result.receipts) list.append(receiptCard(receipt));
      } catch (error) {
        if (ctx.signal.aborted) return;
        status.textContent = error instanceof Error ? error.message : String(error);
        status.classList.add('bad');
      }
    }

    await load();
    return { dispose() { root.remove(); } };
  },
};
