// 施工队伍资质链路规则引擎：纯函数、零依赖。
// Node 侧构建前校验脚本（scripts/contractor-pipeline.mjs）与浏览器侧运行时
// （src/data/contractor.ts）共用本文件，规则只在 contractor-rules.json 维护一份，
// 新增资质类型时改 JSON 即可，这里不需要动。

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function toTime(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    return null
  }
  return new Date(`${value}T00:00:00Z`).getTime()
}

// 特种作业证字段约定：多证用「、」分隔，每证「证名(证号:有效期YYYY-MM-DD)」。
// 例：有限空间作业操作证(AX-0001:2028-06-30)、焊接与热切割作业操作证(AH-0002:2028-03-31)
function parseCertificates(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return []
  }
  const tokens = raw
    .split(/[、,，;；]/)
    .map((part) => part.trim())
    .filter(Boolean)
  const parsed = []
  for (const token of tokens) {
    const match = token.match(/^(.+?)\(([^():]+):(\d{4}-\d{2}-\d{2})\)$/)
    if (!match) {
      parsed.push({ token, name: token.trim(), certNo: '', expire: null })
      continue
    }
    parsed.push({ token, name: match[1].trim(), certNo: match[2].trim(), expire: match[3] })
  }
  return parsed
}

export function createContractorEngine(rules) {
  const grades = new Map(rules.qualificationGrades.map((item) => [item.name, item.rank]))
  const enterprises = new Map(rules.enterprises.map((item) => [item.name, item.grades]))
  const certCatalog = new Set(rules.certificates.catalog)
  const stages = rules.stages

  function gradeRank(name) {
    return grades.has(name) ? grades.get(name) : null
  }

  function enterpriseGrades(name) {
    return enterprises.has(name) ? enterprises.get(name) : null
  }

  // 单项条件检查：通过返回 null，不通过返回原因说明。
  const checks = {
    'qualification-registered': (row) => {
      const grade = String(row[rules.fields.qualification] ?? '').trim()
      if (!grade) {
        return '资质等级未填写'
      }
      if (!grades.has(grade)) {
        return `资质等级「${grade}」不在资质目录（${[...grades.keys()].join('、')}）内`
      }
      return null
    },
    'assign-qualification-grade': (row) => {
      const required = rules.assignQualification.grade
      const requiredRank = gradeRank(required)
      const grade = String(row[rules.fields.qualification] ?? '').trim()
      const rank = gradeRank(grade)
      if (rank === null || requiredRank === null || rank < requiredRank) {
        return `资质等级「${grade || '未填写'}」低于${rules.assignQualification.label}的要求`
      }
      return null
    },
    'enterprise-registered': (row) => {
      const name = String(row[rules.fields.enterprise] ?? '').trim()
      if (!name) {
        return '所属企业未填写'
      }
      if (!enterprises.has(name)) {
        return `所属企业「${name}」不在已登记企业目录内`
      }
      return null
    },
    'enterprise-qualification': (row) => {
      const enterprise = String(row[rules.fields.enterprise] ?? '').trim()
      const grade = String(row[rules.fields.qualification] ?? '').trim()
      const held = enterpriseGrades(enterprise)
      if (held === null) {
        return `所属企业「${enterprise || '未填写'}」未登记，无法核对企业施工资质`
      }
      if (!held.includes(grade)) {
        const scope = held.length > 0 ? held.join('、') : '无施工资质（仅劳务分包）'
        return `所属企业「${enterprise}」不持有「${grade}」资质（该企业可承接：${scope}），证企不一致`
      }
      return null
    },
    'required-certificates': (row) => {
      const held = parseCertificates(row[rules.fields.certificate]).map((item) => item.name)
      const missing = rules.certificates.required.filter((name) => !held.includes(name))
      if (missing.length > 0) {
        return `缺少必需特种作业证：${missing.join('、')}`
      }
      return null
    },
    'certificates-valid': (row, refDate) => {
      const certs = parseCertificates(row[rules.fields.certificate])
      if (certs.length === 0) {
        return '未登记任何特种作业证'
      }
      const problems = []
      for (const cert of certs) {
        if (!certCatalog.has(cert.name)) {
          problems.push(`「${cert.name}」不在特种作业证目录内`)
          continue
        }
        const expire = toTime(cert.expire)
        if (expire === null) {
          problems.push(`「${cert.name}」未按 证号:有效期YYYY-MM-DD 登记有效期`)
        } else if (expire < toTime(refDate)) {
          problems.push(`「${cert.name}」已于 ${cert.expire} 过期`)
        }
      }
      return problems.length > 0 ? problems.join('；') : null
    },
  }

  function stageDefinition(stageKey) {
    return stages[stageKey] || null
  }

  // 评估某支队伍能否满足指定阶段（审核备案 / 安排作业）的全部条件。
  function evaluateStage(row, stageKey, refDate) {
    const stage = stageDefinition(stageKey)
    if (!stage) {
      return { stage: stageKey, stageLabel: stageKey, failures: [] }
    }
    const failures = stage.conditions
      .map((condition) => {
        const reason = checks[condition](row, refDate)
        return reason === null ? null : { condition, label: rules.conditions[condition], reason }
      })
      .filter(Boolean)
    return { stage: stageKey, stageLabel: stage.label, failures }
  }

  // 按队伍当前状态评估它在资质链路上所处环节：
  // 待审核卡备案条件、已备案卡安排作业条件、作业中只预警、已清退不校验。
  function evaluateRow(row, refDate = todayISO()) {
    const flow = rules.statusFlows.find((item) => item.status === String(row.status))
    if (!flow) {
      return {
        status: String(row.status),
        category: '未知状态',
        blocking: true,
        stage: null,
        stageLabel: '',
        failures: [
          {
            condition: 'status-known',
            label: '队伍状态合法',
            reason: `队伍状态「${row.status}」不在状态目录（${rules.statusFlows
              .map((item) => item.status)
              .join('、')}）内`,
          },
        ],
      }
    }
    const result = {
      status: flow.status,
      category: flow.status,
      blocking: Boolean(flow.blocking),
      stage: flow.stage,
      stageLabel: flow.stage ? stageDefinition(flow.stage)?.label ?? '' : '',
      failures: [],
      note: flow.note ?? '',
    }
    if (flow.stage) {
      result.failures = evaluateStage(row, flow.stage, refDate).failures
    }
    return result
  }

  // 运行时动作拦截：只约束「审核备案 / 安排作业」两个动作，其余动作（清退等）不拦。
  function evaluateAction(row, action, refDate = todayISO()) {
    const flow = rules.statusFlows.find(
      (item) => item.status === String(row.status) && item.action === action,
    )
    if (!flow || !flow.stage) {
      return { applicable: false, stage: null, stageLabel: '', failures: [] }
    }
    return { applicable: true, ...evaluateStage(row, flow.stage, refDate) }
  }

  return {
    rules,
    gradeRank,
    enterpriseGrades,
    parseCertificates,
    stageDefinition,
    evaluateStage,
    evaluateRow,
    evaluateAction,
  }
}

export function describeRow(row, rules) {
  const code = String(row[rules.fields.code] ?? row.id ?? '')
  const name = String(row[rules.fields.name] ?? '')
  return `队伍 ${code}「${name}」`
}
