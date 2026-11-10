import { sliceUtf8 } from './event-summary.js';
import type { CommandEvidence, EditEvidence, RunEvent, TaskEvidence } from './types.js';

export const COMMAND_MAX_BYTES = 500;
export const COMMAND_TAIL_BYTES = 300;
export const COMMANDS_LIMIT = 50;

interface NormalizedCall {
  seq: number;
  callId?: string;
  tool: string;
  args: Record<string, unknown>;
}

interface NormalizedResult {
  isError: boolean;
  text: string;
}

const COMMAND_TOOLS = new Set(['pwsh', 'bash', 'shell', 'cmd', 'powershell']);
const EDIT_TOOLS = new Set([
  'str_replace_editor',
  'str_replace_based_edit_tool',
  'editor',
  'write',
  'edit',
  'apply_patch',
]);

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function callIdOf(event: RunEvent): string | undefined {
  const direct = event.call_id ?? event.callId;
  return typeof direct === 'string' ? direct : undefined;
}

function extractCall(event: RunEvent, seq: number): NormalizedCall | null {
  if (event.type !== 'tool_call') return null;
  // sdk 形态：{ tool, call_id, arguments }；headless 形态：{ tool, callId, input }
  const tool = typeof event.tool === 'string' ? event.tool : 'unknown';
  const args = asRecord(event.arguments ?? event.input ?? event.args);
  return { seq, callId: callIdOf(event), tool, args };
}

function extractResult(event: RunEvent): { callId?: string; result: NormalizedResult } | null {
  if (event.type !== 'tool_result') return null;
  const callId = callIdOf(event);
  const message = asRecord(event.message);
  const isError = message.isError === true;
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .map((block) => {
      const record = asRecord(block);
      return typeof record.text === 'string' ? record.text : '';
    })
    .join('');
  // headless 形态：{ callId, status, result }
  const headlessText = typeof event.result === 'string' ? event.result : '';
  const headlessError = event.status === 'error' || event.status === 'failed';
  return { callId, result: { isError: isError || headlessError, text: text || headlessText } };
}

/** 从工具输出文本提取退出码与保留标记；宁可 null 不猜。 */
export function parseCommandExit(text: string, isError: boolean): { exitCode: number | null; markers: string[] } {
  const markers: string[] = [];
  const killed = text.match(/\[killed by signal:[^\]]*\]/i);
  if (killed) return { exitCode: null, markers: [killed[0]] };
  const timedOut = text.match(/\[timed out[^\]]*\]/i);
  if (timedOut) return { exitCode: null, markers: [timedOut[0]] };
  const sandbox = text.match(/\[sandbox:[^\]]*denied[^\]]*\]/i);
  if (sandbox) return { exitCode: null, markers: [sandbox[0]] };
  const exit = text.match(/\[exit code: (-?\d+)\]/i);
  if (exit) {
    markers.push(exit[0]);
    return { exitCode: Number(exit[1]), markers };
  }
  const stopped = text.match(/\[stopped:[^\]]*\]/i);
  if (stopped) return { exitCode: null, markers: [stopped[0]] };
  return { exitCode: isError ? null : 0, markers };
}

function commandEvidence(call: NormalizedCall, result: NormalizedResult | undefined): CommandEvidence {
  const rawCommand = typeof call.args.command === 'string' ? call.args.command : '';
  const command = sliceUtf8(rawCommand, COMMAND_MAX_BYTES);
  const text = result?.text ?? '';
  const isError = result?.isError === true;
  const parsed = result ? parseCommandExit(text, isError) : { exitCode: null, markers: ['[no result]'] };
  const evidence: CommandEvidence = {
    seq: call.seq,
    tool: call.tool,
    command: command.text,
    ...(command.truncated ? { command_truncated: true } : {}),
    ...(typeof call.args.workdir === 'string' ? { workdir: call.args.workdir } : {}),
    exit_code: parsed.exitCode,
    is_error: isError,
    markers: parsed.markers,
  };
  if ((parsed.exitCode !== null && parsed.exitCode !== 0) || isError) {
    const tail = sliceUtf8(text, COMMAND_TAIL_BYTES);
    if (tail.text) evidence.output_tail = tail.text;
  }
  return evidence;
}

