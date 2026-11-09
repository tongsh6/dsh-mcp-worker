#!/usr/bin/env node
/**
 * 目标达成率测量：leader（Claude Code / Codex）通过 dsh-mcp-worker 后，
 * 是否真的「更快 + 更省 leader token/额度」。
 *
 * 子命令：
 *   ab       同一任务跑两次（leader 自己做 vs leader 委派 dsh worker），输出对比与达成率
 *   help
 *
 * 用法示例：
 *   node scripts/measure-goals.mjs ab --cwd D:\work\repo --task "分析 src 目录里最大的 3 个文件并给出摘要"
 *   node scripts/measure-goals.mjs ab --cwd ... --task-file task.md --runs 3 --target-speedup 1.3 --target-token-saving 0.3
 *
 * 说明：
 * - 仅自动测量 Claude Code（`claude -p --output-format json` 会返回 usage/cost/duration）；
 * - Codex 的持续用量可用 scripts/leader-usage.mjs 从 rollout 日志聚合；
 * - 任务建议用「只读分析类」，baseline 与委派都允许同一组 leader 工具（Read/Glob/Grep）。
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DSH_WORKER = join(ROOT, 'dist', 'index.js');

const HELP = `用法：node scripts/measure-goals.mjs <ab|help> [选项]

ab 选项：
  --task <文本>              要测的任务（与 --task-file 二选一）
  --task-file <路径>         从文件读取任务
  --cwd <目录>               执行目录（默认当前目录）
  --runs <n>                 每个模式重复次数，默认 1
  --out <目录>               结果目录，默认 <cwd>/measure-runs
  --tasks-dir <目录>         worker 任务落盘目录，默认 $USERPROFILE/.dsh/mcp-tasks
  --target-speedup <倍数>    目标加速比（solo/delegated 墙钟），默认 1.3
  --target-token-saving <0-1> 目标 leader token 节省率，默认 0.3
  --expect <文本>            正确性守门：两次输出都必须包含该文本才算通过
  --timeout-min <分钟>       单次运行超时，默认 20

示例：
  node scripts/measure-goals.mjs ab --cwd D:\\work\\repo --task "统计 src 下 ts 文件数量并列出前 10 个"
`;

function parseArgs(argv) {
  const options = { runs: 1, targetSpeedup: 1.3, targetTokenSaving: 0.3, timeoutMin: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => argv[++index];
    switch (flag) {
      case '--task': options.task = next(); break;
      case '--task-file': options.taskFile = next(); break;
      case '--cwd': options.cwd = next(); break;
      case '--runs': options.runs = Number(next()); break;
      case '--out': options.out = next(); break;
      case '--tasks-dir': options.tasksDir = next(); break;
      case '--target-speedup': options.targetSpeedup = Number(next()); break;
      case '--target-token-saving': options.targetTokenSaving = Number(next()); break;
      case '--timeout-min': options.timeoutMin = Number(next()); break;
      case '--expect': options.expect = next(); break;
      default:
        if (flag.startsWith('--')) throw new Error(`未知参数：${flag}`);
    }
  }
  return options;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

async function runClaude({ prompt, cwd, mcpConfig, allowedTools, timeoutMs }) {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--allowedTools',
    ...allowedTools,
  ];
  const started = Date.now();
  const { stdout } = await execFileAsync('claude', args, {
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const wallMs = Date.now() - started;
  const json = extractResultJson(stdout);
  return { wallMs, result: json };
}

function extractResultJson(stdout) {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object' && parsed.type === 'result') return parsed;
    } catch {
      // 继续向前找
    }
  }
  throw new Error('无法从 claude 输出中解析 --output-format json 结果');
}

/** 从 worker 任务落盘里统计委派窗口内的 DSH 侧 token 与任务数。 */
async function scanWorkerTasks(tasksDir, fromMs, toMs) {
  const summary = { tasks: 0, succeeded: 0, failed: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 } };
  const entries = await readdir(tasksDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(await readFile(join(tasksDir, entry.name, 'meta.json'), 'utf8'));
      const created = Number(meta.createdAt ?? 0);
      if (created < fromMs || created > toMs) continue;
      summary.tasks += 1;
      if (meta.status === 'succeeded') summary.succeeded += 1;
      if (meta.status === 'failed') summary.failed += 1;
      const usage = meta.usageTokens;
      if (usage) {
        summary.tokens.input += usage.inputTokens ?? 0;
        summary.tokens.output += usage.outputTokens ?? 0;
        summary.tokens.cache_read += usage.cacheReadTokens ?? 0;
        summary.tokens.cache_write += usage.cacheWriteTokens ?? 0;
        summary.tokens.total += usage.totalTokens ?? 0;
      }
    } catch {
      // 忽略损坏/被清理的任务目录
    }
  }
  return summary;
}

