# Coopanion「大肥鱼」V2.0-R2｜C2-B 最终收口：Codex 执行指令

**任务标识：** `PATCH_C2_B_FINAL_CLOSEOUT_REV20_AMENDMENT01`  
**性质：** 已获用户批准的 Revision 20 兼容合同变更落地 + C2-B 有证据的局部验收收口  
**停止线：** 仅完成 C2-B 最终收口，**不得自动开始 C2-C**。

## 0. 最高优先级合同

用户已明确批准《Revision 20 正式合同补充 01：C2-B SQLite v4 迁移兼容范围》：迁移支持 **合法 empty/v2/v3→v4；严格匹配的 v4 可幂等打开；未知 v1 保持 `v1_unsupported_fail_closed`**，不再要求凭不存在的可核实 v1 DDL 实现 v1→v4。**仅这一条兼容范围修改生效**。原 Revision 20 §0N 其他一切约束原样生效，原始 C2-B 任务书如有冲突，以用户批准的补充合同覆盖其 v1 必迁移条款。**批准合同变更不等于批准 C2-B 测试 PASS**。

执行前务必读取：
1. Revision 20 综合计划 §0N 与本次 `REV20-AMENDMENT-01-C2B-V1-SCOPE`；
2. 《Patch C2 修订02》和本地 C2-B 任务书；
3. `scratch/v2.0-c2-b-sqlite-v4-migration.md`、`scratch/v2.0-c2-b-test-matrix.md`、`scratch/v2.0-c2-b-r-closeout.md`、`scratch/v2.0-c2-b-r-r2-difference-matrix.md`；
4. 唯一 `scratch/v2.0-v1.8.6-regression-matrix.md`。

本对话下载的合同文档不会自动出现在本机。先将其放到 R1 `scratch/`，保留该补充文件且在唯一账本追加正式审批标识，不覆盖历史报告/Revision20 原文。

## 1. 唯一允许施工位置与精确基线

工作树：`/Users/yusu/.codex/worktrees/coopanion-r1-20261028/Default Project`（**包含空格，命令必须正确引用路径**），分支 `codex/r1-20261028`。绝不可操作 `/Users/yusu/Documents/Default Project` 主工作树。

C2-B-R 报告的最后父仓 HEAD 为 `1735fe6919775e2648f33d36381d1b3b74cd48e4`，前一个源码/测试提交 `dffd724d48ea234f7e2de5ac8ae0d1b977aa51c3`；Cortico HEAD 与 gitlink 均为 `049882d48315a42278b33df3b5861271fc110112`。这只是**报告基线**，用实际 `pwd`、`git rev-parse HEAD`、`git status --short`、`git diff --cached --name-only`、`git ls-files --stage vendor/cortico` 和子模块 HEAD 复核。发现未经归因的变化即暂停相关变更，不 reset/clean/stash，不盲目 stage。

四个必须保留的既有工作树 SHA-256：

| 路径 | SHA-256 |
|---|---|
| `core/memory/outbox.ts` | `b7d7a0ff3ebee7b5d3f6271c70df0da3624fc25c25ae1fefefbbedb0a3ce5445` |
| `tests/memory-outbox.test.ts` | `c0be249c12bbbbeb4fde56458a2e528f57bd397076c03b05189aee3f09c3a3b2` |
| `tests/fixtures/temporal-scorer.ts` | `bec119d4c5e9439363c34818b2d191a58ca9929afec0976b8d82162cc362a022` |
| `tests/temporal-scorer.test.ts` | `2d92e88450677ff915897c595d45176900a72c70a57fcb6b50f527392b24cf15` |

冻结 `core/memory/recall-query.ts` SHA-256：`585dc11025402302aff80e5584a2a43f05f02157f548396a6814391936c068af`（工作树与 HEAD blob 均核对）。不能改 Recall planner、Standard/Deep、Top-20/21、预算或排序。

## 2. 本批明确任务（严格按顺序）

### F0｜最小差异与合同登记

- 对照真实提交确认 C2-B SQLite v4 四类表、typed APIs、迁移事务、B01–B12 和 C2-B-R 的 BASE-01/B05 修复仍存在；**不重做**已完成的源码和测试。
- 将本次补充合同加入本地 `scratch/`，以 append-only 方式在唯一回归账本的 R2 后追加 `R2-FINAL-APPROVED-SCOPE`，记载用户批准日期、批准范围、原文条款锚点和未变更部分。
- 原文 Revision20、旧 B02 测试结果和过去 `C2_B_PARTIAL/GATED` 保留作为历史，不静默修改先前状态。

### F1｜B02 重新验收（不是伪造 v1 迁移）

只用测试独占的短命 SQLite：
- 已验证 v2→v4：逐表持久行不变、完整 schema/user_version、quick_check 和 foreign_key_check；
- v1 不支持：未知 v1 marker 被**明确拒绝**，拒绝前后数据库 hash、版本和数据状态不变；绝不把 v2 fixture 改标 v1 来冒充迁移；
- 关联核对 v3→v4（B01）、empty→v4（B03）、v4 重开幂等（B06）。

把新 B02 明确拆为 `B02-SUPPORTED-MIGRATION` 与 `B02-UNSUPPORTED-V1-SAFETY`。两者均有可核查测试名/输出后，才写 `B02=PASS_LOCAL_REVISED_SCOPE`；不能写 `v1→v4 PASS`。任何未知 v1 文件不能被 SQLite 打开初始化流程误认作空库。

