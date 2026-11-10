#!/usr/bin/env python3
"""监控 codex thread 的 GPT 配额/token 消耗与 dsh worker 分摊情况。

合并自本机 Codex 在用的 dsh-mcp bridge（`~/scripts/dsh-mcp/monitor-thread.py`），
适配本仓库（dsh-mcp-worker）的任务落盘格式；两个版本的落盘数据都会扫描。

用法:
  python3 monitor-thread.py                          # 自动选最近活跃的 thread
  python3 monitor-thread.py --thread <uuid>          # 指定 thread
  python3 monitor-thread.py --list                   # 列出可监控 thread
  python3 monitor-thread.py --json                   # 输出 JSON（供程序消费）
  python3 monitor-thread.py --recent 30              # 最近 30 分钟速率（默认 10）
  python3 monitor-thread.py --cutover 16:59:46       # 接入时间点（本地时间），默认 16:59:46

数据来源（全部只读）:
  - ~/.codex/state_5.sqlite         thread 元信息（rollout 路径、tokens_used、model）
  - ~/.codex/thread_history_1.sqlite thread_turns（turn 起止/状态/时长）、thread_items（操作与 MCP 调用）
  - <rollout>.jsonl                  token_usage_record / token_count（含 rate_limits.used_percent）
  - ~/.dsh/sessions/<cwd>/session-*  worker 会话（工具调用数、写文件数）
  - ~/.dsh/mcp-tasks/<task-id>/      本仓库 worker 任务记录（meta.json），可用 DSH_MCP_TASKS_DIR 覆盖
  - ~/.dsh-mcp/jobs/*.log            旧版 bridge（server.mjs）派活日志（兼容）
"""
import argparse, glob, json, os, sqlite3, subprocess, sys, datetime

HOME = os.path.expanduser("~")
DEFAULT_THREAD = "01a1959d-d466-7fb3-a8f9-de14554f6ef8"
STATE_DB = os.path.join(HOME, ".codex/state_5.sqlite")
HIST_DB = os.path.join(HOME, ".codex/thread_history_1.sqlite")
DSH_SESS = os.path.join(HOME, ".dsh/sessions")
# 旧版 bridge（server.mjs）的 job 日志目录
JOBS = os.path.join(HOME, ".dsh-mcp/jobs")
# 本仓库 worker 的任务目录（默认 <DSH_HOME>/mcp-tasks）
TASKS = os.environ.get("DSH_MCP_TASKS_DIR") or os.path.join(HOME, ".dsh", "mcp-tasks")


def local(ts, with_date=False):
    fmt = "%m-%d %H:%M:%S" if with_date else "%H:%M:%S"
    return datetime.datetime.fromtimestamp(ts).strftime(fmt)


def find_thread(tid):
    con = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True)
    row = con.execute(
        "SELECT id, rollout_path, tokens_used, model, cwd, title, created_at, updated_at, cli_version "
        "FROM threads WHERE id = ?", (tid,)).fetchone()
    con.close()
    if not row:
        raise SystemExit(f"thread 不存在: {tid}")
    keys = ["id", "rollout_path", "tokens_used", "model", "cwd", "title", "created_at", "updated_at", "cli_version"]
    return dict(zip(keys, row))


def _candidate_threads(limit=30, cwd=None):
    """按最近活跃排序的非内部 thread（排除 Guardian review 之类的内部审查会话）。"""
    con = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True)
    sql = ("SELECT id, rollout_path, tokens_used, model, cwd, title, created_at, updated_at, cli_version, name, source "
           "FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?")
    rows = con.execute(sql, (limit,)).fetchall()
    con.close()
    keys = ["id", "rollout_path", "tokens_used", "model", "cwd", "title", "created_at", "updated_at",
            "cli_version", "name", "source"]
    out = []
    for r in rows:
        th = dict(zip(keys, r))
        label = (th.get("name") or th.get("title") or "")
        if "guardian review" in label.lower():
            continue
        if th.get("source") == "guardian" or th.get("source") == "subagent":
            continue
        if cwd and th.get("cwd") and th["cwd"] != cwd:
            continue
        out.append(th)
    return out


def find_latest_thread(cwd=None):
    """自动选最近活跃的 thread（用于会话切换后继续监控）。"""
    cands = _candidate_threads(cwd=cwd)
    if not cands:
        raise SystemExit("找不到可监控的 thread")
    return cands[0]


def parse_cutover(text, day):
    h, m, s = (int(x) for x in text.split(":"))
    return datetime.datetime(day.year, day.month, day.day, h, m, s).timestamp()


