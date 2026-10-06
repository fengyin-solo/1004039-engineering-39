#!/usr/bin/env node
/**
 * 阶段 2：构建前校验（可独立重跑：npm run contractor:validate）。
 *
 * 读取阶段 1 准备好的 src/data/seed.ts 中 contractor 数据，按完整链路校验：
 *  0. 规则交叉核对：modules.ts 中 contractor 的状态/动作/字段必须与 domain.ts 一致，
 *     新增资质类型漏改任一处在这里直接失败；
 *  1. 结构：编号唯一、字段完整、状态合法、队伍状态与当前状态一致；
 *  2. 分类门禁：待审核/已清退只过结构；已备案/作业中必须满足完整资质链路；
 *  3. 全局：至少有 1 支可安排作业的已备案队伍。
 *
 * 失败时按「队伍类别 + 条件项」分组报出，退出码非 0，构建中止。
 */
import {
  DOMAIN_PATH,
  MODULES_PATH,
  MODULE_KEY,
  readSeedRows,
  runStage,
  SEED_PATH,
  STAGE_VALIDATE,
  loadDomain,
  loadTs,
} from './_lib.mjs'

function sameSet(a, b) {
  return a.length === b.length && a.every((item) => b.includes(item))
}

function crossCheckMeta(meta, domain) {
  const problems = []
  if (!meta) {
    problems.push(`modules.ts 中没有登记「${MODULE_KEY}」模块`)
    return problems
  }
  if (!sameSet(meta.statuses, [...domain.CONTRACTOR_STATUSES])) {
    problems.push(
      `modules.ts 状态 [${meta.statuses.join('、')}] 与规则源 [${domain.CONTRACTOR_STATUSES.join('、')}] 不一致`,
    )
  }
  const actionTargets = Object.fromEntries(
    Object.entries(domain.CONTRACTOR_ACTIONS).map(([action, target]) => [action, target]),
  )
  for (const [action, target] of Object.entries(actionTargets)) {
    if (meta.actionTargets?.[action] !== target) {
      problems.push(`modules.ts 缺少动作「${action} → ${target}」或目标状态不一致`)
    }
  }
  for (const action of Object.keys(meta.actionTargets ?? {})) {
    if (!(action in actionTargets)) {
      problems.push(`modules.ts 多出规则源未登记的动作「${action}」`)
    }
  }
  for (const field of domain.CONTRACTOR_REQUIRED_FIELDS) {
    if (!meta.fields?.includes(field)) {
      problems.push(`modules.ts 字段缺少「${field}」`)
    }
  }
  return problems
}

async function validate() {
  const domain = await loadDomain()
  const { MODULE_BY_KEY } = await loadTs(MODULES_PATH)
  const meta = MODULE_BY_KEY.get(MODULE_KEY)

  const failures = []
  for (const problem of crossCheckMeta(meta, domain)) {
    failures.push(`规则交叉核对：${problem}`)
  }

  const rows = readSeedRows()[MODULE_KEY] ?? []
  if (!Array.isArray(rows)) {
    throw new Error('seed.ts 中 contractor 数据不是数组，先执行样例准备')
  }

  // 1. 结构校验
  const seenIds = new Set()
  const seenCodes = new Set()
  for (const row of rows) {
    const who = () => domain.describeContractor(row)
    if (typeof row.id !== 'number' || seenIds.has(row.id)) {
      failures.push(`${who()}：id=${String(row.id)} 缺失或重复`)
    } else {
      seenIds.add(row.id)
    }
    const code = String(row['队伍编号'] ?? '').trim()
    if (!code) {
      failures.push(`${who()}：队伍编号为空`)
    } else if (seenCodes.has(code)) {
      failures.push(`${who()}：队伍编号「${code}」重复（重复样例）`)
    } else {
      seenCodes.add(code)
    }
    if (!domain.CONTRACTOR_STATUSES.includes(String(row.status))) {
      failures.push(`${who()}：当前状态「${String(row.status)}」不在状态链中`)
    }
    // 特种作业证允许为空：待审核队伍证书尚在核验，已清退队伍已退出作业市场；
    // 已备案/作业中队伍缺证会在下面的链路门禁里拦下。
    const certOptionalStatuses = ['待审核', '已清退']
    for (const field of domain.CONTRACTOR_REQUIRED_FIELDS) {
      const value = String(row[field] ?? '').trim()
      if (value) {
        continue
      }
      if (field === '特种作业证' && certOptionalStatuses.includes(String(row.status))) {
        continue
      }
      failures.push(`${who()}：字段「${field}」为空`)
    }
    if (String(row['队伍状态'] ?? '') !== String(row.status ?? '')) {
      failures.push(
        `${who()}：字段「队伍状态」为「${String(row['队伍状态'] ?? '')}」，与当前状态「${String(
          row.status ?? '',
        )}」不一致`,
      )
    }
  }

  // 2. 分类门禁：已备案/作业中必须满足完整链路；待审核/已清退豁免。
  for (const row of rows) {
    const { status, problems } = domain.evaluateContractor(row)
    if (!domain.ASSIGNABLE_STATUSES.includes(status)) {
      continue
    }
    for (const problem of problems) {
      failures.push(`${domain.describeContractor(row)}：${problem.code} —— ${problem.detail}`)
    }
  }

  // 3. 全局：至少 1 支可派活队伍（已备案且链路完整）。
  const ready = rows.filter(
    (row) => String(row.status) === '已备案' && domain.chainPassed(row),
  )
  if (ready.length === 0) {
    failures.push('全局门禁：没有任何一支满足完整资质链路的已备案队伍，页面上将无法安排作业')
  }

  const counts = {}
  for (const row of rows) {
    counts[String(row.status)] = (counts[String(row.status)] ?? 0) + 1
  }

  if (failures.length > 0) {
    const kinds = new Set(
      failures.map((line) =>
        line.startsWith('规则交叉核对')
          ? '规则交叉核对'
          : (line.match(/^(待审核队伍|已备案队伍|作业中队伍|已清退队伍|状态未知队伍)/)?.[0] ?? '其他'),
      ),
    )
    const err = new Error(`${failures.length} 项条件不满足，涉及 ${kinds.size} 类队伍/规则`)
    err.details = failures
    throw err
  }

  return {
    total: rows.length,
    ready: ready.length,
    summary: [
      `共 ${rows.length} 支队伍：${domain.CONTRACTOR_STATUSES.map(
        (status) => `${status} ${counts[status] ?? 0} 支`,
      ).join('，')}`,
      `满足完整链路、可安排作业的已备案队伍 ${ready.length} 支`,
      'modules.ts 与规则源（状态/动作/字段）交叉核对一致',
    ],
  }
}

runStage(
  STAGE_VALIDATE,
  validate,
  // seed 内容、规则源、模块元数据任一变化都必须重新校验。
  { seed: SEED_PATH, domain: DOMAIN_PATH, modules: MODULES_PATH },
).catch(() => process.exit(1))
