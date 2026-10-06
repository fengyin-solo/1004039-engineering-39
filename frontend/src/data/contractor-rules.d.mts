// contractor-rules.mjs 的类型声明：Node 脚本用 .mjs 本体，前端经此获得完整类型。
import type contractorRules from './contractor-rules.json'

export type ContractorRules = typeof contractorRules

export type ContractorConditionKey = keyof ContractorRules['conditions']

export interface CertificateInfo {
  token: string
  name: string
  certNo: string
  expire: string | null
}

export interface ConditionFailure {
  condition: string
  label: string
  reason: string
}

export interface StageEvaluation {
  stage: string
  stageLabel: string
  failures: ConditionFailure[]
}

export interface RowEvaluation extends StageEvaluation {
  status: string
  category: string
  blocking: boolean
  note?: string
}

export interface ActionEvaluation extends StageEvaluation {
  applicable: boolean
}

export interface ContractorEngine {
  rules: ContractorRules
  gradeRank: (name: string) => number | null
  enterpriseGrades: (name: string) => string[] | null
  parseCertificates: (raw: unknown) => CertificateInfo[]
  stageDefinition: (stageKey: string) => ContractorRules['stages'][string] | null
  evaluateStage: (row: Record<string, unknown>, stageKey: string, refDate?: string) => StageEvaluation
  evaluateRow: (row: Record<string, unknown>, refDate?: string) => RowEvaluation
  evaluateAction: (row: Record<string, unknown>, action: string, refDate?: string) => ActionEvaluation
}

export function todayISO(): string
export function createContractorEngine(rules: ContractorRules): ContractorEngine
export function describeRow(row: Record<string, unknown>, rules: ContractorRules): string
