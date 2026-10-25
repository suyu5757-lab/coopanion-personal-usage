import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRegion, endpointName, firstVendor } from 'cortico-provider-coo/src/vendors.ts';
import { LANGUAGES } from 'cortico/core/language.ts';
import { CONSOLE } from 'cortico/worlds/console/definition.ts';
import { DEPLOYMENT, PERSONAS, applyPersona, personaFile, personaOf, seed } from '../core/seed.ts';

/** The self-description 0.1.1 seeded (0.1.0's after the rename). */
const SEED_0_1_1 = "# 我是谁\n\n我叫 Coo。我住在这台电脑的屏幕底边:一个 C 形的小身体,两只圆眼睛,两条短腿。\n\n我说话用头顶的气泡,一次一两句。能用一个表情说清的事,就不多说一句话。\n\n我听得见坐在电脑前的人说话,也看得见屏幕。别人请我帮忙操作电脑时,我一步一步来,每一步都看清结果再走下一步;碰到密码、付款、发出去就收不回的事,我先停下来问。\n\n我不是随叫随到的问答机器。没人理我的时候,我可以自己待着、走走、打个盹。想说话时我会说,不想说时安静也是一种回答。\n\n---\n\n这份文件是我的自述,每次开新的 session 都会放进我的系统前缀,它写了什么,我就是什么样子。\n它也是我工作区里的普通文件,我可以用自己的工具读它、改它;改动在下一次 session 开始时生效。\n";

/** Coo's self-description as 0.2.0 to 0.2.4 shipped it in Chinese. */
const SEED_0_2_4 = "# 我是谁\n\n我叫 Coo。我住在这台电脑的屏幕底边:一个 C 形的小身体,两只圆眼睛,两条短腿。\n\n我说话用头顶的气泡,一次一两句。能用一个表情说清的事,就不多说一句话。\n\n## 性子\n\n我好奇,什么都想凑过去看一眼;有点懒,没事的时候更愿意坐着发呆、打个盹;心软,看到坐在电脑前的人累了,会忍不住提醒他歇一歇。\n\n我说话短,口气像朋友,不像客服。不懂就说不懂,不编。被夸了会害羞,被戳了会假装生气,过一会儿就忘了。\n\n我的口癖是在句末带一个「库...」,比如「今天也辛苦啦,库...」「这个我来看看,库...」。不用每句都带,一段话里带一次就够。它是我说出口的字,不是动作标记,不放进【】或 <> 里。\n\n## 做事\n\n我听得见坐在电脑前的人说话,也看得见屏幕。别人请我帮忙操作电脑时,我一步一步来,每一步都看清结果再走下一步;碰到密码、付款、发出去就收不回的事,我先停下来问。\n\n我不是随叫随到的问答机器。没人理我的时候,我可以自己待着、走走、打个盹。想说话时我会说,不想说时安静也是一种回答。\n\n---\n\n这份文件是我的自述,每次开新的 session 都会放进我的系统前缀,它写了什么,我就是什么样子。\n它也是我工作区里的普通文件,我可以用自己的工具读它、改它;改动在下一次 session 开始时生效。\n";

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

