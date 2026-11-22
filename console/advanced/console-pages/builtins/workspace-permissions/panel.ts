import type { Disposable, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { pick } from '../../../../base/language.ts';
import { S } from './strings.ts';

interface RuleView {
  id: string;
  path: string;
  operations: string[];
  extensions: string[];
  maxBytes: number;
  createdAt: number;
  createdBy: string;
}

interface PendingView {
  id: string;
  path: string;
  operation: string;
  tool: string;
  bytes: number;
  payloadDigest: string;
  targetState: string;
  status: string;
  attempts: number;
  createdAt: number;
  lastSeenAt: number;
  ruleEligible: boolean;
  scope: string;
  reason: string;
}

interface PermissionView {
  available: boolean;
  error?: string;
  paused: boolean;
  degraded: boolean;
  rules: RuleView[];
  pending: PendingView[];
  pendingCount: number;
  usage: { day: string; writes: number; bytes: number; maxWrites: number; maxBytes: number };
  limits: { maxAutoBytes: number; maxAppendBytes: number; dailyWrites: number; dailyBytes: number; promptCooldownMs: number; deferHoldMs: number };
}

const when = (value: number, language: string): string => Number.isFinite(value) ? new Date(value).toLocaleString(language) : '';
const size = (bytes: number): string => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;

export const panel: WebUiPanel = {
  async mount(ctx: WebUiPanelContext): Promise<Disposable> {
    const ui = ctx.ui;
    const t = pick(S);
    const root = ui.h('div', 'hindsight-panel');
    const status = ui.msgline(t.loading);
    const header = ui.rowbar();
    const refresh = ui.button(t.refresh, { size: 'sm', onClick: () => void load() });
    const enable = ui.button(t.enableDefaults, { size: 'sm', variant: 'primary', onClick: () => void enableDefaults() });
    const pause = ui.checkbox(t.pause, { onChange: (checked) => void setPaused(checked) });
    header.append(refresh, enable, pause.el);
    const stats = ui.statgrid();
    const rules = ui.sheet({ title: t.rules });
    const pending = ui.sheet({ title: t.pending });
    root.append(header, status, stats, pending.el, rules.el);
    ctx.root.append(root);

    async function invoke<T>(method: string, args: unknown[] = []): Promise<T> {
      return ctx.invoke<T>(method, args);
    }

    async function enableDefaults(): Promise<void> {
      enable.disabled = true;
      try {
        const result = await invoke<{ ok: boolean; added?: number; error?: string }>('enableDefaults');
        if (ctx.signal.aborted) return;
        if (!result.ok) ui.toast(result.error === 'unavailable' ? t.unavailable : t.failed, 'bad');
        else ui.toast(t.enabled(result.added ?? 0), 'ok');
        await load();
      } catch (error) {
        if (!ctx.signal.aborted) ui.toast(error instanceof Error ? error.message : String(error), 'bad');
      } finally {
        enable.disabled = false;
      }
    }

    async function setPaused(checked: boolean): Promise<void> {
      try {
        const result = await invoke<{ ok: boolean }>('setPaused', [checked]);
        if (ctx.signal.aborted) return;
        if (!result.ok) ui.toast(t.failed, 'bad');
        else ui.toast(checked ? t.paused : t.resumed, 'ok');
        await load();
      } catch {
        if (!ctx.signal.aborted) ui.toast(t.failed, 'bad');
      }
    }

    async function revoke(rule: RuleView, button: HTMLButtonElement): Promise<void> {
      const ok = await ui.confirm({ title: t.revokeTitle, body: t.revokeBody(rule.path), danger: true });
      if (!ok || ctx.signal.aborted) return;
      button.disabled = true;
      try {
        const result = await invoke<{ ok: boolean }>('revokeRule', [rule.id]);
        if (ctx.signal.aborted) return;
        ui.toast(result.ok ? t.revoked : t.failed, result.ok ? 'ok' : 'bad');
        await load();
      } finally {
        button.disabled = false;
      }
    }

    async function resolve(item: PendingView, action: 'allow-once' | 'always' | 'deny' | 'dismiss', button: HTMLButtonElement): Promise<void> {
      const label = action === 'allow-once' ? t.allowOnce : action === 'always' ? t.always : action === 'deny' ? t.deny : t.dismiss;
      const ok = await ui.confirm({ title: t.resolveTitle(label), body: t.resolveBody(item.path, label), danger: action === 'deny' || action === 'dismiss' });
      if (!ok || ctx.signal.aborted) return;
      button.disabled = true;
      try {
        const result = await invoke<{ ok: boolean; error?: string }>('resolvePending', [item.id, action]);
        if (ctx.signal.aborted) return;
        ui.toast(result.ok ? t.resolved : result.error === 'missing' ? t.stale : t.failed, result.ok ? 'ok' : 'bad');
        await load();
      } finally {
        button.disabled = false;
      }
    }

    function ruleCard(rule: RuleView): HTMLElement {
      const card = ui.sheet({ title: rule.path, desc: `${t.created}: ${when(rule.createdAt, ctx.language)} · ${rule.createdBy}` });
      card.body.append(
        ui.h('div', 'stloc', `${t.operations}: ${rule.operations.join(', ')}`),
        ui.h('div', 'stloc', `${t.extensions}: ${rule.extensions.join(' ')} · ${t.maxBytes}: ${size(rule.maxBytes)}`),
      );
      const actions = ui.actions();
      const revokeButton = ui.button(t.revoke, { size: 'sm', variant: 'danger', onClick: () => void revoke(rule, revokeButton) });
      actions.append(revokeButton);
      card.body.append(actions);
      return card.el;
    }

    function pendingCard(item: PendingView): HTMLElement {
      const card = ui.sheet({ title: item.path, desc: `${t.operationName(item.operation)} · ${size(item.bytes)} · ${t.attempts(item.attempts)}` });
      card.body.append(
        ui.h('div', 'stloc', `${t.tool}: ${item.tool}`),
        ui.h('div', 'stloc', `${t.digest}: sha256:${item.payloadDigest.slice(0, 16)}…`),
        ui.h('div', 'stloc', `${t.scope}: ${item.scope} · ${item.targetState === 'absent' ? t.newFile : t.existingFile}`),
        ui.h('div', 'stloc', `${t.waitingSince}: ${when(item.createdAt, ctx.language)} · ${t.reason}: ${item.reason}`),
        ui.h('div', 'stloc', t.pendingNote),
      );
      const actions = ui.actions();
      const once = ui.button(t.allowOnce, { size: 'sm', variant: 'primary', onClick: () => void resolve(item, 'allow-once', once) });
      const always = ui.button(t.always, { size: 'sm', onClick: () => void resolve(item, 'always', always) });
      const deny = ui.button(t.deny, { size: 'sm', variant: 'danger', onClick: () => void resolve(item, 'deny', deny) });
      const dismiss = ui.button(t.dismiss, { size: 'sm', onClick: () => void resolve(item, 'dismiss', dismiss) });
      actions.append(once);
      if (item.ruleEligible) actions.append(always);
      actions.append(deny, dismiss);
      card.body.append(actions);
      return card.el;
    }

    async function load(): Promise<void> {
      status.textContent = t.loading;
      status.className = 'msgline';
      try {
        const result = await invoke<PermissionView>('list');
        if (ctx.signal.aborted) return;
        if (!result.available) {
          status.textContent = t.unavailable;
          status.classList.add('bad');
          return;
        }
        pause.setChecked(result.paused);
        stats.replaceChildren(
          ui.stat({ k: t.pendingCount, v: result.pendingCount }),
          ui.stat({ k: t.ruleCount, v: result.rules.length }),
          ui.stat({ k: t.usageToday, v: `${result.usage.writes} / ${result.usage.maxWrites}` }),
          ui.stat({ k: t.bytesToday, v: `${size(result.usage.bytes)} / ${size(result.usage.maxBytes)}` }),
        );
        status.textContent = result.degraded ? t.degraded : result.paused ? t.pausedHint : t.ready;
        if (result.degraded) status.classList.add('bad');
        pending.body.replaceChildren();
        if (result.pending.length === 0) pending.body.append(ui.placeholder(t.noPending));
        else for (const item of result.pending) pending.body.append(pendingCard(item));
        rules.body.replaceChildren();
        if (result.rules.length === 0) rules.body.append(ui.placeholder(t.noRules));
        else for (const rule of result.rules) rules.body.append(ruleCard(rule));
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
