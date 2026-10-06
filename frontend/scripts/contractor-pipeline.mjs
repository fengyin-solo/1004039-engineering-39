#!/usr/bin/env node
// 施工队伍「样例准备 → 构建前校验」流水线。
//
//   node scripts/contractor-pipeline.mjs all       先准备样例再校验（默认，挂在 npm prebuild）
//   node scripts/contractor-pipeline.mjs prepare   只重跑样例准备（幂等，不产生重复样例）
//   node scripts/contractor-pipeline.mjs validate  只重跑校验（修复后单独重跑失败环节）
//
// 可选参数：
//   --date=YYYY-MM-DD   以指定日期作为证书有效期基准（默认今天）
//   --samples=路径      样例文件路径（默认 src/data/contractor-samples.json）
//   --rules=路径        规则文件路径（默认 src/data/contractor-rules.json）
//
// 退出码：0 全部通过（允许有预警）；1 存在阻断性失败；2 用法/文件错误。

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createContractorEngine, describeRow, todayISO } from '../src/data/contractor-rules.mjs'
import { CONTRACTOR_SAMPLE_SPEC } from './contractor-sample-spec.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = resolve(HERE, '..')
const DEFAULT_RULES = resolve(FRONTEND_ROOT, 'src/data/contractor-rules.json')
const DEFAULT_SAMPLES = resolve(FRONTEND_ROOT, 'src/data/contractor-samples.json')

function parseArgs(argv) {
  const hasPositionalPhase = argv.length > 0 && !argv[0].startsWith('--')
  const options = {
    phase: hasPositionalPhase ? argv[0] : 'all',
    date: todayISO(),
    rulesPath: DEFAULT_RULES,
    samplesPath: DEFAULT_SAMPLES,
  }
  for (const arg of argv.slice(hasPositionalPhase ? 1 : 0)) {
    if (arg.startsWith('--date=')) {
      options.date = arg.slice('--date='.length)
    } else if (arg.startsWith('--samples=')) {
      options.samplesPath = resolve(arg.slice('--samples='.length))
    } else if (arg.startsWith('--rules=')) {
      options.rulesPath = resolve(arg.slice('--rules='.length))
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`不认识的参数：${arg}`)
    }
  }
  return options
}

function loadRules(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`规则文件读取失败（${path}）：${error.message}`, { cause: error })
  }
}

function loadSamples(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw new Error(`样例文件读取失败（${path}）：${error.message}`, { cause: error })
  }
}

// 把样例规约物化成 EntryRow：id/pending/abnormal 的取值与 local-store 里
// runAction 的状态流转语义保持一致。
function buildCanonicalRow(spec, index, engine) {
  const rules = engine.rules
  const knownStatuses = rules.statusFlows.map((item) => item.status)
  if (!knownStatuses.includes(spec.status)) {
    throw new Error(`样例 ${spec.队伍编号} 的状态「${spec.status}」不在状态目录内`)
  }
  const lastStatus = knownStatuses[knownStatuses.length - 1]
  return {
    id: index + 1,
    status: spec.status,
    pending: spec.status !== lastStatus,
    abnormal: spec.status === '已清退',
    队伍编号: spec.队伍编号,
    队伍名称: spec.队伍名称,
    资质等级: spec.资质等级,
    所属企业: spec.所属企业,
    联系人: spec.联系人,
    联系电话: spec.联系电话,
    特种作业证: spec.特种作业证,
    队伍状态: spec.status,
  }
}