def collect(thread, cutover_ts, recent_min):
    rollout = thread["rollout_path"]
    tokens = []   # (ts, turn_id, usage)
    tool_events = []  # (ts, name)
    last_count = None
    used_track = []  # (ts, used_percent, thread_total)
    dsh_texts = []   # (ts, text)
    with open(rollout, errors="ignore") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type")
            p = d.get("payload") or {}
            ts = d.get("timestamp")
            if not ts:
                continue
            try:
                tse = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
            except Exception:
                continue
            if t == "token_usage_record":
                tokens.append((tse, p.get("turn_id"), p.get("usage") or {}))
            elif t == "event_msg" and isinstance(p, dict) and p.get("type") == "token_count":
                info = p.get("info") or {}
                last_count = info.get("total_token_usage")
                rl = p.get("rate_limits") or {}
                prim = rl.get("primary") or {}
                used_track.append((tse, prim.get("used_percent"), (last_count or {}).get("total_tokens")))
            elif t == "response_item" and isinstance(p, dict) and p.get("type") in ("custom_tool_call", "function_call"):
                tool_events.append((tse, p.get("name") or "?"))
            elif t == "response_item" and isinstance(p, dict) and p.get("type") == "custom_tool_call":
                s = json.dumps(p, ensure_ascii=False)
                if "dsh_dispatch" in s:
                    dsh_texts.append((tse, s))

    con = sqlite3.connect(f"file:{HIST_DB}?mode=ro", uri=True)
    turns = [dict(zip(["turn_id", "ordinal", "status", "started_at", "completed_at", "duration_ms"], r))
             for r in con.execute(
                 "SELECT turn_id, rollout_ordinal, status, started_at, completed_at, duration_ms "
                 "FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal", (thread["id"],))]
    item_counts = {}
    mcp_items = []
    for r in con.execute(
            "SELECT turn_id, item_type, created_at_ms, item_json FROM thread_items WHERE thread_id = ?",
            (thread["id"],)):
        tid, itype, ts_ms, ijson = r
        item_counts.setdefault(tid, {}).setdefault(itype, 0)
        item_counts[tid][itype] += 1
        if itype == "mcpToolCall":
            try:
                j = json.loads(ijson)
            except Exception:
                j = {}
            mcp_items.append((ts_ms / 1000 if ts_ms else None, j.get("tool", "?"),
                              (j.get("arguments") or {}).get("task", "")[:100]))
    con.close()

    # turn 聚合
    agg = {}
    for tse, tid, u in tokens:
        if tid not in agg:
            agg[tid] = dict(input=0, cached=0, output=0, reasoning=0, total=0, calls=0)
        a = agg[tid]
        a["calls"] += 1
        a["input"] += u.get("input_tokens", 0) or 0
        a["cached"] += u.get("cached_input_tokens", 0) or 0
        a["output"] += u.get("output_tokens", 0) or 0
        a["reasoning"] += u.get("reasoning_output_tokens", 0) or 0
        a["total"] += u.get("total_tokens", 0) or 0

    # worker 会话（按 cwd slug 匹配）
    slug = "--" + os.path.abspath(thread["cwd"]).strip("/").replace("/", "-") + "--"
    worker_sessions = []
    for d in sorted(glob.glob(os.path.join(DSH_SESS, slug, "session-*"))):
        f = os.path.join(d, "session.v3.jsonl.zstd")
        if not os.path.exists(f):
            continue
        mt = os.path.getmtime(f)
        if mt < cutover_ts:
            continue
        try:
            raw = subprocess.run(["zstd", "-dc", f], capture_output=True, timeout=30).stdout
            tools = sum(1 for line in raw.splitlines() if b'"type":"tool/call"' in line or b'"type": "tool/call"' in line)
            writes = set()
            for line in raw.splitlines():
                try:
                    j = json.loads(line)
                except Exception:
                    continue
                if j.get("type") != "tool/call":
                    continue
                data = j.get("data") or {}
                nm = data.get("name") or ""
                args = data.get("arguments") or {}
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {}
                pth = args.get("file_path") or args.get("path") or ""
                if nm in ("write", "edit") and pth:
                    writes.add(pth)
            worker_sessions.append(dict(id=os.path.basename(d), mtime=mt, raw_bytes=len(raw),
                                        tool_calls=tools, files_written=len(writes)))
        except Exception:
            continue

    jobs_recent = []
    # 旧版 bridge（server.mjs）：~/.dsh-mcp/jobs/*.stdout.log
    for f in glob.glob(os.path.join(JOBS, "*.stdout.log")):
        mt = os.path.getmtime(f)
        if mt >= cutover_ts:
            jobs_recent.append(dict(id=os.path.basename(f).replace(".stdout.log", ""), mtime=mt,
                                    bytes=os.path.getsize(f), source="bridge"))
    # 本仓库 worker：<TASKS>/<task-id>/meta.json
    for meta_path in glob.glob(os.path.join(TASKS, "*", "meta.json")):
        try:
            with open(meta_path) as fh:
                meta = json.load(fh)
        except Exception:
            continue
        started_ms = meta.get("startedAt") or meta.get("createdAt") or 0
        started = started_ms / 1000.0
        if not started or started < cutover_ts:
            continue
        ended = meta.get("endedAt") or 0
        usage_tokens = meta.get("usageTokens") or {}
        jobs_recent.append(dict(
            id=meta.get("id") or os.path.basename(os.path.dirname(meta_path)),
            mtime=started,
            status=meta.get("status"),
            cwd=meta.get("cwd"),
            duration_ms=(ended - started_ms) if ended and started_ms else None,
            tokens=usage_tokens.get("totalTokens") if isinstance(usage_tokens, dict) else None,
            source="worker",
        ))

    return dict(thread=thread, turns=turns, agg=agg, used_track=used_track,
                mcp_items=mcp_items, worker_sessions=worker_sessions, jobs=jobs_recent,
                last_total=last_count)


