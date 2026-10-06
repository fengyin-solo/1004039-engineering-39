import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

import { createContractorEngine } from '../src/data/contractor-rules.mjs'
import { prepareSamples, validateSamples } from '../scripts/contractor-pipeline.mjs'
import { CONTRACTOR_SAMPLE_SPEC } from '../scripts/contractor-sample-spec.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const RULES_PATH = resolve(ROOT, 'src/data/contractor-rules.json')
const SAMPLES_PATH = resolve(ROOT, 'src/data/contractor-samples.json')
const CLI = resolve(ROOT, 'scripts/contractor-pipeline.mjs')

const rules = (await import(`file://${RULES_PATH}?t=${Date.now()}`, { with: { type: 'json' } })).default
const seedRows = (await import(`file://${SAMPLES_PATH}?t=${Date.now()}`, { with: { type: 'json' } })).default

const REF_DATE = '2026-10-06'
const engine = createContractorEngine(rules)

function rowByCode(code) {
  const row = seedRows.find((item) => item.队伍编号 === code)
  assert.ok(row, `测试样例缺少 ${code}`)
  return structuredClone(row)
}

function conditions(evaluation) {
  return evaluation.failures.map((item) => item.condition)
}

describe('资质链路规则引擎', () => {
  it('标准样例在各自所处环节全部通过', () => {
    for (const row of seedRows) {
      const evaluation = engine.evaluateRow(row, REF_DATE)
      assert.deepEqual(evaluation.failures, [], `${row.队伍编号} 不应有失败项：${JSON.stringify(evaluation.failures)}`)
    }
  })

  it('待审核队伍只卡审核备案条件：资质与证企一致，暂不查证书', () => {
    const row = rowByCode('CONT-0001')
    const evaluation = engine.evaluateRow(row, REF_DATE)
    assert.equal(evaluation.category, '待审核')
    assert.equal(evaluation.stageLabel, '审核备案')
    assert.equal(evaluation.blocking, true)

    const withoutCert = { ...row, 特种作业证: '' }
    const stillPassesRecord = engine.evaluateRow(withoutCert, REF_DATE)
    assert.deepEqual(stillPassesRecord.failures, [])
  })

  it('已备案队伍按安排作业环节校验：三级资质合格、缺证/过期证被拦下', () => {
    const row = rowByCode('CONT-0004')
    assert.equal(engine.evaluateRow(row, REF_DATE).failures.length, 0)

    const downgraded = { ...row, 资质等级: '二级', 所属企业: '江堤市政养护有限公司' }
    assert.ok(
      conditions(engine.evaluateRow(downgraded, REF_DATE)).includes('enterprise-qualification'),
    )

    const missingCert = { ...row, 特种作业证: '焊接与热切割作业操作证(AH-9001:2028-01-01)' }
    assert.ok(
      conditions(engine.evaluateRow(missingCert, REF_DATE)).includes('required-certificates'),
    )

    const expired = { ...row, 特种作业证: '有限空间作业操作证(AX-9001:2020-01-01)' }
    assert.ok(
      conditions(engine.evaluateRow(expired, REF_DATE)).includes('certificates-valid'),
    )
  })

  it('资质等级不在目录、低于作业要求分别报错', () => {
    const row = rowByCode('CONT-0001')
    const unknown = engine.evaluateStage({ ...row, 资质等级: '四级' }, 'record', REF_DATE)
    assert.ok(conditions(unknown).includes('qualification-registered'))

    // 三级是作业门槛；构造「三级」被企业持有的备案场景，再验更低等级被拦
    const rankable = { ...rowByCode('CONT-0004'), 资质等级: '三级' }
    assert.equal(engine.evaluateStage(rankable, 'assign', REF_DATE).failures.length, 0)

    const tooLow = engine.evaluateStage(
      { ...rankable, 资质等级: '不在册等级' },
      'assign',
      REF_DATE,
    )
    const failed = tooLow.failures.find((item) => item.condition === 'qualification-registered')
    assert.ok(failed)
    assert.match(failed.reason, /不在资质目录/)
  })

  it('企业未登记、企业不持有队伍资质等级（证企不一致）分别报错', () => {
    const row = rowByCode('CONT-0001')
    const missing = engine.evaluateStage({ ...row, 所属企业: '某皮包公司' }, 'record', REF_DATE)
    assert.ok(conditions(missing).includes('enterprise-registered'))

    // 宏图劳务分包无施工资质：挂三级资质即证企不一致
    const mismatch = engine.evaluateStage(
      { ...row, 资质等级: '三级', 所属企业: '宏图劳务分包有限公司' },
      'record',
      REF_DATE,
    )
    const failed = mismatch.failures.find((item) => item.condition === 'enterprise-qualification')
    assert.ok(failed)
    assert.match(failed.reason, /证企不一致/)
  })

  it('证书格式错误、目录外证书按无效处理', () => {
    const row = rowByCode('CONT-0004')
    const malformed = engine.evaluateStage(
      { ...row, 特种作业证: '有限空间作业操作证（口头承诺长期有效）' },
      'assign',
      REF_DATE,
    )
    assert.ok(conditions(malformed).includes('certificates-valid'))

    const unknownCert = engine.evaluateStage(
      { ...row, 特种作业证: '有限空间作业操作证(AX-9001:2028-01-01)、爆破作业证(AB-9002:2028-01-01)' },
      'assign',
      REF_DATE,
    )
    const failed = unknownCert.failures.find((item) => item.condition === 'certificates-valid')
    assert.ok(failed)
    assert.match(failed.reason, /爆破作业证/)
  })

  it('作业中队伍不阻断构建，只给预警；已清退队伍不校验', () => {
    const working = rowByCode('CONT-0003')
    const expired = engine.evaluateRow(
      { ...working, 特种作业证: '有限空间作业操作证(AX-3001:2020-01-01)' },
      REF_DATE,
    )
    assert.equal(expired.category, '作业中')
    assert.equal(expired.blocking, false)
    assert.ok(conditions(expired).includes('certificates-valid'))

    const cleared = engine.evaluateRow(rowByCode('CONT-0005'), REF_DATE)
    assert.deepEqual(cleared.failures, [])
  })

  it('未知状态按阻断处理', () => {
    const row = { ...rowByCode('CONT-0001'), status: '已拉黑' }
    const evaluation = engine.evaluateRow(row, REF_DATE)
    assert.equal(evaluation.blocking, true)
    assert.match(evaluation.failures[0].reason, /不在状态目录/)
  })

  it('运行时动作拦截只约束审核备案与安排作业', () => {
    const pending = rowByCode('CONT-0001')
    assert.equal(engine.evaluateAction(pending, '审核备案', REF_DATE).applicable, true)
    assert.equal(engine.evaluateAction(pending, '安排作业', REF_DATE).applicable, false)

    const filed = rowByCode('CONT-0002')
    assert.equal(engine.evaluateAction(filed, '安排作业', REF_DATE).failures.length, 0)
    assert.equal(engine.evaluateAction(filed, '清退队伍', REF_DATE).applicable, false)
  })
})

