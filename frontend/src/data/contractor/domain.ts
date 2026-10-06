/**
 * 施工队伍资质链路：规则的唯一来源（single source of truth）。
 *
 * 运行时（src/api/local-service.ts 的动作前置校验）、构建前校验脚本
 * （scripts/contractor/）都从这里取规则。新增资质类型 / 证书 / 企业名录时
 * 只改这一个文件，样例与校验不会再各改一处、互相漏掉。
 *
 * 完整链路见 docs/contractor-qualification-pipeline.md：
 *   待审核 --审核备案→ 已备案 --安排作业→ 作业中；已备案/作业中 --清退队伍→ 已清退
 *   所属企业（名录内）→ 资质等级（≥ 二级）→ 特种作业证（两证齐全）→ 可安排作业
 */
import type { EntryRow } from '../types'

/** 作业状态链：与 modules.ts 里 contractor 模块保持一致（校验脚本会交叉核对）。 */
export const CONTRACTOR_STATUSES = ['待审核', '已备案', '作业中', '已清退'] as const
export type ContractorStatus = (typeof CONTRACTOR_STATUSES)[number]

/** 终态：清退后不再回到作业市场。 */
export const CONTRACTOR_TERMINAL_STATUS: ContractorStatus = '已清退'

/** 动作链：与 modules.ts 里 contractor.actionTargets 的键保持一致。 */
export const CONTRACTOR_ACTIONS = {
  审核备案: '已备案',
  安排作业: '作业中',
  清退队伍: '已清退',
} as const satisfies Record<string, ContractorStatus>

/** 作业中队伍不允许直接清退，需先完工退回已备案。 */
export const CONTRACTOR_CLEAR_EXCLUDE_STATUS: ContractorStatus = '作业中'

/** 关键字段：样例与登记数据缺任一项都过不了结构校验。 */
export const CONTRACTOR_REQUIRED_FIELDS = [
  '队伍编号',
  '队伍名称',
  '资质等级',
  '所属企业',
  '联系人',
  '联系电话',
  '特种作业证',
  '队伍状态',
] as const

/**
 * 资质等级链（市政公用工程施工总承包），从高到低。
 * 新增等级时只在这里插入一次：是否达到作业门槛由 RANK 自动推导。
 */
export const QUALIFICATION_LEVELS = ['特级', '一级', '二级', '三级'] as const
export type QualificationLevel = (typeof QUALIFICATION_LEVELS)[number]

/** 可安排作业的最低资质等级：等级低于它（含未登记的未知等级）不得备案、不得作业。 */
export const MIN_ASSIGN_QUALIFICATION: QualificationLevel = '二级'

const QUALIFICATION_RANK: Record<string, number> = Object.fromEntries(
  [...QUALIFICATION_LEVELS].reverse().map((level, index) => [level, index + 1]),
)
const MIN_ASSIGN_RANK = QUALIFICATION_RANK[MIN_ASSIGN_QUALIFICATION]

/** 所属企业链：只有名录内的企业，其队伍才能进入备案/作业环节。 */
export const REGISTERED_ENTERPRISES = [
  '城安市政工程有限公司',
  '恒泰管网建设有限公司',
  '宏远非开挖工程有限公司',
  '清源排水养护有限公司',
] as const

/**
 * 特种作业证链：安排作业要求两证齐全。
 * 新增证书类型只在这里追加一次，备案/作业两道门禁与校验脚本同步生效。
 */
export const REQUIRED_SPECIAL_CERTS = ['地下有限空间作业操作证', '焊接与热切割作业证'] as const

/** 已通过完整资质链路校验、可以被安排作业的作业状态（已备案 / 作业中）。 */
export const ASSIGNABLE_STATUSES: readonly ContractorStatus[] = ['已备案', '作业中']

/** 问题分类：失败信息按它说明「哪类队伍、哪项条件不满足」。 */
export const CHAIN_PROBLEM_CODES = [
  '企业未备案',
  '资质等级不足',
  '资质等级未知',
  '缺少特种作业证',
] as const
export type ChainProblemCode = (typeof CHAIN_PROBLEM_CODES)[number]

export type ChainProblem = {
  code: ChainProblemCode
  target: string
  detail: string
}

const isContractorStatus = (value: unknown): value is ContractorStatus =>
  typeof value === 'string' && (CONTRACTOR_STATUSES as readonly string[]).includes(value)

export function qualificationRank(level: string): number {
  return QUALIFICATION_RANK[level] ?? 0
}

/**
 * 解析特种作业证字段：兼容「证A,证B」「证A，证B」「证A;证B」等分隔写法。
 * 返回当前持有项；校验方再拿它和 REQUIRED_SPECIAL_CERTS 做差集。
 */
