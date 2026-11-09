import type { RunOutcome } from './types.js';

/**
 * DSH Windows ACL 沙箱在 workspace-write 下会给工作目录追加能力 SID + Low 标签；
 * 若目录 ACL 只授予 Modify（而非完全控制），SetNamedSecurityInfoW 会返回 Win32 5。
 * 该错误可能出现在 errorMessage / stderr，也可能只是某次 pwsh 工具结果（回合仍算完成）。
 */
const ACL_FAILURE_PATTERN = /SetNamedSecurityInfoW failed[^\n]*grantWrite|grantWrite\([^)]*\)[^\n]*Win32\s*5/i;

export function textLooksLikeSandboxAclFailure(text: string): boolean {
  return ACL_FAILURE_PATTERN.test(text);
}

/** 取出 ACL 失败原文片段（用于降级原因与排障），无匹配返回 null。 */
export function sandboxAclFailureDetail(text: string): string | null {
  const match = /(?:SetNamedSecurityInfoW failed[^\n"]{0,200}|grantWrite\([^)\n"]{0,200}\))/.exec(text);
  return match ? match[0].replace(/\\u002F/g, '/').slice(0, 300) : null;
}

export function isSandboxAclFailure(outcome: RunOutcome): boolean {
  // 只信「失败的 outcome」：正常结束的任务里，模型/文件内容完全可能引用该错误文本（read-only 分析误判来源）
  return ACL_FAILURE_PATTERN.test(`${outcome.errorMessage ?? ''}\n${outcome.stderrTail ?? ''}`);
}

export function sandboxAclHint(): string {
  return [
    '该目录的 ACL 不允许 DSH 沙箱授权写权限（需完全控制/ WRITE_OWNER，当前可能只有 Modify）。',
    '临时方案：改用 permission_mode="read-only"（取证类任务足够）。',
    '若确实需要写入：由目录所有者对该目录执行 icacls "<cwd>" /grant "<用户>:(OI)(CI)F"（会改动该目录 ACL 并写入 Low 完整性标签，请先确认合规）。',
  ].join(' ');
}