// prepare：与现有样例合并。已备案/作业中队伍原样保留（不受影响），
// 其余同编号队伍以标准样例为准（幂等覆盖），编号不在标准规约里的
// 已备案/作业中队伍追加保留；非受保护的杂项队伍随重新准备移除。
export function prepareSamples(rules, existingRows, spec = CONTRACTOR_SAMPLE_SPEC) {
  const engine = createContractorEngine(rules)
  const protectedStatuses = new Set(rules.prepare.protectedStatuses)

  // 标准样例先自查：任一条在其所处环节不过，就不产出任何文件。
  for (const specRow of spec) {
    const probe = { ...specRow, id: 0 }
    const evaluation = engine.evaluateRow(probe)
    if (evaluation.failures.length > 0 && evaluation.stage) {
      const reasons = evaluation.failures.map((item) => `  - ${item.label}：${item.reason}`).join('\n')
      throw new Error(
        `标准样例 ${specRow.队伍编号}（状态「${specRow.status}」）不满足「${evaluation.stageLabel}」条件：\n${reasons}`,
      )
    }
  }

  const canonical = spec.map((item, index) => buildCanonicalRow(item, index, engine))
  const canonicalCodes = new Set(canonical.map((row) => row[rules.fields.code]))
  const existing = Array.isArray(existingRows) ? existingRows : []

  const merged = []
  const keptProtected = []
  const replaced = []
  const removed = []
  let nextId = canonical.length + 1

  // 标准位：已备案/作业中且编号相同的现有行保留原内容，其余用标准行覆盖。
  for (const row of canonical) {
    const current = existing.find((item) => String(item[rules.fields.code]) === String(row[rules.fields.code]))
    if (current && protectedStatuses.has(String(current.status))) {
      merged.push({ ...current })
      keptProtected.push(current)
    } else {
      if (current) {
        replaced.push(current)
      }
      merged.push({ ...row })
    }
  }

  // 非标准位：只追加受保护（已备案/作业中）的现有队伍，重新分配 id 避免撞号。
  for (const row of existing) {
    const code = String(row[rules.fields.code] ?? '')
    if (canonicalCodes.has(code)) {
      continue
    }
    if (protectedStatuses.has(String(row.status))) {
      merged.push({ ...row, id: nextId++ })
      keptProtected.push(row)
    } else {
      removed.push(row)
    }
  }

  return { rows: merged, canonical, keptProtected, replaced, removed }
}

function checkStructuralIntegrity(rows, rules) {
  const failures = []
  const codeField = rules.fields.code
  const requiredColumns = [codeField, rules.fields.name, rules.fields.qualification, rules.fields.enterprise]
  const seenCodes = new Map()

  rows.forEach((row, index) => {
    const who = describeRow(row, rules)
    for (const column of requiredColumns) {
      if (String(row[column] ?? '').trim() === '') {
        failures.push({
          who,
          category: '结构性缺失',
          stage: '-',
          label: `字段「${column}」`,
          reason: `第 ${index + 1} 行缺少必填字段「${column}」`,
          blocking: true,
        })
      }
    }
    const code = String(row[codeField] ?? '')
    if (code) {
      if (seenCodes.has(code)) {
        failures.push({
          who,
          category: '编号重复',
          stage: '-',
          label: '队伍编号唯一',
          reason: `队伍编号「${code}」出现多次（第 ${seenCodes.get(code) + 1} 行与第 ${index + 1} 行），重复执行不应产生重复样例`,
          blocking: true,
        })
      } else {
        seenCodes.set(code, index)
      }
    }
  })
  return failures
}

// validate：逐队按状态所在环节核对，输出「哪类队伍、哪项条件不满足」。
export function validateSamples(rules, rows, refDate = todayISO()) {
  const engine = createContractorEngine(rules)
  const structural = checkStructuralIntegrity(rows, rules)
  const business = []
  for (const row of rows) {
    const evaluation = engine.evaluateRow(row, refDate)
    for (const failure of evaluation.failures) {
      business.push({
        who: describeRow(row, rules),
        category: evaluation.stage ? `${evaluation.category}队伍` : evaluation.category,
        stage: evaluation.stageLabel || '-',
        label: failure.label,
        reason: failure.reason,
        blocking: evaluation.blocking,
      })
    }
  }
  const failures = [...structural, ...business]
  return {
    total: rows.length,
    refDate,
    failures,
    errors: failures.filter((item) => item.blocking),
    warnings: business.filter((item) => !item.blocking),
  }
}

function groupByCategory(failures) {
  const groups = new Map()
  for (const item of failures) {
    if (!groups.has(item.category)) {
      groups.set(item.category, [])
    }
    groups.get(item.category).push(item)
  }
  return groups
}