function accumulateEdit(edits: Map<string, EditEvidence>, call: NormalizedCall, result: NormalizedResult | undefined): void {
  const path =
    typeof call.args.file_path === 'string'
      ? call.args.file_path
      : typeof call.args.path === 'string'
        ? call.args.path
        : typeof call.args.file === 'string'
          ? call.args.file
          : '(unknown)';
  const entry = edits.get(path) ?? { path, ops: {}, errors: 0 };
  let op: keyof EditEvidence['ops'] = 'other';
  if (call.tool === 'write') op = 'write';
  else if (call.tool === 'edit') op = 'edit';
  else if (call.tool === 'apply_patch') op = 'apply_patch';
  else if (typeof call.args.command === 'string') {
    if (call.args.command === 'create' || call.args.command === 'str_replace' || call.args.command === 'insert') {
      op = call.args.command;
    }
  }
  entry.ops[op] = (entry.ops[op] ?? 0) + 1;
  if (result?.isError) entry.errors += 1;
  edits.set(path, entry);
}

/** 从事件流中归一化 sdk / headless 两套工具事件形态。 */
export function normalizeToolEvents(events: RunEvent[]): {
  calls: Array<{ call: NormalizedCall; result?: NormalizedResult }>;
  results: Map<string, NormalizedResult>;
} {
  const results = new Map<string, NormalizedResult>();
  const calls: Array<{ call: NormalizedCall; result?: NormalizedResult }> = [];
  for (let seq = 0; seq < events.length; seq += 1) {
    const event = events[seq]!;
    const call = extractCall(event, seq);
    if (call) {
      calls.push({ call });
      continue;
    }
    const result = extractResult(event);
    if (result?.callId) results.set(result.callId, result.result);
  }
  for (const item of calls) {
    if (item.call.callId && results.has(item.call.callId)) item.result = results.get(item.call.callId);
  }
  return { calls, results };
}

/** 提取命令/编辑证据（预算内）；git 证据由 git-evidence 单独采集。 */
export function extractEvidence(events: RunEvent[]): Pick<
  TaskEvidence,
  'commands' | 'commands_truncated' | 'commands_total' | 'edits' | 'summary'
> {
  const { calls } = normalizeToolEvents(events);
  const commands: CommandEvidence[] = [];
  const edits = new Map<string, EditEvidence>();
  for (const item of calls) {
    if (COMMAND_TOOLS.has(item.call.tool)) {
      commands.push(commandEvidence(item.call, item.result));
    } else if (EDIT_TOOLS.has(item.call.tool)) {
      accumulateEdit(edits, item.call, item.result);
    }
  }

  const commandsTotal = commands.length;
  let selected = commands;
  let truncated = false;
  if (commands.length > COMMANDS_LIMIT) {
    const failed = commands.filter((command) => command.exit_code !== 0 || command.is_error);
    const head = commands.slice(0, 10);
    const tail = commands.slice(-10);
    const merged = new Map<number, CommandEvidence>();
    for (const command of [...head, ...failed, ...tail]) merged.set(command.seq, command);
    selected = [...merged.values()].sort((a, b) => a.seq - b.seq);
    truncated = true;
  }

  const editList = [...edits.values()];
  const last = selected[selected.length - 1];
  return {
    commands: selected,
    ...(truncated ? { commands_truncated: true } : {}),
    commands_total: commandsTotal,
    edits: editList,
    summary: {
      commands_failed: commands.filter((command) => command.exit_code !== 0 || command.is_error).length,
      last_command_exit_code: last ? last.exit_code : null,
      edits_failed: editList.reduce((sum, edit) => sum + edit.errors, 0),
    },
  };
}
