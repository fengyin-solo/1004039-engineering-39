#!/usr/bin/env node
/**
 * 施工队伍流水线入口（npm run contractor:pipeline，也是 npm run build 的 prebuild）：
 *   样例准备(prepare) → 构建前校验(validate)
 *
 * 用法：
 *   node scripts/contractor/pipeline.mjs              全流程；已通过的阶段跳过，只重跑失败/未跑环节
 *   node scripts/contractor/pipeline.mjs --force      忽略状态文件，两阶段全部重跑
 *   node scripts/contractor/pipeline.mjs --validate   只重跑指定阶段（prepare|validate）
 *
 * 每个阶段幂等：重复执行不产生重复样例、无内容变更时 seed.ts 不重写。
 * 阶段结果落 .contractor-pipeline-state.json，修复后可单独重跑失败环节。
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  c,
  CATALOG_PATH,
  clearStageResult,
  DOMAIN_PATH,
  MODULES_PATH,
  SEED_PATH,
  stageUpToDate,
  STATE_PATH,
  STAGE_PIPELINE,
  STAGE_PREPARE,
  STAGE_VALIDATE,
  writeStageResult,
} from './_lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// 各阶段的输入声明要与对应脚本 runStage(..., inputs) 保持一致，这里用于跳过判断。
const STAGES = [
  {
    name: STAGE_PREPARE,
    script: resolve(here, 'prepare.mjs'),
    inputs: { seed: SEED_PATH, catalog: CATALOG_PATH, domain: DOMAIN_PATH },
  },
  {
    name: STAGE_VALIDATE,
    script: resolve(here, 'validate.mjs'),
    inputs: { seed: SEED_PATH, domain: DOMAIN_PATH, modules: MODULES_PATH },
  },
]

const args = process.argv.slice(2)
const force = args.includes('--force')
const onlyStage = (() => {
  const index = args.indexOf('--stage')
  if (index >= 0) return args[index + 1]
  const named = args.find((arg) => arg.startsWith('--') && arg !== '--force')
  return named ? named.slice(2) : null
})()

function runScript(script) {
  return spawnSync(process.execPath, [script], { stdio: 'inherit' })
}

function main() {
  let plan
  if (onlyStage) {
    const stage = STAGES.find((item) => item.name === onlyStage)
    if (!stage) {
      console.log(c.red(`未知阶段「${onlyStage}」，可选：${STAGES.map((item) => item.name).join('、')}`))
      process.exit(2)
    }
    plan = [stage]
  } else {
    plan = STAGES
  }

  console.log(c.cyan('施工队伍资质流水线：样例准备 → 构建前校验'))
  console.log(c.dim(`状态文件：${STATE_PATH}${force ? '（--force，忽略已有结果）' : ''}`))

  const failed = []
  for (const stage of plan) {
    const upToDate = stageUpToDate(stage.name, stage.inputs)
    if (!force && !onlyStage && upToDate) {
      console.log(c.dim(`[${stage.name}] 上次已通过且输入未变，跳过（要强制重跑用 --stage ${stage.name} 或 --force）`))
      continue
    }
    if (!upToDate) {
      console.log(c.dim(`[${stage.name}] 输入有变化或尚未通过，重新执行`))
    }
    clearStageResult(stage.name)
    const result = runScript(stage.script)
    if (result.status !== 0) {
      failed.push(stage.name)
      break
    }
  }

  if (failed.length > 0) {
    writeStageResult(STAGE_PIPELINE, {
      status: 'failed',
      at: new Date().toISOString(),
      failedStage: failed[0],
      hint: `修复后执行 npm run contractor:pipeline -- --stage ${failed[0]} 单独重跑`,
    })
    console.log('')
    console.log(c.red(`流水线在「${failed[0]}」环节中止；前序通过环节不受影响。`))
    console.log(c.yellow(`修复后可单独重跑：npm run contractor:pipeline -- --stage ${failed[0]}`))
    process.exit(1)
  }

  writeStageResult(STAGE_PIPELINE, { status: 'ok', at: new Date().toISOString() })
  console.log('')
  console.log(c.green('施工队伍流水线全部通过，可以执行构建。'))
}

main()