function printValidation(report) {
  const { errors, warnings, total, refDate } = report
  if (errors.length === 0 && warnings.length === 0) {
    console.log(`✔ 校验通过：${total} 支施工队伍全部满足资质链路条件（基准日期 ${refDate}）`)
    return
  }
  for (const item of warnings) {
    console.log(`⚠ [预警][${item.category} · ${item.stage}] ${item.who}`)
    console.log(`    ${item.reason}`)
  }
  for (const item of errors) {
    console.log(`✘ [阻断][${item.category} · ${item.stage}] ${item.who}`)
    console.log(`    不满足条件「${item.label}」：${item.reason}`)
  }
  if (warnings.length > 0 && errors.length === 0) {
    console.log(`✔ 校验通过（含 ${warnings.length} 条作业中队伍预警）：${total} 支队伍，基准日期 ${refDate}`)
  } else {
    const groups = groupByCategory(errors)
    const summary = [...groups.entries()]
      .map(([category, items]) => `${category} ${items.length} 项`)
      .join('；')
    console.log(`✘ 校验失败：${errors.length} 项阻断（${summary}），另有 ${warnings.length} 条预警。修复后可执行 npm run contractor:validate 单独重跑。`)
  }
}

function writeSamples(path, rows) {
  const serialized = `${JSON.stringify(rows, null, 2)}\n`
  writeFileSync(path, serialized, 'utf8')
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`参数错误：${error.message}`)
    console.error('用法：node scripts/contractor-pipeline.mjs [all|prepare|validate] [--date=YYYY-MM-DD]')
    process.exit(2)
  }
  if (options.help) {
    console.log('用法：node scripts/contractor-pipeline.mjs [all|prepare|validate] [--date=YYYY-MM-DD] [--samples=路径] [--rules=路径]')
    process.exit(0)
  }
  if (!['all', 'prepare', 'validate'].includes(options.phase)) {
    console.error(`未知环节「${options.phase}」，只支持 all / prepare / validate`)
    process.exit(2)
  }

  const rules = loadRules(options.rulesPath)

  if (options.phase === 'prepare' || options.phase === 'all') {
    console.log('— 环节 1/2：样例准备 prepare（幂等；已备案、作业中队伍原样保留）')
    const existing = loadSamples(options.samplesPath)
    if (existing === null) {
      console.log('  未发现现有样例文件，将全新生成')
    }
    try {
      const result = prepareSamples(rules, existing ?? [])
      writeSamples(options.samplesPath, result.rows)
      console.log(`  标准样例 ${result.canonical.length} 条；保留受保护队伍 ${result.keptProtected.length} 条；覆盖待审核/已清退位 ${result.replaced.length} 条；移除杂项 ${result.removed.length} 条`)
      console.log(`  已写入 ${options.samplesPath}`)
    } catch (error) {
      console.error(`✘ 样例准备失败，未写入文件：${error.message}`)
      process.exit(1)
    }
  }

  if (options.phase === 'validate' || options.phase === 'all') {
    console.log('— 环节 2/2：构建前校验 validate（按队伍类别核对资质链路）')
    const rows = loadSamples(options.samplesPath)
    if (rows === null) {
      console.error(`✘ 样例文件不存在：${options.samplesPath}。请先执行 npm run contractor:prepare`)
      process.exit(2)
    }
    if (!Array.isArray(rows)) {
      console.error(`✘ 样例文件内容不是数组：${options.samplesPath}`)
      process.exit(2)
    }
    const report = validateSamples(rules, rows, options.date)
    printValidation(report)
    if (report.errors.length > 0) {
      process.exit(1)
    }
  }
}

// 被测试文件 import 时不自动执行 CLI；经符号链接（npm exec 等）启动也认得出。
function isCliEntry() {
  if (!process.argv[1]) {
    return false
  }
  const invoked = realpathSync(resolve(process.argv[1]))
  const self = realpathSync(fileURLToPath(import.meta.url))
  return invoked === self
}

if (isCliEntry()) {
  main()
}