export function parseSpecialCerts(raw: unknown): string[] {
  return String(raw ?? '')
    .split(/[,，;；、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 评估一支队伍的完整资质链路：所属企业 → 资质等级 → 特种作业证。 */
export function evaluateContractor(row: Pick<EntryRow, string> | Record<string, unknown>): {
  status: ContractorStatus | '未知状态'
  registered: boolean | null
  rank: number
  heldCerts: string[]
  problems: ChainProblem[]
} {
  const rawStatus = String((row as Record<string, unknown>).status ?? '')
  const status: ContractorStatus | '未知状态' = isContractorStatus(rawStatus) ? rawStatus : '未知状态'

  const enterprise = String((row as Record<string, unknown>).所属企业 ?? '').trim()
  const registered = enterprise
    ? (REGISTERED_ENTERPRISES as readonly string[]).includes(enterprise)
    : null

  const level = String((row as Record<string, unknown>).资质等级 ?? '').trim()
  const rank = qualificationRank(level)

  const heldCerts = parseSpecialCerts((row as Record<string, unknown>).特种作业证)
  const missingCerts = REQUIRED_SPECIAL_CERTS.filter((cert) => !heldCerts.includes(cert))

  const problems: ChainProblem[] = []
  if (registered === false) {
    problems.push({
      code: '企业未备案',
      target: enterprise,
      detail: `所属企业「${enterprise}」不在备案企业名录内`,
    })
  }
  if (enterprise && rank === 0) {
    problems.push({
      code: '资质等级未知',
      target: level || '（空）',
      detail: `资质等级「${level || '空'}」未登记，已知等级：${QUALIFICATION_LEVELS.join('、')}`,
    })
  } else if (rank > 0 && rank < MIN_ASSIGN_RANK) {
    problems.push({
      code: '资质等级不足',
      target: level,
      detail: `资质等级为${level}，安排作业要求${MIN_ASSIGN_QUALIFICATION}及以上`,
    })
  }
  if (missingCerts.length > 0) {
    problems.push({
      code: '缺少特种作业证',
      target: missingCerts.join('、'),
      detail: `缺少特种作业证：${missingCerts.join('、')}`,
    })
  }

  return { status, registered, rank, heldCerts, problems }
}

/** 完整资质链路是否通过（企业名录 + 资质门槛 + 证书齐全）。 */
export function chainPassed(row: Pick<EntryRow, string> | Record<string, unknown>): boolean {
  return evaluateContractor(row).problems.length === 0
}

/** 队伍归属类别：失败信息里说明是「哪类队伍」。 */
export function contractorKind(status: ContractorStatus | '未知状态'): string {
  switch (status) {
    case '待审核':
      return '待审核队伍'
    case '已备案':
      return '已备案队伍'
    case '作业中':
      return '作业中队伍'
    case '已清退':
      return '已清退队伍'
    default:
      return '状态未知队伍'
  }
}

/** 页面/校验报告上定位一支队伍用的描述。 */
export function describeContractor(row: Record<string, unknown>): string {
  const code = String(row['队伍编号'] ?? `id=${String(row.id ?? '?')}`)
  const name = String(row['队伍名称'] ?? '未知队伍')
  const status = String(row.status ?? '未知状态')
  return `${contractorKind(isContractorStatus(status) ? status : '未知状态')} ${code}（${name}，当前状态「${status}」）`
}

export type TransitionDecision = { allowed: true } | { allowed: false; reason: string }

/**
 * 动作前置门禁（运行时与构建校验共用）。
 * 备案门禁即完整链路，保证「备案通过 = 可以安排作业」，不会再出现构建通过后
 * 页面上有已备案队伍却无法派活的情况。
 */
export function contractorTransition(
  action: string,
  currentStatus: string,
  row: Pick<EntryRow, string> | Record<string, unknown>,
): TransitionDecision {
  const target = CONTRACTOR_ACTIONS[action as keyof typeof CONTRACTOR_ACTIONS]
  if (!target) {
    return { allowed: false, reason: `施工队伍没有登记「${action}」这个动作` }
  }
  if (currentStatus === target) {
    return { allowed: false, reason: `施工队伍已经是「${target}」，不用重复操作` }
  }

  if (action === '清退队伍') {
    if (currentStatus === CONTRACTOR_CLEAR_EXCLUDE_STATUS) {
      return {
        allowed: false,
        reason: `作业中队伍需先完工退回「已备案」才能清退，不能直接清退`,
      }
    }
    if (currentStatus === CONTRACTOR_TERMINAL_STATUS) {
      return { allowed: false, reason: '施工队伍已清退，不能重复清退' }
    }
    if (currentStatus !== '已备案') {
      return { allowed: false, reason: `当前状态「${currentStatus}」的队伍不能清退` }
    }
    return { allowed: true }
  }

  if (action === '审核备案') {
    if (currentStatus !== '待审核') {
      return {
        allowed: false,
        reason: `只有待审核队伍能审核备案，当前状态「${currentStatus}」`,
      }
    }
  } else if (action === '安排作业') {
    if (currentStatus !== '已备案') {
      return { allowed: false, reason: `只有已备案队伍能安排作业，当前状态「${currentStatus}」` }
    }
  }

  const { problems } = evaluateContractor(row)
  if (problems.length > 0) {
    return {
      allowed: false,
      reason: `资质链路不满足（${problems.map((item) => item.code).join('、')}）：${problems
        .map((item) => item.detail)
        .join('；')}`,
    }
  }
  return { allowed: true }
}
