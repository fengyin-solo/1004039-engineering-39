// 施工队伍资质链路在浏览器侧的入口：规则 JSON 与规则引擎（.mjs）与构建前
// 校验脚本共用同一份，页面动作拦截与 npm build 前校验不会再各说各话。
import { createContractorEngine } from './contractor-rules.mjs'
import rulesJson from './contractor-rules.json'
import type {
  ActionEvaluation,
  ContractorEngine,
  ContractorRules,
  RowEvaluation,
} from './contractor-rules.d.mts'
import type { ActionResult, EntryRow } from './types'

export const CONTRACTOR_RULES = rulesJson as unknown as ContractorRules

let engineSingleton: ContractorEngine | null = null

export function contractorEngine(): ContractorEngine {
  if (engineSingleton === null) {
    engineSingleton = createContractorEngine(CONTRACTOR_RULES)
  }
  return engineSingleton
}

export function evaluateContractorRow(row: EntryRow): RowEvaluation {
  return contractorEngine().evaluateRow(row as unknown as Record<string, unknown>)
}

export function evaluateContractorAction(row: EntryRow, action: string): ActionEvaluation {
  return contractorEngine().evaluateAction(row as unknown as Record<string, unknown>, action)
}

// local-service 在执行施工队伍动作前调用：不适用的动作放行；
// 适用但条件不满足时，说明是哪类队伍、卡在哪项条件，页面不再出现
// 「构建通过、却安排不了作业」的队伍。
export function guardContractorAction(row: EntryRow, action: string): ActionResult | null {
  const evaluation = evaluateContractorAction(row, action)
  if (!evaluation.applicable) {
    return null
  }
  if (evaluation.failures.length === 0) {
    return null
  }
  const detail = evaluation.failures.map((item) => `· ${item.label}：${item.reason}`).join('\n')
  return {
    ok: false,
    message: `施工队伍当前为「${row.status}」，不满足「${evaluation.stageLabel}」条件：\n${detail}`,
  }
}
