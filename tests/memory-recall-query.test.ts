import { describe, expect, it } from 'vitest';
import { planRecallQueries } from '../core/memory/recall-query.ts';

const normalized = (value: string) => value.replace(/[的\s，、：:；;。？！?]/gu, '').toLocaleLowerCase();

const cases = [
  { name: 'a marked topic before a decision tail', query: '最后关于青岬观测站的夜间巡检，我们决定了什么？', entities: ['青岬观测站'], event: '夜间巡检', intent: '决定' },
  { name: 'a material question after a topic', query: '关于霜林展柜，最终采用哪一种除湿材料？', entities: ['霜林展柜'], event: '除湿', intent: '材料' },
  { name: 'a compound entity before an ordering question', query: '枫港冷库的入库复核应该按照什么顺序进行？', entities: ['枫港冷库'], event: '入库复核', intent: '顺序' },
  { name: 'a result tail after an earlier discussion', query: '之前关于云泽桥照明维护的讨论，最后结果是什么？', entities: ['云泽桥'], event: '照明维护', intent: '结果' },
  { name: 'several background subjects before the final topic', query: '我们先讨论书展，又讨论合唱排练，最后针对南舱标本柜的封存流程确定了什么？', entities: ['南舱标本柜'], event: '封存流程', intent: '确定' },
  { name: 'a penultimate topic clause', query: '去年在例会上，针对雾岭雨量站的校准步骤，我们当时定了什么安排？', entities: ['雾岭雨量站'], event: '校准步骤', intent: '安排' },
  { name: 'an elliptical tail across a sentence boundary', query: '我们之前讨论过银湾灯塔的交接记录。后来呢？', entities: ['银湾灯塔'], event: '交接记录', intent: '后来' },
  { name: 'an aspect marker across a semicolon', query: '在松谷育苗棚的保温方案方面；我们最后采用什么材料？', entities: ['松谷育苗棚'], event: '保温', intent: '材料' },
  { name: 'a topic list before a colon', query: '关于星湾船坞的铆接、喷涂两个工序：最后约定如何处理？', entities: ['星湾船坞'], event: '喷涂', intent: '处理' },
  { name: 'an unpunctuated question', query: '上次关于寒松实验台的清洁步骤最终采用哪一种方案', entities: ['寒松实验台'], event: '清洁步骤', intent: '方案' },
  { name: 'two relevant entities', query: '我们之前提过苔原观测点和云谷观测点的校准记录；最终谁负责？', entities: ['苔原观测点', '云谷观测点'], event: '校准记录', intent: '负责' },
  { name: 'repeated background terms before a late topic', query: `${'会上多次讨论预算、排班、海报和预算调整，'.repeat(5)}最后关于翠峰栈桥的护栏更换，我们采取什么方式？`, entities: ['翠峰栈桥'], event: '护栏更换', intent: '方式' },
  { name: 'a mixed language event', query: '我们之前 reviewed the Hollow Dock sensor logs，最后关于沉潮仓的 backup power，采用什么方式？', entities: ['沉潮仓'], event: 'backup power', intent: '方式' },
  { name: 'a direct entity followed by a generic attribute', query: '悬谷玻璃房使用哪一种材料？', entities: ['悬谷玻璃房'], event: '', intent: '材料' },
  { name: 'an initial marked topic and a nearby intervening clause', query: '关于丹霞索道的检修记录，我们之前又核对了排班，最后决定怎么处理？', entities: ['丹霞索道'], event: '检修记录', intent: '处理' },
  { name: 'two compound subjects in one marked topic', query: '关于冰原器材柜的防潮和月湾样品盒的避光，最终选了什么方案？', entities: ['冰原器材柜', '月湾样品盒'], event: '避光', intent: '方案' },
  { name: 'a correction to a historical time', query: '之前关于星帆合奏室的开场登记，我们最后更正到几点？', entities: ['星帆合奏室'], event: '开场登记', intent: '几点' },
  { name: 'an ordinary use question with its event after the attribute', query: '上次曲泉画室用什么材料装裱？', entities: ['曲泉画室'], event: '装裱', intent: '材料' },
  { name: 'a short ordering predicate', query: '上次砚河排练厅按什么顺序搬运器材？', entities: ['砚河排练厅'], event: '搬运', intent: '顺序' },
];

describe('historical query focus planning', () => {
  it.each(cases)('retains entities, events and question intent for $name', ({ query, entities, event, intent }) => {
    const plan = planRecallQueries(query);
    const sourceText = normalized(plan.sourcePhrases.join(' '));
    const supplementalText = normalized(plan.supplementalQueries.join(' '));
    for (const entity of entities) {
      expect(sourceText, query).toContain(normalized(entity));
      expect(supplementalText, query).toContain(normalized(entity));
    }
    if (event) expect(supplementalText, query).toContain(normalized(event));
    expect(supplementalText, query).toContain(normalized(intent));
    expect(plan.supplementalQueries.length).toBeGreaterThan(0);
    expect(plan.supplementalQueries.every((supplement) => entities.some((entity) => normalized(supplement).includes(normalized(entity)))), query).toBe(true);
    expect(plan.sourcePhrases.some((phrase) => ['材料', '顺序', '方案', '定了', '安排', '使用', '一种', '使用哪一种'].includes(phrase)), query).toBe(false);
    expect(plan.sourcePhrases.length).toBeLessThanOrEqual(4);
    expect(plan.supplementalQueries.length).toBeLessThanOrEqual(2);
    expect(plan.sourcePhrases.every((phrase) => [...phrase].length <= 48)).toBe(true);
    expect(plan.supplementalQueries.every((supplement) => [...supplement].length <= 180)).toBe(true);
  });

  it.each([
    { query: '去年我和海事顾问、岛务组、游客中心、两班志愿者围绕船期、饮水补给、潮汐表、仓库钥匙、照明巡检、恶劣天气预案、设备盘点以及迎检材料开了好几次会，会议前还整理了救生衣清点、海图更新、船员轮班、补给签收、报修单和物资清点表；最后关于海岛气象站备用供电切换顺序，我们当时定了什么安排？', entity: '海岛气象站', event: '备用供电', intent: '顺序' },
    { query: '上个月我和建筑组、档案室、清洁队反复核对了坡道、照明、钥匙、展台、储藏室货架与闭馆流程；后来关于北侧陶板展柜的除湿材料，我们最后决定使用哪一种？', entity: '北侧陶板展柜', event: '除湿', intent: '材料' },
  ])('retains the entity in the exposed Chinese regression: $entity', ({ query, entity, event, intent }) => {
    const plan = planRecallQueries(query);
    expect(normalized(plan.sourcePhrases.join(' '))).toContain(normalized(entity));
    expect(plan.supplementalQueries.every((supplement) => normalized(supplement).includes(normalized(entity)))).toBe(true);
    expect(normalized(plan.supplementalQueries.join(' '))).toContain(normalized(event));
    expect(normalized(plan.supplementalQueries.join(' '))).toContain(normalized(intent));
  });
});