### F2｜事务及数据安全复核

复用现有 B04–B12 证据，尤其核实：
- DDL 后/`user_version=4` 写入后、COMMIT 之前两类故障注入均 rollback；重开仍旧版、旧行一致、无新表、可重试；
- 零来源默认 unknown，多父完整 namespace 去重、revision/digest 冲突显式、不得未知升 verified/active；
- SQLite 不储存 Hindsight/Provider 原始正文，现有 PARTNER v1 sidecar 不被迁移破坏；
- v4 重启幂等、schema/外键检查，禁止对生产数据库演示。

若真实代码存在修订合同下的新缺陷，只允许最小定向修复和新测试，并据实际影响范围扩大回归；不能只改状态词凑 PASS。

### F3｜R2 唯一回归账本更新

- `MEM-08`：使用修订后的支持范围重评，准确标 `PASS_LOCAL_REVISED_SCOPE` 或保持 GATED；
- `BASE-01`：保留 C2-B-R 新增 FakeLLM 普通无历史问答的 `PASS_LOCAL`，不能写正式 App 通过；
- `MEM-05` 保持 `PARTIAL`，明确模型推断和未来 domain index 不复活须在 C2-C/Patch D 验证；
- `MEM-06` 保持 `PARTIAL`，明确 current revision 与 activation/mention/temporal 整合仍需专项证据；
- `OPS-01/OPS-03` 按实际 Git/资源测量记录；
- 历史 N3 六题产品 FAIL、N4-S 33/5/4、N6 和 Cortico full-suite 7 FAIL 保留原状态；
- 未做的 R3/C2-01..14、Patch D、W1...W5、N7 保持 NOT_RUN。

**特别注意**：MEM-05/06 的部分覆盖是后续集成门，而不是此次 v1 兼容范围修订能消灭的缺口。若触及现有 revision/activation 数据破坏，须维持 GATED 并汇报真实新回归。

### F4｜低负载复验与资源记录

先用单 worker 运行相关两份存储测试；若仅合同/报告变更，优先复用 C2-B-R 10 文件 183/183 的可追溯历史证据，同时重跑直接受合同改动影响的 B02/B05 所在测试。若存在源码修改或新增回归问题，按实际改动追加 Memory/Persona/Core 影响集，必要时重跑父仓 `pnpm run test`、Worlds 与相关 typecheck；不能把以前的全量结果写成“本轮重跑”。

资源停线持续有效：单 worker；进程 RSS >=1 GiB 或增量 >512 MiB、系统空闲内存 <4 GiB、Swap 增量 >=512 MiB、磁盘可用 <10 GiB 时停止，并写实记录 peak RSS、内存、Swap、磁盘。临时 SQLite 在测试 hook 完成清理，不创建持久副本或第二套 Bank。

### F5｜Git 与报告收口

仅显式路径 staging 和本地提交；不 `git add -A`/`git add .`、reset/clean；四项保护差异绝不暂存/改写；若不需要修改 Cortico，不动其源码和 gitlink。报告包括当前父仓完整 40 字符 HEAD、Cortico gitlink、受保护 SHA、变更/测试命令与真实分母、权限、资源、已清理 fixture 和未通过项。文档中保持“用户批准的合同”与“本机 Codex 实施/验证结果”两个层次分离。

交付至少：
- `scratch/v2.0-revision20-c2-b-compat-amendment-01.md`（正式用户批准合同的本地副本）；
- `scratch/v2.0-c2-b-final-acceptance.md`（B01–B12 按修订合同逐项结论，B02 两子项，明确 R2 结果）；
- `scratch/v2.0-c2-b-final-git-closeout.md`（完整 Git manifest/HEAD/资源/保护项）；
- **追加**唯一 `scratch/v2.0-v1.8.6-regression-matrix.md` 的 `R2-FINAL-APPROVED-SCOPE`，不创建第二份权威账本。

## 3. 裁定规则与工作完成后的停止条件

**只有全部满足，才可以由本机报告 `C2_B_FOCUSED_PASS_LOCAL`：**

1. 已批准的补充合同真实登记，且明确仅覆盖 v1 迁移兼容范围；
2. B01–B12 在修订后的接受定义下有逐项可追踪证据；B02 的已支持 v2 迁移与未知 v1 fail-closed 两项分别成立；
3. v3/empty/v4、旧记录、事务故障回滚、重启、namespace、zero/multi-parent/unknown、状态和 sidecar 都不退化；
4. R2 未发现新的相关安全或数据完整性回归；MEM-05/06 的既有 PARTIAL 和后续责任保留；
5. Git/保护文件/Recall、资源、权限边界及报告交付均完整。

否则报告 `C2_B_PARTIAL/GATED` 和具体失败/未覆盖项，绝不通过修改测试文字、覆盖历史失败或伪造旧 DDL 来达到 PASS。对外陈述时仍应标记为**本地/合成范围**，不是正式产品验收。

**完成以上工作后立即停止。** 不得自动实施 C2-C 的 `retainCoo`、`pet_say/pet_ask`、PARTNER、Growth/Experience derived consumer、Forget/revision 图传播、C2-01...C2-14；更不得开始 SQLite v5、AutoDomainAssign、DomainRelevantRead、W1 实体数据、W4 旧笔记删除或 N7。

用户已表示项目顺序为“C2-B 收口后再进入 C2-C”，本指令因此只授权**当前这一批**。把源码、报告和证据交回审查，待确认 C2-B 局部通过后再领取 C2-C 独立任务书。