def report(data, cutover_ts, recent_min):
    th = data["thread"]
    turns, agg = data["turns"], data["agg"]
    print("=" * 104)
    print(f"thread {th['id'][:18]}…  model={th['model']}  cli={th['cli_version']}")
    print(f"cwd={th['cwd']}")
    print(f"标题: {(th['title'] or '')[:80]}")
    print("=" * 104)

    pre = dict(total=0, output=0, reasoning=0, dur=0, n=0, calls=0)
    post = dict(total=0, output=0, reasoning=0, dur=0, n=0, calls=0)
    print(f"{'turn':>4} {'状态':<11} {'开始':>8} {'结束':>8} {'时长':>7} {'GPT total':>12} {'cached':>12} {'output':>8} {'LLM调用':>7} {'MCP':>4}")
    for i, t in enumerate(turns):
        a = agg.get(t["turn_id"]) or dict(total=0, output=0, reasoning=0, calls=0, cached=0)
        dur = (t["duration_ms"] or 0) / 1000
        if not t["completed_at"]:
            dur = max(0, min(__import__("time").time(), data["used_track"][-1][0] if data["used_track"] else __import__("time").time()) - (t["started_at"] or 0))
        s = local(t["started_at"]) if t["started_at"] else "-"
        e = local(t["completed_at"]) if t["completed_at"] else "进行中"
        mc = sum(1 for m in data["mcp_items"] if m[0] and t["started_at"] and t["started_at"] <= m[0] <= (t["completed_at"] or 10**12))
        print(f"{i+1:>4} {t['status']:<11} {s:>8} {e:>8} {dur:>7.0f}s {a['total']:>12,} {a.get('cached',0):>12,} {a['output']:>8,} {a['calls']:>7} {mc:>4}")
        bucket = pre if (t["started_at"] or 0) < cutover_ts else post
        bucket["total"] += a["total"]; bucket["output"] += a["output"]; bucket["reasoning"] += a["reasoning"]
        bucket["dur"] += dur; bucket["n"] += 1; bucket["calls"] += a["calls"]

    print("-" * 104)
    def rate(b):
        m = b["dur"] / 60 if b["dur"] else 0
        return (b["total"] / m if m else 0, b["output"] / m if m else 0)
    pr, po = rate(pre), rate(post)
    print(f"{'接入前':>4} {pre['n']:>2} turns  {pre['dur']/60:>7.1f}min  GPT={pre['total']:,}  output={pre['output']:,}  "
          f"速率={pr[0]:,.0f} tok/min  output={pr[1]:,.0f}/min")
    print(f"{'接入后':>4} {post['n']:>2} turns  {post['dur']/60:>7.1f}min  GPT={post['total']:,}  output={post['output']:,}  "
          f"速率={po[0]:,.0f} tok/min  output={po[1]:,.0f}/min")
    if po[0] and pr[0]:
        print(f"→ GPT token 速率变化: {(po[0]/pr[0]-1)*100:+.1f}%   output 速率变化: {(po[1]/pr[1]-1)*100:+.1f}%")

    # 配额
    ut = [(t, u, tot) for t, u, tot in data["used_track"] if u is not None]
    if ut:
        before = [x for x in ut if x[0] < cutover_ts]
        after = [x for x in ut if x[0] >= cutover_ts]
        print()
        print("配额消耗（rate_limits.used_percent，窗口 7 天）")
        if len(before) >= 2:
            b0, b1 = before[0], before[-1]
            mins = (b1[0] - b0[0]) / 60
            slope = (b1[1] - b0[1]) / mins if mins else 0
            print(f"  接入前: {local(b0[0])}({b0[1]}%) → {local(b1[0])}({b1[1]}%)  {mins:.1f}min  = {slope:.4f} %/min")
        if len(after) >= 2:
            a0, a1 = after[0], after[-1]
            mins = (a1[0] - a0[0]) / 60
            slope = (a1[1] - a0[1]) / mins if mins else 0
            print(f"  接入后: {local(a0[0])}({a0[1]}%) → {local(a1[0])}({a1[1]}%)  {mins:.1f}min  = {slope:.4f} %/min")
            if len(before) >= 2:
                bs = (before[-1][1] - before[0][1]) / ((before[-1][0] - before[0][0]) / 60)
                if slope:
                    print(f"  → 配额消耗速率: {bs/slope:.1f}x 更慢（降 {(1-slope/bs)*100:.0f}%）")
        print(f"  当前 used_percent={ut[-1][1]}%  thread 累计 tokens={data['last_total'].get('total_tokens', 0) if data['last_total'] else th['tokens_used']:,}")

    # 派活
    print()
    print("dsh worker 派活")
    dispatch = [m for m in data["mcp_items"] if m[1] in ("dsh_dispatch", "dsh_dispatch_async", "dsh_run", "dsh_batch_run")]
    polls = [m for m in data["mcp_items"] if m[1] in ("dsh_job_status", "dsh_job", "dsh_status")]
    print(f"  派活 {len(dispatch)} 次，轮询 {len(polls)} 次")
    for ts, tool, task in dispatch:
        print(f"    {local(ts)}  {tool:<20} {task[:70]}")
    if data["jobs"]:
        print(f"  任务落盘记录 {len(data['jobs'])} 条（接入后）：")
        for job in sorted(data["jobs"], key=lambda j: j.get("mtime") or 0)[-10:]:
            extra = ""
            if job.get("source") == "worker":
                extra = f"  status={job.get('status')}"
                if job.get("duration_ms") is not None:
                    extra += f"  {(job['duration_ms'] / 1000):.1f}s"
                if job.get("tokens"):
                    extra += f"  tokens={job['tokens']}"
            print(f"    {local(job['mtime'])}  {str(job['id'])[:24]}{extra}")
    if data["worker_sessions"]:
        tot_tools = sum(w["tool_calls"] for w in data["worker_sessions"])
        tot_files = sum(w["files_written"] for w in data["worker_sessions"])
        tot_raw = sum(w["raw_bytes"] for w in data["worker_sessions"])
        print(f"  worker 会话 {len(data['worker_sessions'])} 个，工具调用 {tot_tools} 次，写文件 {tot_files} 次，"
              f"日志解压 {tot_raw/1024/1024:.1f}MB（≈{tot_raw/4/1000:.0f}k input tokens 粗估）")

    # 最近速率
    if data["agg"]:
        now = data["used_track"][-1][0] if data["used_track"] else datetime.datetime.now().timestamp()
        recent = [(t, u) for t, u in [(ts, u) for ts, tid, u in []] if False]
    print()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--thread", default=None, help="thread id；省略则自动选最近活跃的 thread")
    ap.add_argument("--latest", action="store_true", help="显式要求自动选最近活跃 thread")
    ap.add_argument("--list", action="store_true", help="列出可监控的候选 thread")
    ap.add_argument("--cwd", default=None, help="只考虑某个工作目录的 thread")
    ap.add_argument("--cutover", default="16:59:46", help="接入时间点（本地 HH:MM:SS），用于接入前后对比")
    ap.add_argument("--recent", type=int, default=10)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if args.list:
        for th in _candidate_threads(cwd=args.cwd):
            label = (th.get("name") or th.get("title") or "")[:50]
            print(f"{th['id']}  updated={local(th['updated_at'], True)}  tokens={th['tokens_used'] or 0:>12,}  {label}")
        return

    if args.thread:
        th = find_thread(args.thread)
    else:
        th = find_latest_thread(cwd=args.cwd)
        print(f"（自动选择最近活跃 thread：{th['id'][:18]}… 更新于 {local(th['updated_at'], True)}）\n")

    cut = parse_cutover(args.cutover, datetime.datetime.fromtimestamp(th["created_at"]))
    cut_note = None
    if cut < th["created_at"]:
        # 该 thread 在接入点之后才创建：整段都是接入后，接入前基线为空
        cut = th["created_at"]
        cut_note = "该 thread 创建于接入点之后，全部数据视为「接入后」"
    if cut_note:
        print(f"（{cut_note}）")
    data = collect(th, cut, args.recent)
    if args.json:
        out = dict(thread={k: v for k, v in th.items()},
                   turns=data["turns"], agg=data["agg"],
                   mcp_items=data["mcp_items"], worker_sessions=data["worker_sessions"],
                   jobs=data["jobs"],
                   used=[{"ts": t, "pct": u} for t, u, _ in data["used_track"] if u is not None])
        print(json.dumps(out, ensure_ascii=False, default=str))
        return
    report(data, cut, args.recent)


if __name__ == "__main__":
    main()