describe('prepare 样例准备', () => {
  it('从空数据生成标准样例，条数与规约一致', () => {
    const result = prepareSamples(rules, [])
    assert.equal(result.rows.length, CONTRACTOR_SAMPLE_SPEC.length)
    assert.deepEqual(
      result.rows.map((row) => row.队伍编号),
      CONTRACTOR_SAMPLE_SPEC.map((row) => row.队伍编号),
    )
  })

  it('重复执行幂等：再次准备的输出字节级一致', () => {
    const first = prepareSamples(rules, []).rows
    const second = prepareSamples(rules, first).rows
    const third = prepareSamples(rules, second).rows
    assert.deepEqual(second, first)
    assert.deepEqual(third, first)
  })

  it('已备案、作业中队伍原样保留；待审核/已清退同编号位以标准样例覆盖', () => {
    const current = prepareSamples(rules, []).rows
    const tampered = current.map((row) => {
      if (row.队伍编号 === 'CONT-0002') {
        return { ...row, 联系人: '人工改的备案联系人', 资质等级: '四级' }
      }
      if (row.队伍编号 === 'CONT-0003') {
        return { ...row, 联系电话: '13900000000' }
      }
      if (row.队伍编号 === 'CONT-0001') {
        return { ...row, 联系人: '临时改的待审核联系人' }
      }
      return row
    })
    const result = prepareSamples(rules, tampered)
    const kept0002 = result.rows.find((row) => row.队伍编号 === 'CONT-0002')
    const kept0003 = result.rows.find((row) => row.队伍编号 === 'CONT-0003')
    const replaced0001 = result.rows.find((row) => row.队伍编号 === 'CONT-0001')
    assert.equal(kept0002.联系人, '人工改的备案联系人')
    assert.equal(kept0002.资质等级, '四级')
    assert.equal(kept0003.联系电话, '13900000000')
    assert.equal(replaced0001.联系人, CONTRACTOR_SAMPLE_SPEC[0].联系人)
  })

  it('非标准编号：已备案/作业中追加保留并不撞 id；其余杂项移除', () => {
    const base = prepareSamples(rules, []).rows
    const extra = [
      ...base,
      {
        id: 99,
        status: '作业中',
        pending: false,
        abnormal: false,
        队伍编号: 'CONT-9001',
        队伍名称: '外来作业队',
        资质等级: '三级',
        所属企业: '江堤市政养护有限公司',
        联系人: '外来',
        联系电话: '13700000001',
        特种作业证: '有限空间作业操作证(AX-9001:2028-01-01)',
        队伍状态: '作业中',
      },
      {
        id: 100,
        status: '待审核',
        pending: true,
        abnormal: false,
        队伍编号: 'CONT-9002',
        队伍名称: '临时录入队',
        资质等级: '三级',
        所属企业: '江堤市政养护有限公司',
        联系人: '临时',
        联系电话: '13700000002',
        特种作业证: '有限空间作业操作证(AX-9002:2028-01-01)',
        队伍状态: '待审核',
      },
    ]
    const result = prepareSamples(rules, extra)
    const kept = result.rows.find((row) => row.队伍编号 === 'CONT-9001')
    assert.ok(kept)
    assert.equal(kept.id, 6)
    assert.ok(!result.rows.some((row) => row.队伍编号 === 'CONT-9002'))
    const ids = result.rows.map((row) => row.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  it('标准样例规约自身不满足链路时，prepare 直接失败且不落文件', () => {
    const badSpec = [
      {
        ...CONTRACTOR_SAMPLE_SPEC[0],
        队伍编号: 'CONT-BAD',
        所属企业: '宏图劳务分包有限公司',
        资质等级: '三级',
      },
    ]
    assert.throws(() => prepareSamples(rules, [], badSpec), /标准样例 CONT-BAD/)
  })
})

describe('validate 构建前校验', () => {
  it('仓库样例零阻断零预警', () => {
    const report = validateSamples(rules, seedRows, REF_DATE)
    assert.deepEqual(report.errors, [])
    assert.deepEqual(report.warnings, [])
  })

  it('待审核队伍资质不合法时，报出「待审核队伍 · 审核备案」及具体条件', () => {
    const rows = seedRows.map((row) =>
      row.队伍编号 === 'CONT-0001' ? { ...row, 资质等级: '四级' } : row,
    )
    const report = validateSamples(rules, rows, REF_DATE)
    const error = report.errors.find((item) => item.who.includes('CONT-0001'))
    assert.ok(error, 'CONT-0001 应有阻断项')
    assert.equal(error.category, '待审核队伍')
    assert.equal(error.stage, '审核备案')
    assert.match(error.label, /资质等级/)
  })

  it('已备案队伍证企不一致时阻断；作业中队伍证书过期只预警', () => {
    const rows = seedRows.map((row) => {
      if (row.队伍编号 === 'CONT-0002') {
        // 一级队伍挂到只持三级资质的企业：证企不一致，无法安排作业
        return { ...row, 所属企业: '江堤市政养护有限公司' }
      }
      if (row.队伍编号 === 'CONT-0003') {
        return { ...row, 特种作业证: '有限空间作业操作证(AX-3001:2020-01-01)' }
      }
      return row
    })
    const report = validateSamples(rules, rows, REF_DATE)
    const blocking = report.errors.find((item) => item.who.includes('CONT-0002'))
    assert.ok(blocking)
    assert.equal(blocking.category, '已备案队伍')
    assert.equal(blocking.stage, '安排作业')
    assert.match(blocking.label, /企业持有/)

    const warning = report.warnings.find((item) => item.who.includes('CONT-0003'))
    assert.ok(warning)
    assert.equal(warning.category, '作业中队伍')
    assert.match(warning.reason, /过期/)
  })

  it('队伍编号重复、必填字段缺失属于结构性阻断', () => {
    const duplicate = structuredClone(seedRows)
    duplicate.push({ ...duplicate[0] })
    const dupReport = validateSamples(rules, duplicate, REF_DATE)
    assert.ok(dupReport.errors.some((item) => item.category === '编号重复'))

    const missing = seedRows.map((row) =>
      row.队伍编号 === 'CONT-0001' ? { ...row, 所属企业: '' } : row,
    )
    const missReport = validateSamples(rules, missing, REF_DATE)
    assert.ok(missReport.errors.some((item) => item.category === '结构性缺失'))
  })
})

describe('CLI 退出码与可单独重跑', () => {
  let tmpDir

  before(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'contractor-pipeline-'))
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function runCli(args, expectFail = false) {
    try {
      const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
      if (expectFail) {
        assert.fail('预期非零退出，但命令成功了')
      }
      return stdout
    } catch (error) {
      if (!expectFail) {
        throw error
      }
      return error.stdout ? `${error.stdout}\n${error.stderr}` : error.message
    }
  }

  it('validate 可单独重跑：合格退出 0，不合格退出 1 且输出队伍类别与条件', () => {
    const okPath = resolve(tmpDir, 'ok.json')
    writeFileSync(okPath, JSON.stringify(seedRows), 'utf8')
    const okOutput = runCli(['validate', `--samples=${okPath}`, `--rules=${RULES_PATH}`, `--date=${REF_DATE}`])
    assert.match(okOutput, /校验通过/)

    const badRows = seedRows.map((row) =>
      row.队伍编号 === 'CONT-0004'
        ? { ...row, 所属企业: '宏图劳务分包有限公司' }
        : row,
    )
    const badPath = resolve(tmpDir, 'bad.json')
    writeFileSync(badPath, JSON.stringify(badRows), 'utf8')
    const badOutput = runCli(
      ['validate', `--samples=${badPath}`, `--rules=${RULES_PATH}`, `--date=${REF_DATE}`],
      true,
    )
    assert.match(badOutput, /已备案队伍/)
    assert.match(badOutput, /CONT-0004/)
    assert.match(badOutput, /证企不一致|企业/)
    assert.match(badOutput, /contractor:validate/)
  })

  it('prepare 可单独重跑且重复执行不产生重复样例', () => {
    const path = resolve(tmpDir, 'samples.json')
    runCli(['prepare', `--samples=${path}`, `--rules=${RULES_PATH}`])
    runCli(['prepare', `--samples=${path}`, `--rules=${RULES_PATH}`])
    const rows = JSON.parse(readFileSync(path, 'utf8'))
    const codes = rows.map((row) => row.队伍编号)
    assert.equal(codes.length, new Set(codes).size)
    assert.equal(rows.length, CONTRACTOR_SAMPLE_SPEC.length)
  })
})
