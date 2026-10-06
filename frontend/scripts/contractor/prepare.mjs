#!/usr/bin/env node
/**
 * 阶段 1：样例准备（可独立重跑：npm run contractor:prepare）。
 *
 * 按队伍编号把标准目录 catalog.json 合入 src/data/seed.ts 的 contractor 数组：
 * - 已备案 / 作业中队伍：仍满足完整资质链路的原样保留（已有备案队伍和作业中队伍不受影响）；
 *   不再满足的（例如企业被移出名录）用标准目录修复，避免"构建通过但无法安排作业"；
 * - 其他类别（待审核 / 已清退）一律以目录为准；
 * - 目录里没有编号的额外队伍原样保留，交给阶段 2 校验；
 * - 结果稳定、按编号去重，重复执行不产生重复样例。
 */
import {
  CATALOG_PATH,
  c,
  DOMAIN_PATH,
  MODULE_KEY,
  readJson,
  readSeedRows,
  runStage,
  SEED_PATH,
  STAGE_PREPARE,
  writeSeedRows,
  loadDomain,
} from './_lib.mjs'

function nextId(rows) {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

async function prepare() {
  const domain = await loadDomain()
  const catalog = readJson(CATALOG_PATH).rows
  const catalogCodes = new Set(catalog.map((row) => row[`队伍编号`]))
  if (catalogCodes.size !== catalog.length) {
    throw new Error('标准目录里存在重复队伍编号，先修 catalog.json')
  }

  const allSeed = readSeedRows()
  const existing = Array.isArray(allSeed[MODULE_KEY]) ? allSeed[MODULE_KEY] : []
  const existingByCode = new Map()
  for (const row of existing) {
    existingByCode.set(String(row['队伍编号']), row)
  }

  const merged = []
  const retained = []
  const replaced = []
  const catalogUpdated = []
  let idSeq = nextId(existing)

  for (const standard of catalog) {
    const code = String(standard['队伍编号'])
    const local = existingByCode.get(code)
    const protectedStatuses = domain.ASSIGNABLE_STATUSES
    if (local && protectedStatuses.includes(String(local.status))) {
      if (domain.chainPassed(local)) {
        // 已备案/作业中且仍合规：一行不动。
        merged.push(local)
        retained.push(code)
        continue
      }
      merged.push({ ...standard, id: local.id })
      replaced.push(code)
      continue
    }
    merged.push(local ? { ...standard, id: local.id } : { ...standard, id: standard.id ?? idSeq++ })
    catalogUpdated.push(code)
  }

  // 目录外的额外队伍（本地登记数据）原样保留，是否合法由校验阶段判定。
  const extras = existing.filter((row) => !catalogCodes.has(String(row['队伍编号'])))
  for (const row of extras) {
    if (!merged.some((item) => Number(item.id) === Number(row.id))) {
      merged.push(row)
    }
  }

  merged.sort((a, b) => Number(a.id) - Number(b.id))

  // 幂等：合入结果与当前内容一致时不写文件。
  const changed = JSON.stringify(existing) !== JSON.stringify(merged)
  if (changed) {
    allSeed[MODULE_KEY] = merged
    writeSeedRows(allSeed)
  }

  return {
    changed,
    summary: [
      `合入标准目录 ${catalog.length} 支、保留目录外队伍 ${extras.length} 支，共 ${merged.length} 支`,
      retained.length
        ? `已备案/作业中且仍合规、原样保留：${retained.join('、')}`
        : '没有需要原样保留的已备案/作业中队伍',
      replaced.length
        ? `已失效、按目录修复：${replaced.join('、')}`
        : '没有失效的已备案/作业中队伍',
      changed ? c.yellow('seed.ts 已更新') : 'seed.ts 与上次结果一致，未重复写入',
    ],
  }
}

runStage(
  STAGE_PREPARE,
  prepare,
  // seed 也是输入（已备案/作业中队伍按现状保留或修复）；catalog/domain 变了也要重跑。
  { seed: SEED_PATH, catalog: CATALOG_PATH, domain: DOMAIN_PATH },
).catch(() => process.exit(1))
