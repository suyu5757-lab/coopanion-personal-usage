import type { Disposable, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { pick } from '../../../../base/language.ts';
import { S } from './strings.ts';

interface MemoryItem {
  id: string;
  text: string;
  date: string;
  type: string;
}

interface HindsightStatus {
  enabled: boolean;
  bankId: string | null;
  ok: boolean;
  version?: string;
  error?: string;
  recent: MemoryItem[];
}

function when(date: string): string {
  return date ? date.slice(0, 10) : '';
}

function itemText(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 420 ? `${clean.slice(0, 419)}…` : clean;
}

function listOf(ctx: WebUiPanelContext, items: readonly MemoryItem[], empty: string): HTMLElement {
  const ui = ctx.ui;
  if (items.length === 0) return ui.placeholder(empty);
  const list = ui.h('div', 'hindsight-list');
  for (const item of items) {
    const row = ui.h('div', 'strow');
    const info = ui.h('div', 'stinfo');
    info.append(
      ui.h('div', 'stlabel', itemText(item.text)),
      ui.h('div', 'stloc', `${item.type}${when(item.date) ? ` · ${when(item.date)}` : ''}`),
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
        const count = await ctx.invoke<number>('forget', [query]);
        if (ctx.signal.aborted) return;
        ui.toast(t.forgetDone(count), 'ok');
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
        const result = await ctx.invoke<'stored' | 'empty' | 'sensitive'>('remember', [body]);
        if (ctx.signal.aborted) return;
        ui.toast(result === 'stored' ? t.remembered : t.sensitive, result === 'stored' ? 'ok' : 'bad');
        if (result === 'stored') {
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

    root.append(header, statusLine, searchRow, results.el, rememberRow, recent.el, actions);

    async function runSearch(query: string): Promise<void> {
      statusLine.textContent = t.loading;
      statusLine.className = 'msgline';
      const found = await ctx.invoke<MemoryItem[]>('search', [query]);
      if (ctx.signal.aborted) return;
      statusLine.textContent = '';
      results.body.replaceChildren(listOf(ctx, found, t.noResults));
      results.el.hidden = false;
      forget.hidden = found.length === 0;
    }

    async function load(): Promise<void> {
      statusLine.textContent = t.loading;
      statusLine.className = 'msgline';
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
      bank.textContent = status.bankId ? `${t.bank}: ${status.bankId}` : t.bank;
      if (!status.enabled) {
        statusLine.textContent = t.disabledHint;
        statusLine.className = 'msgline bad';
        recent.body.replaceChildren(ui.placeholder(t.disabledHint));
        refresh.disabled = true;
        search.disabled = true;
        remember.disabled = true;
        clear.disabled = true;
        return;
      }
      statusLine.textContent = status.ok ? t.statusOk : `${t.statusError}${status.error ? `: ${status.error}` : ''}`;
      statusLine.className = `msgline${status.ok ? '' : ' bad'}`;
      recent.body.replaceChildren(listOf(ctx, status.recent, t.empty));
      refresh.disabled = false;
      search.disabled = false;
      remember.disabled = false;
      clear.disabled = false;
    }

    await load();
    return { dispose: () => { root.replaceChildren(); } };
  },
};

export { panel };