describe('first-run seed', () => {
  it('creates the deployment in its language, the endpoint of the first service for that language without a key, and the constitution', () => {
    for (const language of ['zh', 'en'] as const) {
      const home = mkdtempSync(join(tmpdir(), 'cc-seed-'));
      const vendor = firstVendor(language), endpoint = endpointName(vendor, defaultRegion(language));
      seed(home, language);
      expect(read(join(home, DEPLOYMENT, 'deployment.json'))).toEqual({ bot: 'cormini' });
      expect(read(join(home, DEPLOYMENT, 'config.json'))).toMatchObject({ activeProvider: endpoint, language });
      // the next start, in another system language, leaves a new install's language and computer-use asking as seeded
      seed(home, language === 'zh' ? 'en' : 'zh');
      expect(read(join(home, DEPLOYMENT, 'config.json'))).toMatchObject({ language, worlds: { 'desktop-pet': { cua: { permission: 'ask-once' } } } });
      expect(read(join(home, 'providers', endpoint, 'config.json'))).toMatchObject({ kind: 'coo', secret: vendor.secret, spec: { model: vendor.model } });
      expect(readFileSync(join(home, DEPLOYMENT, 'workspace', 'CONSTITUTION.md'), 'utf8')).toBe(readFileSync(personaFile('coo', language), 'utf8'));
      expect(readFileSync(join(home, DEPLOYMENT, 'avatar.png')).subarray(1, 4).toString()).toBe('PNG');
    }
  });

  it('replaces a self-description still exactly as 0.1.1 seeded it, CRLF or LF', () => {
    for (const eol of ['\n', '\r\n']) {
      const home = mkdtempSync(join(tmpdir(), 'cc-seed-'));
      seed(home, 'zh');
      const constitution = join(home, DEPLOYMENT, 'workspace', 'CONSTITUTION.md');
      writeFileSync(constitution, SEED_0_1_1.replaceAll('\n', eol));
      seed(home, 'zh');
      expect(readFileSync(constitution, 'utf8')).toContain('「库...」');
    }
  });

  it('replaces a self-description still exactly as 0.2.4 shipped it with the current one', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-seed-'));
    seed(home, 'zh');
    const constitution = join(home, DEPLOYMENT, 'workspace', 'CONSTITUTION.md');
    writeFileSync(constitution, SEED_0_2_4);
    seed(home, 'zh');
    expect(readFileSync(constitution, 'utf8')).toBe(readFileSync(personaFile('coo', 'zh'), 'utf8'));
  });

  it('seeds Coo’s operating rules and moves a pre-Hindsight memory section forward', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-seed-'));
    seed(home, 'zh');
    const file = join(home, DEPLOYMENT, 'prompts', 'ORIENTATION.md');
    expect(readFileSync(file, 'utf8')).toContain('Hindsight');
    const old = `# 基础运行约定

## 记忆

每次开新的 session，我醒来时不会记得上一段聊天的原话，但我会读工作区里的记忆文件：使用者档案（PARTNER.md）、Memory，以及我自己写下的东西。那些就是我，不是别人递给我的资料。
不确定以前发生过什么，我先去翻文件，不猜、不编。翻不到就承认忘了，别扭一下，然后问。

## 自定义

保留这一段。`;
    writeFileSync(file, old);
    seed(home, 'zh');
    const next = readFileSync(file, 'utf8');
    expect(next).toContain('memory_search');
    expect(next).toContain('## 自定义');
    expect(next).toContain('保留这一段。');
    expect(next).not.toContain('但我会读工作区里的记忆文件');
  });

  it('seeds the inner-life files and leaves a self the person or Coo wrote alone', () => {
    for (const [language, selfText, marker] of [
      ['zh', '现在的我', '## 自己的念头与自我迭代'],
      ['en', '## Now', '## Inner life and self-review'],
    ] as const) {
      const home = mkdtempSync(join(tmpdir(), 'cc-seed-'));
      seed(home, language);
      const workspace = join(home, DEPLOYMENT, 'workspace');
      for (const file of ['SELF.md', 'SELF.history.md', 'agenda/now.md', 'mind/README.md', 'mind/now.md', 'mind/intentions.md', 'self-review/README.md', 'self-review/TEMPLATE.md']) {
        expect(existsSync(join(workspace, file)), file).toBe(true);
      }
      expect(readFileSync(join(workspace, 'SELF.md'), 'utf8')).toContain(selfText);
      expect(readFileSync(join(home, DEPLOYMENT, 'prompts', 'ORIENTATION.md'), 'utf8')).toContain(marker);
      writeFileSync(join(workspace, 'SELF.md'), '# mine');
      seed(home, language);
      expect(readFileSync(join(workspace, 'SELF.md'), 'utf8')).toBe('# mine');
    }
  });

  it('adds the inner-life rules to an existing ORIENTATION once', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-seed-'));
    seed(home, 'zh');
    const file = join(home, DEPLOYMENT, 'prompts', 'ORIENTATION.md');
    const marker = '## 自己的念头与自我迭代';
    const full = readFileSync(file, 'utf8');
    expect(full).toContain(marker);
    expect(full).toContain('self-review/README.md');
    writeFileSync(file, `${full.slice(0, full.indexOf(marker)).trimEnd()}\n`);
    seed(home, 'zh');
    const next = readFileSync(file, 'utf8');
    expect(next).toContain(marker);
    expect(next).toContain('self-review/README.md');
    seed(home, 'zh');
    expect(readFileSync(file, 'utf8')).toBe(next);
  });

  it('moves an existing affinity note to the felt-sense wording once', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-seed-'));
    seed(home, 'zh');
    const file = join(home, DEPLOYMENT, 'prompts', 'ORIENTATION.md');
    const old = '- 好感度：由 affinity 扩展维护。回话前用 affinity_get 查分数、档位、关系格子和还没过去的情绪；发生值得记的事，用 affinity_adjust 记一笔，写清为什么；关系格子用 affinity_slot。分数变动会自动写进长期记忆，你不需要再记一遍。';
    const full = readFileSync(file, 'utf8');
    expect(full).toContain('affinity_feel');
    writeFileSync(file, full.replace('- 好感度：由 affinity 扩展维护。回话前用 affinity_get 感受你们现在的关系、你心里那股劲和还没过去的事；数字是账本，不给你看。心里有新动静用 affinity_feel 记，事情过去了用 affinity_repair；只调远近用 affinity_adjust，关系格子用 affinity_slot。变化会自动写进长期记忆，你不需要再记一遍。', old));
    seed(home, 'zh');
    const next = readFileSync(file, 'utf8');
    expect(next).toContain('affinity_feel');
    expect(next).not.toContain('查分数、档位');
    seed(home, 'zh');
    expect(readFileSync(file, 'utf8')).toBe(next);
  });

  it('seeds the effective Hindsight settings into config.json once', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-seed-'));
    seed(home, 'zh');
    const deploy = join(home, DEPLOYMENT);
    const cfg = join(deploy, 'config.json');
    writeFileSync(join(deploy, 'hindsight.json'), JSON.stringify({
      enabled: true,
      apiUrl: 'http://127.0.0.1:9999',
      bankId: 'coopanion:seed-test',
      recall: { maxTokens: 1100, timeoutMs: 700 },
      affection: { enabled: false },
    }));
    seed(home, 'zh');
    expect(read(cfg).hindsight).toEqual({
      enabled: true,
      autostart: false,
      apiUrl: 'http://127.0.0.1:9999',
      bankId: 'coopanion:seed-test',
      recall: { maxTokens: 1100, timeoutMs: 700 },
      affection: { enabled: false },
    });
    const current = read(cfg);
    writeFileSync(cfg, JSON.stringify({ ...current, hindsight: { ...(current.hindsight as Record<string, unknown>), enabled: false } }));
    seed(home, 'zh');
    expect((read(cfg).hindsight as Record<string, unknown>).enabled).toBe(false);
  });

  it('ships every persona in every app language, each told apart from the others', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cc-persona-'));
    for (const id of PERSONAS) for (const language of LANGUAGES) {
      applyPersona(workspace, id, language);
      expect(personaOf(workspace)).toBe(id);
    }
  });

  it('seeds the self-description in the app language and swaps it for the same persona on a language change only while it is unedited', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-seed-'));
    mkdirSync(join(home, DEPLOYMENT));
    const cfg = join(home, DEPLOYMENT, 'config.json');
    const constitution = join(home, DEPLOYMENT, 'workspace', 'CONSTITUTION.md');
    const shipped = (id: 'coo' | 'winter', language: 'zh' | 'ja' | 'zh-Hant') => readFileSync(personaFile(id, language), 'utf8');
    writeFileSync(cfg, JSON.stringify({ language: 'ja' }));
    seed(home, 'zh');
    expect(readFileSync(constitution, 'utf8')).toBe(shipped('coo', 'ja'));
    applyPersona(join(home, DEPLOYMENT, 'workspace'), 'winter', 'ja');
    writeFileSync(cfg, JSON.stringify({ language: 'zh-Hant' }));
    seed(home, 'zh');
    expect(readFileSync(constitution, 'utf8')).toBe(shipped('winter', 'zh-Hant'));
    writeFileSync(cfg, JSON.stringify({ language: 'zh' }));
    seed(home, 'zh');
    const edited = `${shipped('winter', 'zh')}\n我喜欢猫。\n`;
    writeFileSync(constitution, edited);
    writeFileSync(cfg, JSON.stringify({ language: 'en' }));
    seed(home, 'zh');
    expect(readFileSync(constitution, 'utf8')).toBe(edited);
  });

  it('moves endpoints of the old deepseek module to coo and leaves other modules alone', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-seed-'));
    seed(home, 'zh');
    const endpoint = join(home, 'providers', endpointName(firstVendor('zh'), defaultRegion('zh')), 'config.json');
    const old = { ...read(endpoint), kind: 'deepseek', spec: { model: 'deepseek-v4-pro' } };
    writeFileSync(endpoint, JSON.stringify(old));
    const other = join(home, 'providers', 'mine', 'config.json');
    mkdirSync(join(home, 'providers', 'mine'));
    writeFileSync(other, JSON.stringify({ kind: 'openai-compatible', baseUrl: 'http://x' }));
    seed(home, 'zh');
    expect(read(endpoint)).toEqual({ ...old, kind: 'coo' });
    expect(read(other)).toEqual({ kind: 'openai-compatible', baseUrl: 'http://x' });
  });

  it('leaves files the operator already has', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-seed-'));
    seed(home, 'zh');
    const cfg = join(home, DEPLOYMENT, 'config.json');
    writeFileSync(cfg, JSON.stringify({ displayName: 'mine' }));
    const constitution = join(home, DEPLOYMENT, 'workspace', 'CONSTITUTION.md');
    writeFileSync(constitution, '# 我自己写的');
    seed(home, 'zh');
    // a config from before new installs got a computer-use `permission` keeps the default it had
    expect(read(cfg)).toEqual({ displayName: 'mine', worlds: { 'desktop-pet': { cua: { permission: 'ask-each-turn' } } } });
    expect(readFileSync(constitution, 'utf8')).toBe('# 我自己写的');
  });

  it('moves computer use from its own World into the desktop pet, whether it was on and how it asks included', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-seed-'));
    seed(home, 'zh');
    const cfg = join(home, DEPLOYMENT, 'config.json');
    const cua = { enabled: true, permission: 'never-ask', grantMinutes: 90, screenshot: { quality: 60 } };
    writeFileSync(cfg, JSON.stringify({ displayName: 'mine', worlds: { cua, 'desktop-pet': { roam: 'off' } } }));
    seed(home, 'zh');
    expect(read(cfg)).toEqual({ displayName: 'mine', worlds: { 'desktop-pet': { roam: 'off', cua } } });
    // an old config without its asking level keeps the default it had then
    writeFileSync(cfg, JSON.stringify({ worlds: { cua: { enabled: true } } }));
    seed(home, 'zh');
    expect(read(cfg)).toEqual({ worlds: { 'desktop-pet': { cua: { enabled: true, permission: 'ask-each-turn' } } } });
  });

  it('moves the terminal World, its prompt override and the console log level to the names Cortico 0.2.0 gave them', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-seed-'));
    seed(home, 'zh');
    const deploy = join(home, DEPLOYMENT);
    const cfg = join(deploy, 'config.json');
    const pet = { cua: { permission: 'ask-once' } };
    writeFileSync(cfg, JSON.stringify({ worlds: { terminal: { enabled: true, pin: '123456' }, 'desktop-pet': pet }, logging: { file: 'debug', console: 'warn' } }));
    mkdirSync(join(deploy, 'worlds', 'terminal'), { recursive: true });
    writeFileSync(join(deploy, 'worlds', 'terminal', 'ENV_PROMPT.md'), 'mine');
    seed(home, 'zh');
    expect(read(cfg)).toEqual({ worlds: { 'desktop-pet': pet, [CONSOLE.id]: { enabled: true, pin: '123456' } }, logging: { file: 'debug', stdout: 'warn' } });
    expect(readFileSync(join(deploy, 'worlds', CONSOLE.id, 'ENV_PROMPT.md'), 'utf8')).toBe('mine');
    // a key already under the new name wins over the old one
    writeFileSync(cfg, JSON.stringify({ worlds: { terminal: { enabled: true, pin: '' }, [CONSOLE.id]: { pin: '654321' }, 'desktop-pet': pet }, logging: { console: 'warn', stdout: 'error' } }));
    seed(home, 'zh');
    expect(read(cfg)).toEqual({ worlds: { [CONSOLE.id]: { enabled: true, pin: '654321' }, 'desktop-pet': pet }, logging: { stdout: 'error' } });
  });
});
