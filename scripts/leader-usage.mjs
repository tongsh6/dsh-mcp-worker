#!/usr/bin/env node
/**
 * 扫描 leader 自己的用量日志，统计「时间 + token + dsh 调用次数」，
 * 用于不额外跑基准时的持续观察（Claude Code transcripts + Codex rollouts）。
 *
 * 用法：
 *   node scripts/leader-usage.mjs [--since-hours 24] [--cwd-filter <子串>] [--json]
 *
 * 数据来源：
 * - Claude Code：~/.claude/projects/<encoded-cwd>/<session>.jsonl（assistant 消息带 message.usage）
 * - Codex：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（token_usage_record / event_msg.token_count）
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

function parseArgs(argv) {
  const options = { sinceHours: 24, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--since-hours') options.sinceHours = Number(argv[++index]);
    else if (flag === '--cwd-filter') options.cwdFilter = argv[++index];
    else if (flag === '--json') options.json = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`未知参数：${flag}`);
  }
  return options;
}

async function walkFiles(root, suffix) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(suffix)) files.push(full);
    }
  }
  await walk(root);
  return files;
}

function countOccurrences(text, needle) {
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

async function scanClaude(sinceMs, cwdFilter) {
  const root = join(homedir(), '.claude', 'projects');
  const rows = [];
  for (const file of await walkFiles(root, '.jsonl')) {
    const info = await stat(file).catch(() => null);
    if (!info || info.mtimeMs < sinceMs) continue;
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    let assistantTurns = 0;
    let firstTs = null;
    let lastTs = null;
    const models = new Set();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const timestamp = record.timestamp ? Date.parse(record.timestamp) : null;
      if (timestamp) {
        firstTs = firstTs === null ? timestamp : Math.min(firstTs, timestamp);
        lastTs = lastTs === null ? timestamp : Math.max(lastTs, timestamp);
      }
      if (record.type !== 'assistant' || !record.message) continue;
      assistantTurns += 1;
      if (record.message.model) models.add(record.message.model);
      const usage = record.message.usage;
      if (!usage) continue;
      tokens.input += usage.input_tokens ?? 0;
      tokens.output += usage.output_tokens ?? 0;
      tokens.cache_read += usage.cache_read_input_tokens ?? 0;
      tokens.cache_write += usage.cache_creation_input_tokens ?? 0;
    }
    const dshCalls = countOccurrences(raw, 'mcp__dsh__');
    const cwd = file.replace(root, '').replace(/\\/g, '/').split('/')[1] ?? '';
    if (cwdFilter && !cwd.includes(cwdFilter)) continue;
    if (assistantTurns === 0) continue;
    rows.push({
      source: 'claude',
      session: file.replace(/\\/g, '/').split('/').pop().replace('.jsonl', ''),
      cwd,
      models: [...models].join(','),
      assistantTurns,
      dshCalls,
      durationMin: firstTs && lastTs ? Math.round((lastTs - firstTs) / 6000) / 10 : null,
      tokens: { ...tokens, total: tokens.input + tokens.output + tokens.cache_write },
      costUsd: null,
    });
  }
  return rows;
}

async function scanCodex(sinceMs, cwdFilter) {
  const root = join(homedir(), '.codex', 'sessions');
  const rows = [];
  for (const file of await walkFiles(root, '.jsonl')) {
    const info = await stat(file).catch(() => null);
    if (!info || info.mtimeMs < sinceMs) continue;
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    let cwd = '';
    let session = '';
    let firstTs = null;
    let lastTs = null;
    let tokens = null;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const timestamp = record.timestamp ? Date.parse(record.timestamp) : null;
      if (timestamp) {
        firstTs = firstTs === null ? timestamp : Math.min(firstTs, timestamp);
        lastTs = lastTs === null ? timestamp : Math.max(lastTs, timestamp);
      }
      if (record.type === 'session_meta' && record.payload) {
        cwd = record.payload.cwd ?? cwd;
        session = record.payload.session_id ?? session;
      }
      if (record.type === 'token_usage_record' && record.payload?.thread_token_usage) {
        const usage = record.payload.thread_token_usage;
        tokens = {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cache_read: usage.cached_input_tokens ?? 0,
          cache_write: usage.cache_write_input_tokens ?? 0,
        };
      }
    }
    if (cwdFilter && !cwd.toLowerCase().includes(cwdFilter.toLowerCase())) continue;
    if (!tokens) continue;
    rows.push({
      source: 'codex',
      session,
      cwd,
      models: 'codex',
      assistantTurns: countOccurrences(raw, '"type":"token_usage_record"'),
      dshCalls: countOccurrences(raw, 'mcp__dsh__'),
      durationMin: firstTs && lastTs ? Math.round((lastTs - firstTs) / 6000) / 10 : null,
      tokens: { ...tokens, total: tokens.input + tokens.output + tokens.cache_write },
      costUsd: null,
    });
  }
  return rows;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('用法：node scripts/leader-usage.mjs [--since-hours 24] [--cwd-filter <子串>] [--json]\n');
    return;
  }
  const sinceMs = Date.now() - Math.max(1, options.sinceHours) * 3600_000;
  const rows = [...(await scanClaude(sinceMs, options.cwdFilter)), ...(await scanCodex(sinceMs, options.cwdFilter))].sort(
    (a, b) => (b.durationMin ?? 0) - (a.durationMin ?? 0),
  );
  if (options.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  process.stdout.write(`最近 ${options.sinceHours}h leader 会话（${rows.length} 个）\n\n`);
  process.stdout.write('| source | session | cwd | 轮次 | dsh 调用 | input | output | cache_read | cache_write | 总 token | 时长 min |\n');
  process.stdout.write('|---|---|---|---|---|---|---|---|---|---|---|\n');
  for (const row of rows) {
    process.stdout.write(
      `| ${row.source} | ${row.session.slice(0, 12)} | ${row.cwd.slice(-40)} | ${row.assistantTurns} | ${row.dshCalls} | ${row.tokens.input} | ${row.tokens.output} | ${row.tokens.cache_read} | ${row.tokens.cache_write} | ${row.tokens.total} | ${row.durationMin ?? 'n/a'} |\n`,
    );
  }
  const dshSessions = rows.filter((row) => row.dshCalls > 0);
  process.stdout.write(
    `\n含 dsh 调用的会话：${dshSessions.length}/${rows.length}；这些会话总 token=${dshSessions.reduce((sum, row) => sum + row.tokens.total, 0)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[leader-usage] 失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
