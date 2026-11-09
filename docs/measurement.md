# 目标达成率测量：leader 提速 & 省 token/额度

> 目标前提：**Codex/ChatGPT、Claude Code 是 leader**，通过 `dsh-mcp-worker` 把重活交给 DSH（DeepSeek）执行。
> 要核对的两件事：① leader 是否更快；② leader 是否更省 token/额度。附带守门项：正确性不能变差。

---

## 1. 指标与公式

| 目标 | 指标 | 公式 | 数据来源 |
|---|---|---|---|
| 提速 | 加速比 | `T_solo / T_delegated`（leader 墙钟） | A/B 工具实测 |
| 提速 | 时间节省率 | `1 − T_delegated / T_solo` | 同上 |
| 省额度 | leader token 节省率 | `1 − L_delegated / L_solo`，`L = input + output + cache_write` | Claude Code `-p --output-format json` 的 `usage`；Codex rollout 的 `token_usage_record` |
| 省额度 | leader 成本节省率 | `1 − cost_delegated / cost_solo`（`total_cost_usd`） | Claude Code JSON 返回值 |
| 划算度 | DSH token / 省下 leader token | `T_dsh / (L_solo − L_delegated)`，**越小越划算** | worker 任务 `usageTokens` + A/B 差值 |
| 守门 | 正确性 | 两次输出都包含 `--expect` 断言文本；或人工抽检 | A/B `--expect` / 人工 |
| 达成率 | KPI 达标率 | `达标 KPI 数 / KPI 总数`（默认 2 项；带 `--expect` 为 3 项） | 工具输出的报告 |

口径说明：
- `cache_read` 单独记录、通常单价很低，不计入 `L`，但在报告里保留原始值供核对。
- DSH token 属 DeepSeek 额度，与 leader 额度是两本账；**不要相加**，看「换算比」和各自成本。
- leader 侧「额度」在不同套餐下含义不同（Claude 是 cost_usd / 限额，Codex 是 rate-limit 百分比），成本节省率是跨套餐最接近的代理指标。

---

## 2. 基线 A/B 协议（推荐）

1. **任务集**：≥ 5 个真实任务，至少覆盖三类，每类 ≥ 1 个：
   - 只读分析（查代码、总结、定位 bug）；
   - 跨文件改码（小重构、加功能）；
   - 跑测试/修失败（需要 shell）。
2. **固定环境**：同一 repo、同一 commit/分支；写操作类任务用独立 worktree 或分支，A/B 各跑一次后丢弃。
3. **同一 prompt**；委派组在 prompt 末尾加固定指令（A/B 工具会自动加）：
   > 请把主体工作交给 dsh worker：先 `dsh_run` 提交，再 `dsh_status` 轮询，最后 `dsh_result` 取结果；不要自己逐步执行。
4. **重复次数**：每任务 `--runs 3`，看均值/中位数，单次方差很大。
5. **正确性断言**：能给断言就给（如输出包含某文件名、测试通过、目标文件生成），用 `--expect`。
6. **记录**：每次运行会保存 `measure-runs/*-solo-*.json` / `*-delegated-*.json` 与 `report-*.md`。

---

## 3. 怎么跑

```powershell
# A/B 对照（Claude Code 自动计量；会真实消耗 leader 额度，建议先小任务试跑）
cd D:\github\dsh-mcp-worker
node scripts/measure-goals.mjs ab `
  --cwd D:\work\your-repo `
  --task "统计 src 下 .ts 文件数量并列出最大的 3 个（只读分析，不要改文件）" `
  --runs 3 `
  --expect "src" `
  --target-speedup 1.3 --target-token-saving 0.3

# 持续观察（不跑基准，直接扫 leader 自己的会话用量）
node scripts/leader-usage.mjs --since-hours 24
node scripts/leader-usage.mjs --since-hours 24 --cwd-filter worklog --json

# worker 侧视角（DSH token、任务耗时、成功率）
# 在 leader 里调用 dsh_metrics / dsh_tasks
```

报告里会输出：每次 run 的墙钟、加速比、leader token、节省率、cost 节省、正确性、DSH 任务数/token、DSH token/省下 leader token，以及「目标达成率 x/2 或 x/3」。

---

## 4. 现状实测（2026-11-02，单次样本，仅作方法验证）

任务：`统计 src 下 .ts 文件数量并列出最大的 3 个（只读分析）`，cwd = dsh-mcp-worker 仓库。

| 指标 | solo（leader 自己做） | delegated（委派 DSH） | 结果 |
|---|---|---|---|
| leader 墙钟 | 156,050 ms | 68,251 ms | **加速 2.29x** |
| leader token（input+output+cache_write） | 28,954 | 15,644 | **省 46.0%** |
| leader cost | — | — | **省 31.1%** |
| DSH 任务 / token | — | 1 / 249,239 | DSH token / 省下 leader token ≈ **18.7** |
| 达成率 | — | — | **2/2（加速 ✅、省 token ✅）** |

> 单次样本只能证明「方法可用 + 该任务类型上有收益」；DSH token 比 leader 省下的 token 多（18.7 倍）是正常的——两边单价不同，结论要看 `cost` 与额度账。要形成结论请按第 2 节跑 ≥5 任务 × 3 次的基线集。

---

## 5. 局限（如实说明）

1. **A/B 自动化目前只覆盖 Claude Code**：它 `-p --output-format json` 直接返回 usage/cost/duration。
   Codex 可用 `scripts/leader-usage.mjs` 从 `~/.codex/sessions/**/rollout-*.jsonl` 聚合（token 真值），
   但「同任务 A/B」需要手动跑 `codex exec` 两次再对比。
2. **ChatGPT web 无法本地计量**：没有本地会话日志，只能看 API/订阅用量面板或人工记录，暂不纳入自动测量。
3. **正确性只能抽检**：`--expect` 是粗断言；建议对失败/返工任务人工复核，并记录「返工率」。
4. **方差**：单任务单次差异可能来自缓存命中、模型波动、任务理解差异；必须多次 + 多任务。
5. **任务类型影响巨大**：只读分析类委派收益最大；强交互/频繁确认类可能反而不划算。

---

## 6. 建议的「达成率」验收线

| KPI | 验收线 |
|---|---|
| 加速比（中位数） | ≥ 1.3x |
| leader token 节省率 | ≥ 30% |
| leader cost 节省率 | ≥ 20% |
| 正确性守门 | 达标率 100%（有断言时）；失败必须复核 |
| DSH token / 省下 leader token | 记录并观察，结合两边单价折算成本比 |
