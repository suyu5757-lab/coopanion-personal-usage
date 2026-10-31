import type { Disposable, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { get } from '../../../../base/api.ts';
import { pick } from '../../../../base/language.ts';
import { S } from './strings.ts';

interface MemoryItem {
  id: string;
  text: string;
  date: string;
  type: string;
  documentId?: string | null;
  status?: string;
  metadata?: Record<string, string>;
}

interface HindsightStatus {
  enabled: boolean;
  bankId: string | null;
  ok: boolean;
  version?: string;
  error?: string;
  outbox?: {
    pending: number;
    sent: number;
    completed: number;
    unverified: number;
    verified: number;
    failed: number;
    dead: number;
    orphaned: number;
    active: number;
    full: boolean;
    lastError: string | null;
    persistenceError: string | null;
  } | null;
  deletions?: { pending: number; done: number; failed: number; tombstones: number; staleTargets: number; persistenceError: string | null } | null;
  forget?: { tombstones: number; unresolved: number; stale: boolean; damaged: boolean } | null;
  lastDelivery?: { at: number; submitted: number; completed: number; verified: number; failed: number } | null;
  recent: MemoryItem[];
}

interface GrowthProposal {
  id: string;
  createdAt: string;
  title: string;
  summary: string;
  evidence: string[];
  sourceIds: string[];
  changes: Array<{ file: string; from?: string; to: string; reason: string }>;
  risk: 'low' | 'medium' | 'high';
  state: 'candidate' | 'approved' | 'rejected' | 'applied';
  appliedCommit?: string;
}

interface ExperienceCard {
  id: string;
  title: string;
  situation: string;
  lesson: string;
  scope: 'conversation' | 'proactive_speech' | 'browser_exploration';
  kind: 'policy' | 'skill';
  trials: ExperienceTrial[];
  sourceIds: string[];
  state: 'candidate' | 'approved' | 'rejected' | 'deprecated';
  updatedAt: string;
}

interface ExperienceTrial {
  receiptId: string;
  taskFingerprint: string;
  intent: string;
  outcome: 'verified' | 'unknown' | 'failed';
  dispatchState: 'not-dispatched' | 'delivered' | 'unknown';
  createdAt: number;
  recordedAt: string;
  unseenConfirmedAt: string;
}

interface GrowthTrialReceipt {
  receiptId: string;
  taskFingerprint: string;
  intent: string;
  outcome: 'verified' | 'unknown' | 'failed';
  dispatchState: 'not-dispatched' | 'delivered' | 'unknown';
  createdAt: number;
}

interface GrowthStatus {
  schedule: { enabled: boolean; blocked: boolean; everyDays: number; paused: boolean; forkRunning: boolean; lastReviewAt: string | null; nextReviewAt: string | null; lastStatus: string | null; lastError: string | null; lastProposalCount: number | null; lastFinishedAt: string | null; activeRun: boolean } | null;
  proposals: GrowthProposal[];
  experiences: ExperienceCard[];
  browser: { enabled: boolean; actions: boolean; sessionMinutes: number | null; sessionUnlimited: boolean; maxCallsPerSession: number };
}

interface SystemHealth {
  coreRssBytes: number;
  systemTotalBytes: number;
  systemFreeBytes: number;
  memoryPressureFreePercent: number | null;
  backgroundPausedForMemory: boolean;
  diskAvailableBytes: number | null;
}

interface UsageSummary {
  currency?: string;
  totals?: { calls?: number; promptTokens?: number; completionTokens?: number; cost?: number; pricedCalls?: number; unpricedCalls?: number } | null;
}

function when(date: string): string {
  return date ? date.slice(0, 10) : '';
}

function itemText(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 420 ? `${clean.slice(0, 419)}…` : clean;
}

function bytes(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = Math.max(0, value), index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function listOf(ctx: WebUiPanelContext, items: readonly MemoryItem[], empty: string, sourceLabel: string, supersededLabel: string): HTMLElement {
  const ui = ctx.ui;
  if (items.length === 0) return ui.placeholder(empty);
  const list = ui.h('div', 'hindsight-list');
  for (const item of items) {
    const row = ui.h('div', 'strow');
    const info = ui.h('div', 'stinfo');
    info.append(
      ui.h('div', 'stlabel', itemText(item.text)),
      ui.h('div', 'stloc', `${item.type}${(item.status ?? item.metadata?.status) === 'superseded' ? ` · ${supersededLabel}` : ''}${when(item.date) ? ` · ${when(item.date)}` : ''}${item.documentId ? ` · ${sourceLabel}: ${item.documentId}` : ''}`),
    );
    row.append(info);
    list.append(row);
  }
  return list;
}

const panel: WebUiPanel = {
  async mount(ctx: WebUiPanelContext): Promise<Disposable> {
    const ui = ctx.ui;
    const t = pick(S);
    const root = ui.h('div', 'hindsight-panel');
    const statusLine = ui.msgline(t.loading);
    const header = ui.rowbar();
    const bank = ui.h('span', 'stloc');
    const refresh = ui.button(t.refresh, { size: 'sm', onClick: () => void load() });
    header.append(bank, refresh);

    const searchInput = ui.input({ placeholder: t.searchPlaceholder, cls: 'grow' });
    const search = ui.button(t.search, {
      onClick: () => {
        const query = searchInput.value.trim();
        if (query) void runSearch(query);
      },
    });
    const forget = ui.button(t.forget, {
      variant: 'danger',
      onClick: async () => {
        const query = searchInput.value.trim();
        if (!query) return;
        const ok = await ui.confirm({ title: t.forgetConfirmTitle, body: t.forgetConfirmBody, danger: true });
        if (!ok || ctx.signal.aborted) return;
        const result = await ctx.invoke<{ local: number; deleted: number; pending: number; failed: number }>('forget', [query]);
        if (ctx.signal.aborted) return;
        ui.toast(t.forgetDone(result.local, result.deleted, result.pending, result.failed), 'ok');
        await load();
      },
    });
    forget.hidden = true;
    const searchRow = ui.rowbar();
    searchRow.append(searchInput, search, forget);

    const rememberInput = ui.input({ placeholder: t.rememberPlaceholder, cls: 'grow' });
    const remember = ui.button(t.remember, {
      onClick: async () => {
        const body = rememberInput.value.trim();
        if (!body) return;
        const result = await ctx.invoke<'queued' | 'empty' | 'sensitive' | 'full' | 'disabled' | 'persistence-error' | 'forgotten'>('remember', [body]);
        if (ctx.signal.aborted) return;
        if (result === 'full') {
          ui.toast(t.queueFull, 'bad');
          return;
        }
        if (result === 'disabled') {
          ui.toast(t.disabledHint, 'bad');
          return;
        }
        if (result === 'persistence-error') {
          ui.toast(t.persistenceError, 'bad');
          return;
        }
        ui.toast(result === 'queued' ? t.remembered : t.sensitive, result === 'queued' ? 'ok' : 'bad');
        if (result === 'queued') {
          rememberInput.value = '';
          await load();
        }
      },
    });
    const rememberRow = ui.rowbar();
    rememberRow.append(rememberInput, remember);

    const recent = ui.sheet({ title: t.recent });
    const results = ui.sheet({ title: t.search });
    results.el.hidden = true;

    const clear = ui.button(t.clear, {
      variant: 'danger',
      onClick: async () => {
        const ok = await ui.confirm({ title: t.clearConfirmTitle, body: t.clearConfirmBody, danger: true });
        if (!ok || ctx.signal.aborted) return;
        const message = await ctx.invoke<string>('clear');
        if (ctx.signal.aborted) return;
        ui.toast(message || t.clearDone, 'ok');
        await load();
      },
    });
    const actions = ui.actions();
    actions.append(clear);

    const growth = ui.sheet({ title: t.growth });
    const growthStatus = ui.msgline(t.growthLoading);
    const proposalList = ui.h('div', 'hindsight-list');
    const experienceList = ui.h('div', 'hindsight-list');
    const proposalsSheet = ui.sheet({ title: t.proposals });
    const experiencesSheet = ui.sheet({ title: t.experienceCards });
    proposalsSheet.body.append(proposalList);
    experiencesSheet.body.append(experienceList);

    const cardForm = ui.h('div', 'hindsight-list');
    const cardTitle = ui.input({ placeholder: t.cardTitle, cls: 'grow' });
    const cardSituation = ui.textarea({ placeholder: t.cardSituation, cls: 'grow' });
    const cardLesson = ui.textarea({ placeholder: t.cardLesson, cls: 'grow' });
    const cardSources = ui.textarea({ placeholder: t.cardSources, cls: 'grow' });
    const cardKind = ui.h('select', 'grow') as HTMLSelectElement;
    for (const [value, label] of [['policy', t.kindPolicy], ['skill', t.kindSkill]]) {
      const option = ui.h('option', null, label) as HTMLOptionElement;
      option.value = value;
      cardKind.append(option);
    }
    const cardScope = ui.h('select', 'grow') as HTMLSelectElement;
    for (const [value, label] of [
      ['conversation', t.scopeConversation], ['proactive_speech', t.scopeSpeech], ['browser_exploration', t.scopeBrowser],
    ]) {
      const option = ui.h('option', null, label) as HTMLOptionElement;
      option.value = value;
      cardScope.append(option);
    }
    const addCard = ui.button(t.addCard, {
      onClick: async () => {
        try {
          const card = await ctx.invoke<ExperienceCard>('experience-create', [{
            title: cardTitle.value,
            situation: cardSituation.value,
            lesson: cardLesson.value,
            scope: cardScope.value,
            kind: cardKind.value,
            sourceIds: cardSources.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
          }]);
          if (ctx.signal.aborted) return;
          cardTitle.value = '';
          cardSituation.value = '';
          cardLesson.value = '';
          cardSources.value = '';
          cardKind.value = 'policy';
          ui.toast(t.cardAdded, 'ok');
          await loadGrowth();
        } catch (error) {
          if (!ctx.signal.aborted) ui.toast(error instanceof Error ? error.message : String(error), 'bad');
        }
      },
    });
    cardForm.append(cardTitle, cardSituation, cardLesson, cardKind, cardScope, cardSources, addCard);
    const addCardSheet = ui.sheet({ title: t.createCard });
    addCardSheet.body.append(cardForm);

    const health = ui.sheet({ title: t.systemHealth });
    const healthBody = ui.h('div', 'hindsight-list');
    const usageLine = ui.h('div', 'stloc', t.usageUnavailable);
    health.body.append(healthBody, usageLine);

    root.append(header, statusLine, searchRow, results.el, rememberRow, recent.el, actions, growth.el, growthStatus, proposalsSheet.el, experiencesSheet.el, addCardSheet.el, health.el);

    async function runSearch(query: string): Promise<void> {
      statusLine.textContent = t.loading;
      statusLine.className = 'msgline';
      const found = await ctx.invoke<MemoryItem[]>('search', [query]);
      if (ctx.signal.aborted) return;
      statusLine.textContent = '';
      results.body.replaceChildren(listOf(ctx, found, t.noResults, t.sources, t.superseded));
      results.el.hidden = false;
      forget.hidden = found.length === 0;
    }

    function stateLabel(state: string): string {
      return state === 'candidate' ? t.candidate
        : state === 'approved' ? t.approved
          : state === 'rejected' ? t.rejected
            : state === 'applied' ? t.applied
              : state === 'deprecated' ? t.deprecated : state;
    }

    function proposalRow(proposal: GrowthProposal): HTMLElement {
      const row = ui.h('div', 'strow');
      const info = ui.h('div', 'stinfo');
      info.append(
        ui.h('div', 'stlabel', proposal.title),
        ui.h('div', 'stloc', `${stateLabel(proposal.state)} · ${proposal.risk} · ${when(proposal.createdAt)}`),
        ui.h('p', 'home-note', proposal.summary),
        ui.h('div', 'stloc', `${t.proposalEvidence}: ${proposal.evidence.join(' · ')}`),
        ui.h('div', 'stloc', `${t.proposalSources}: ${proposal.sourceIds.join(', ')}`),
        ...proposal.changes.map((change) => ui.h('div', 'stloc', `${change.file}: ${change.from ? `${change.from} → ` : ''}${change.to} (${change.reason})`)),
      );
      const actions = ui.actions();
      if (proposal.state === 'candidate') {
        actions.append(ui.button(t.approve, { size: 'sm', onClick: () => void reviewProposal(proposal, 'approved') }));
        actions.append(ui.button(t.reject, { size: 'sm', variant: 'danger', onClick: () => void reviewProposal(proposal, 'rejected') }));
      } else if (proposal.state === 'approved') {
        actions.append(ui.h('div', 'stloc', t.applyUnavailable));
      } else if (proposal.state === 'applied' && proposal.appliedCommit) {
        info.append(ui.h('div', 'stloc', t.applyDone(proposal.appliedCommit)));
      }
      row.append(info, actions);
      return row;
    }

    async function reviewProposal(proposal: GrowthProposal, action: 'approved' | 'rejected'): Promise<void> {
      try {
        await ctx.invoke('growth-proposal-review', [proposal.id, action]);
        if (ctx.signal.aborted) return;
        ui.toast(action === 'approved' ? t.approved : t.rejected, 'ok');
        await loadGrowth();
      } catch (error) {
        if (!ctx.signal.aborted) ui.toast(error instanceof Error ? error.message : String(error), 'bad');
      }
    }

    function experienceRow(card: ExperienceCard): HTMLElement {
      const row = ui.h('div', 'strow');
      const info = ui.h('div', 'stinfo');
      const scope = card.scope === 'conversation' ? t.scopeConversation : card.scope === 'proactive_speech' ? t.scopeSpeech : t.scopeBrowser;
      const kind = card.kind === 'skill' ? t.kindSkill : t.kindPolicy;
      info.append(
        ui.h('div', 'stlabel', card.title),
        ui.h('div', 'stloc', `${stateLabel(card.state)} · ${kind} · ${scope} · ${when(card.updatedAt)}`),
        ui.h('p', 'home-note', `${card.situation} — ${card.lesson}`),
        ui.h('div', 'stloc', `${t.proposalSources}: ${card.sourceIds.join(', ')}`),
      );
      for (const trial of card.trials) {
        const outcome = trial.outcome === 'verified' ? t.trialVerified : trial.outcome === 'unknown' ? t.trialUnknown : t.trialFailed;
        info.append(ui.h('div', 'stloc', `${outcome} · ${trial.intent} · ${when(new Date(trial.createdAt).toISOString())} · ${trial.receiptId.slice(0, 8)}`));
        info.append(ui.h('div', 'stloc', `${t.trialUserConfirmed} · ${when(trial.unseenConfirmedAt)}`));
      }
      const actions = ui.actions();
      if (card.state === 'candidate') {
        if (card.kind === 'skill' && !card.trials.some((trial) => trial.outcome === 'verified')) {
          info.append(ui.h('div', 'stloc', t.skillNeedsTrial));
        } else {
          actions.append(ui.button(t.approve, { size: 'sm', onClick: () => void reviewCard(card, 'approved') }));
        }
        actions.append(ui.button(t.reject, { size: 'sm', variant: 'danger', onClick: () => void reviewCard(card, 'rejected') }));
        if (card.kind === 'skill') actions.append(ui.button(t.recordTrial, { size: 'sm', onClick: () => void selectTrial(card, row) }));
      } else if (card.state === 'approved') {
        actions.append(ui.button(t.deprecate, { size: 'sm', variant: 'danger', onClick: () => void reviewCard(card, 'deprecated') }));
      }
      row.append(info, actions);
      return row;
    }

    async function selectTrial(card: ExperienceCard, row: HTMLElement): Promise<void> {
      try {
        const receipts = await ctx.invoke<GrowthTrialReceipt[]>('experience-trial-receipts', [card.id]);
        if (ctx.signal.aborted) return;
        if (receipts.length === 0) {
          ui.toast(t.trialNoReceipts, 'bad');
          return;
        }
        const selector = ui.h('select', 'grow') as HTMLSelectElement;
        const placeholder = ui.h('option', null, t.trialSelectReceipt) as HTMLOptionElement;
        placeholder.value = '';
        selector.append(placeholder);
        const byId = new Map<string, GrowthTrialReceipt>();
        for (const receipt of receipts) {
          byId.set(receipt.receiptId, receipt);
          const outcome = receipt.outcome === 'verified' ? t.trialVerified : receipt.outcome === 'unknown' ? t.trialUnknown : t.trialFailed;
          const option = ui.h('option', null, `${when(new Date(receipt.createdAt).toISOString())} · ${receipt.intent} · ${outcome} · ${receipt.receiptId.slice(0, 8)}`) as HTMLOptionElement;
          option.value = receipt.receiptId;
          selector.append(option);
        }
        const record = ui.button(t.recordTrial, {
          size: 'sm',
          onClick: async () => {
            const receipt = byId.get(selector.value);
            if (!receipt) {
              ui.toast(t.trialSelectReceipt, 'bad');
              return;
            }
            const outcome = receipt.outcome === 'verified' ? t.trialVerified : receipt.outcome === 'unknown' ? t.trialUnknown : t.trialFailed;
            const confirmed = await ui.confirm({
              title: t.trialConfirmTitle,
              body: `${when(new Date(receipt.createdAt).toISOString())} · ${receipt.intent} · ${outcome}\n\n${t.trialConfirmBody}`,
            });
            if (!confirmed || ctx.signal.aborted) return;
            await ctx.invoke('experience-trial-record', [card.id, receipt.receiptId, true]);
            if (ctx.signal.aborted) return;
            ui.toast(t.trialRecorded, 'ok');
            await loadGrowth();
          },
        });
        const trialControls = ui.h('div', 'hindsight-list');
        trialControls.append(selector, record);
        const existing = row.querySelector('[data-growth-trial-picker]');
        existing?.remove();
        trialControls.setAttribute('data-growth-trial-picker', card.id);
        row.append(trialControls);
      } catch (error) {
        if (!ctx.signal.aborted) ui.toast(error instanceof Error ? error.message : String(error), 'bad');
      }
    }

    async function reviewCard(card: ExperienceCard, action: 'approved' | 'rejected' | 'deprecated'): Promise<void> {
      try {
        await ctx.invoke('experience-review', [card.id, action]);
        if (ctx.signal.aborted) return;
        ui.toast(action === 'approved' ? t.approved : action === 'rejected' ? t.rejected : t.deprecate, 'ok');
        await loadGrowth();
      } catch (error) {
        if (!ctx.signal.aborted) ui.toast(error instanceof Error ? error.message : String(error), 'bad');
      }
    }

    function healthRow(label: string, value: string): HTMLElement {
      const row = ui.h('div', 'strow');
      row.append(ui.h('div', 'stlabel', label), ui.h('div', 'stloc', value));
      return row;
    }

    async function loadGrowth(): Promise<void> {
      growthStatus.textContent = t.growthLoading;
      growthStatus.className = 'msgline';
      try {
        const [data, system] = await Promise.all([
          ctx.invoke<GrowthStatus>('growth-status'),
          ctx.invoke<SystemHealth>('system-health'),
        ]);
        if (ctx.signal.aborted) return;
        const schedule = data.schedule;
        const scheduleEnabled = schedule?.blocked ? t.reviewBlocked : schedule?.enabled ? t.enabled : t.off;
        const lastStatus = schedule?.lastStatus === 'ok' ? t.reviewOk
          : schedule?.lastStatus === 'failed' ? t.reviewFailed
            : schedule?.lastStatus === 'interrupted' ? t.reviewInterrupted : t.notRun;
        growthStatus.textContent = schedule
          ? `${t.growthSchedule}: ${scheduleEnabled}${schedule.paused ? ` · ${t.paused}` : ''}${schedule.activeRun ? ` · ${t.running}` : ''} · ${t.nextReview}: ${schedule.nextReviewAt ? when(schedule.nextReviewAt) : t.notRun} · ${t.lastReview}: ${schedule.lastFinishedAt ? when(schedule.lastFinishedAt) : t.notRun} · ${lastStatus}${schedule.lastProposalCount !== null ? ` · ${t.proposalCount(schedule.lastProposalCount)}` : ''}${schedule.lastError ? ` · ${t.lastReviewError}: ${schedule.lastError}` : ''}`
          : `${t.growthSchedule}: ${t.statusOff}`;
        proposalList.replaceChildren(...(data.proposals.length ? data.proposals.map(proposalRow) : [ui.placeholder(t.noProposals)]));
        experienceList.replaceChildren(...(data.experiences.length ? data.experiences.map(experienceRow) : [ui.placeholder(t.noExperienceCards)]));
        healthBody.replaceChildren(
          healthRow(t.coreMemory, bytes(system.coreRssBytes)),
          healthRow(t.systemMemoryFree, `${bytes(system.systemFreeBytes)} / ${bytes(system.systemTotalBytes)}`),
          healthRow(t.memoryPressure, system.memoryPressureFreePercent === null ? '—' : `${system.memoryPressureFreePercent}%`),
          healthRow(t.diskFree, bytes(system.diskAvailableBytes)),
          healthRow(t.backgroundWork, system.backgroundPausedForMemory ? t.paused : t.backgroundUnpaused),
          healthRow(t.browserBudget, `${data.browser.enabled ? t.enabled : t.off}; ${data.browser.actions ? t.browserActionsEnabled : t.browserReadOnly}; ${data.browser.sessionUnlimited ? '∞' : `${data.browser.sessionMinutes ?? 0} min`}; ${data.browser.maxCallsPerSession} calls`),
        );
        try {
          const usage = await get<UsageSummary>('/api/usage?bucket=day&days=1', { signal: ctx.signal });
          const totals = usage.totals;
          usageLine.textContent = totals
            ? `${t.usageToday}: ${totals.calls ?? 0} calls · ${(totals.promptTokens ?? 0) + (totals.completionTokens ?? 0)} tokens · ${totals.cost !== undefined ? `${usage.currency ?? 'USD'} ${totals.cost.toFixed(4)}` : t.usageUnavailable}`
            : t.usageUnavailable;
        } catch {
          if (ctx.signal.aborted) return;
          usageLine.textContent = t.usageUnavailable;
        }
      } catch (error) {
        if (ctx.signal.aborted) return;
        growthStatus.textContent = error instanceof Error ? error.message : String(error);
        growthStatus.className = 'msgline bad';
        usageLine.textContent = t.usageUnavailable;
      }
    }

    async function load(): Promise<void> {
      statusLine.textContent = t.loading;
      statusLine.className = 'msgline';
      await loadGrowth();
      let status: HindsightStatus;
      try {
        status = await ctx.invoke<HindsightStatus>('status');
      } catch (err) {
        if (ctx.signal.aborted) return;
        statusLine.textContent = err instanceof Error ? err.message : String(err);
        statusLine.className = 'msgline bad';
        return;
      }
      if (ctx.signal.aborted) return;
      const pending = status.outbox?.pending ?? 0;
      const running = status.outbox?.sent ?? 0;
      const completed = status.outbox?.completed ?? 0;
      const unverified = status.outbox?.unverified ?? 0;
      const verified = status.outbox?.verified ?? 0;
      const failed = status.outbox?.dead ?? 0;
      const deletions = (status.deletions?.pending ?? 0) + (status.deletions?.failed ?? 0);
      const isolated = status.outbox?.orphaned ?? 0;
      bank.textContent = [
        status.bankId ? `${t.bank}: ${status.bankId}` : t.bank,
        pending > 0 ? t.queuePending(pending) : '',
        running > 0 ? t.queueRunning(running) : '',
        completed > 0 ? t.queueComplete(completed) : '',
        unverified > 0 ? t.queueUnverified(unverified) : '',
        verified > 0 ? t.queueVerified(verified) : '',
        failed > 0 ? t.queueDead(failed) : '',
        deletions > 0 ? t.deletions(deletions) : '',
        (status.deletions?.done ?? 0) > 0 ? t.deleteDone(status.deletions!.done) : '',
        (status.forget?.tombstones ?? 0) > 0 ? t.fenceCount(status.forget!.tombstones) : '',
        status.forget?.stale ? t.portraitsStale : '',
        status.forget?.damaged ? t.ledgerDamaged : '',
        isolated > 0 ? t.isolated(isolated) : '',
        status.lastDelivery ? t.lastDelivery(status.lastDelivery.submitted, status.lastDelivery.completed, status.lastDelivery.verified, status.lastDelivery.failed) : '',
      ].filter(Boolean).join(' · ');
      bank.title = status.outbox?.lastError ?? '';
      if (!status.enabled) {
        const unavailable = status.error && status.error !== 'disabled'
          ? `${t.statusError}: ${status.error}`
          : t.disabledHint;
        statusLine.textContent = unavailable;
        statusLine.className = 'msgline bad';
        recent.body.replaceChildren(ui.placeholder(unavailable));
        refresh.disabled = false;
        search.disabled = true;
        remember.disabled = true;
        clear.disabled = true;
        return;
      }
      statusLine.textContent = status.outbox?.persistenceError || status.deletions?.persistenceError
        || (status.ok ? t.statusOk : `${t.statusError}${status.error ? `: ${status.error}` : ''}`);
      statusLine.className = `msgline${status.ok && !status.outbox?.persistenceError && !status.deletions?.persistenceError ? '' : ' bad'}`;
      recent.body.replaceChildren(listOf(ctx, status.recent, t.empty, t.sources, t.superseded));
      refresh.disabled = false;
      search.disabled = false;
      remember.disabled = false;
      clear.disabled = false;
    }

    ctx.root.append(root);

    await load();
    return { dispose: () => { root.remove(); } };
  },
};

export { panel };