function leaderTokens(result) {
  const usage = result.usage ?? {};
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    input,
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    total: input + output + cacheWrite,
    cost_usd: Number(result.total_cost_usd ?? 0),
  };
}

function comparePair(pair, expectText) {
  const solo = leaderTokens(pair.solo.result);
  const delegated = leaderTokens(pair.delegated.result);
  const speedup = pair.delegated.wallMs > 0 ? pair.solo.wallMs / pair.delegated.wallMs : null;
  const tokenSaving = solo.total > 0 ? 1 - delegated.total / solo.total : null;
  const costSaving = solo.cost_usd > 0 ? 1 - delegated.cost_usd / solo.cost_usd : null;
  const savedLeaderTokens = solo.total - delegated.total;
  const dshTokensPerSavedLeaderToken =
    savedLeaderTokens > 0 && pair.worker ? pair.worker.tokens.total / savedLeaderTokens : null;
  const check = (result) => (expectText ? String(result.result ?? '').includes(expectText) : null);
  return {
    solo,
    delegated,
    speedup,
    tokenSaving,
    costSaving,
    correctnessSolo: check(pair.solo.result),
    correctnessDelegated: check(pair.delegated.result),
    dshTokensPerSavedLeaderToken,
  };
}

async function commandAb(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const task = options.task ?? (options.taskFile ? (await readFile(options.taskFile, 'utf8')).trim() : '');
  if (!task) throw new Error('缺少 --task 或 --task-file');
  const runs = Math.max(1, Math.min(10, Math.trunc(options.runs)));
  const outDir = resolve(options.out ?? join(cwd, 'measure-runs'));
  const tasksDir = resolve(options.tasksDir ?? join(homedir(), '.dsh', 'mcp-tasks'));
  const timeoutMs = Math.max(1, options.timeoutMin) * 60_000;
  await mkdir(outDir, { recursive: true });

  const emptyConfig = join(outDir, 'mcp-empty.json');
  const dshConfig = join(outDir, 'mcp-dsh.json');
  await writeFile(emptyConfig, JSON.stringify({ mcpServers: {} }, null, 2));
  await writeFile(
    dshConfig,
    JSON.stringify(
      {
        mcpServers: {
          dsh: {
            type: 'stdio',
            command: process.execPath,
            args: [DSH_WORKER],
            env: { DSH_MCP_DEFAULT_CWD: cwd },
          },
        },
      },
      null,
      2,
    ),
  );

  const baseTools = ['Read', 'Glob', 'Grep'];
  const delegationHint =
    '\n\n【执行要求】请把主体工作交给 dsh worker：先用 mcp__dsh__dsh_run 提交任务，再用 mcp__dsh__dsh_status 轮询到结束，最后用 mcp__dsh__dsh_result 取结果；不要自己逐步执行。';

  const rows = [];
  for (let run = 1; run <= runs; run += 1) {
    process.stdout.write(`[measure] run ${run}/${runs}：leader 自己做（baseline）…\n`);
    const solo = await runClaude({ prompt: task, cwd, mcpConfig: emptyConfig, allowedTools: baseTools, timeoutMs });
    await writeFile(join(outDir, `${Date.now()}-solo-${run}.json`), JSON.stringify({ mode: 'solo', task, cwd, ...solo }, null, 2));
    process.stdout.write(`[measure] run ${run}/${runs}：leader 委派 dsh worker…\n`);
    const delegatedStart = Date.now();
    const delegated = await runClaude({
      prompt: `${task}${delegationHint}`,
      cwd,
      mcpConfig: dshConfig,
      allowedTools: [...baseTools, 'mcp__dsh__dsh_run', 'mcp__dsh__dsh_status', 'mcp__dsh__dsh_result'],
      timeoutMs,
    });
    const delegatedEnd = Date.now();
    const worker = await scanWorkerTasks(tasksDir, delegatedStart - 5_000, delegatedEnd + 30_000);
    await writeFile(
      join(outDir, `${Date.now()}-delegated-${run}.json`),
      JSON.stringify({ mode: 'delegated', task, cwd, worker, ...delegated }, null, 2),
    );
    rows.push({ run, solo, delegated, worker });
  }

  const comparisons = rows.map((row) => ({ run: row.run, worker: row.worker, ...comparePair(row, options.expect) }));
  const speedups = comparisons.map((item) => item.speedup).filter((value) => typeof value === 'number');
  const savings = comparisons.map((item) => item.tokenSaving).filter((value) => typeof value === 'number');
  const avgSpeedup = speedups.length ? speedups.reduce((sum, value) => sum + value, 0) / speedups.length : null;
  const avgTokenSaving = savings.length ? savings.reduce((sum, value) => sum + value, 0) / savings.length : null;
  const speedAchieved = avgSpeedup !== null && avgSpeedup >= options.targetSpeedup;
  const tokenAchieved = avgTokenSaving !== null && avgTokenSaving >= options.targetTokenSaving;
  const correctnessAchieved = options.expect
    ? comparisons.every((item) => item.correctnessSolo === true && item.correctnessDelegated === true)
    : null;
  const achievedCount = [speedAchieved, tokenAchieved, correctnessAchieved].filter((value) => value === true).length;
  const totalKpi = options.expect ? 3 : 2;

  const lines = [];
  lines.push('# DSH worker 目标达成率测量');
  lines.push('');
  lines.push(`- 任务：${task.split('\n')[0].slice(0, 120)}`);
  lines.push(`- 目录：${cwd}`);
  lines.push(`- 重复次数：${runs}`);
  lines.push(
    `- 目标：加速 ≥ ${options.targetSpeedup}x；leader token 节省 ≥ ${pct(options.targetTokenSaving)}${
      options.expect ? `；正确性守门 = 输出必须包含「${options.expect}」` : ''
    }`,
  );
  lines.push('');
  lines.push(
    `| run | leader 墙钟 solo/delegated | 加速比 | leader token solo/delegated | token 节省 | cost 节省 | 正确性 solo/deleg | DSH 任务数 | DSH token | DSH token/省下 leader token |`,
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const item of comparisons) {
    const row = rows.find((candidate) => candidate.run === item.run);
    lines.push(
      `| ${item.run} | ${row.solo.wallMs}ms / ${row.delegated.wallMs}ms | ${item.speedup?.toFixed(2) ?? 'n/a'}x | ${item.solo.total} / ${item.delegated.total} | ${
        item.tokenSaving === null ? 'n/a' : pct(item.tokenSaving)
      } | ${item.costSaving === null ? 'n/a' : pct(item.costSaving)} | ${
        options.expect ? `${item.correctnessSolo ? '✅' : '❌'} / ${item.correctnessDelegated ? '✅' : '❌'}` : 'n/a'
      } | ${item.worker.tasks} | ${item.worker.tokens.total} | ${
        item.dshTokensPerSavedLeaderToken === null ? 'n/a' : item.dshTokensPerSavedLeaderToken.toFixed(2)
      } |`,
    );
  }
  lines.push('');
  lines.push(`- 平均加速比：**${avgSpeedup === null ? 'n/a' : `${avgSpeedup.toFixed(2)}x`}**（目标 ${options.targetSpeedup}x，${speedAchieved ? '✅ 达标' : '❌ 未达标'}）`);
  lines.push(`- 平均 leader token 节省：**${avgTokenSaving === null ? 'n/a' : pct(avgTokenSaving)}**（目标 ${pct(options.targetTokenSaving)}，${tokenAchieved ? '✅ 达标' : '❌ 未达标'}）`);
  if (options.expect) {
    lines.push(`- 正确性守门：**${correctnessAchieved ? '✅ 通过' : '❌ 未通过'}**（两次输出都需包含「${options.expect}」）`);
  }
  lines.push(`- 目标达成率：**${achievedCount}/${totalKpi}**`);
  lines.push('');
  lines.push('> 注：leader token = input + output + cache_write（cache_read 单独记录，通常单价低）；cost 来自 Claude Code 返回的 total_cost_usd。');
  lines.push('> DSH token 为 worker 侧消耗，属 DeepSeek 额度；「DSH token/省下 leader token」用于判断用便宜额度换贵额度是否划算（越小越划算）。');

  const report = lines.join('\n');
  const reportPath = join(outDir, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  await writeFile(reportPath, report);
  process.stdout.write(`${report}\n\n[measure] 报告已写入：${reportPath}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(HELP);
    return;
  }
  if (command !== 'ab') throw new Error(`未知子命令：${command}`);
  await commandAb(parseArgs(rest));
}

main().catch((error) => {
  process.stderr.write(`[measure] 失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
