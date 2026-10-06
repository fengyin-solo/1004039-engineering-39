/**
 * 施工队伍流水线（样例准备 → 构建前校验）的公共工具：
 * - 路径 / 阶段状态文件（.contractor-pipeline-state.json，可单独重跑失败环节）
 * - 用 esbuild 把 src/data/contractor/domain.ts 打成 ESM 后动态加载，
 *   运行时与构建脚本共用同一份 TS 规则源，避免规则两处维护。
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FRONTEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const DOMAIN_PATH = resolve(FRONTEND_DIR, 'src/data/contractor/domain.ts')
export const CATALOG_PATH = resolve(FRONTEND_DIR, 'src/data/contractor/catalog.json')
export const SEED_PATH = resolve(FRONTEND_DIR, 'src/data/seed.ts')
export const MODULES_PATH = resolve(FRONTEND_DIR, 'src/data/modules.ts')
export const STATE_PATH = resolve(FRONTEND_DIR, '.contractor-pipeline-state.json')

export const MODULE_KEY = 'contractor'
export const STAGE_PREPARE = 'prepare'
export const STAGE_VALIDATE = 'validate'
export const STAGE_PIPELINE = 'pipeline'

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, text) => (useColor ? `[${code}m${text}[0m` : text)
export const c = {
  green: (text) => paint('32', text),
  red: (text) => paint('31', text),
  yellow: (text) => paint('33', text),
  cyan: (text) => paint('36', text),
  dim: (text) => paint('2', text),
}

export function logStage(stage, message) {
  console.log(`${c.cyan(`[${stage}]`)} ${message}`)
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/** 加载任意 TS 源（仅用于无运行期依赖的纯数据/规则模块，如 domain.ts、modules.ts）。 */
export async function loadTs(entryPath) {
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  return import(url)
}

/** 加载 TS 规则源（domain.ts）。 */
export const loadDomain = () => loadTs(DOMAIN_PATH)

/** 从 seed.ts 中配对大括号提取 SEED_ROWS 对象字面量（避免截到类型注解里的 }）。 */
export function readSeedRows() {
  const source = readFileSync(SEED_PATH, 'utf8')
  const marker = 'SEED_ROWS'
  const from = source.indexOf(marker)
  if (from < 0) {
    throw new Error('seed.ts 中没有找到 SEED_ROWS')
  }
  const open = source.indexOf('{', from)
  if (open < 0) {
    throw new Error('seed.ts 中没有找到 SEED_ROWS 对象字面量')
  }
  let depth = 0
  let quote = null
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        // TS 允许对象/数组尾随逗号，JSON 不允许；准备阶段写回的内容总是干净的。
        const literal = source.slice(open, i + 1).replace(/,(\s*[}\]])/g, '$1')
        return JSON.parse(literal)
      }
    }
  }
  throw new Error('seed.ts 中 SEED_ROWS 对象字面量括号不配对')
}

/** 整体重写 seed.ts，保留文件头注释；内容稳定（键序/缩进一致）所以重复执行无 diff。 */
export function writeSeedRows(rows) {
  const header =
    "import type { EntryRow } from './types'\n\n" +
    '// 示例数据：首次打开时播种，之后浏览器里的改动优先，重置才会回到这份。\n' +
    '// contractor（施工队伍）由 contractor 流水线准备：标准目录见 src/data/contractor/catalog.json，\n' +
    '// 合入规则与构建前校验见 scripts/contractor/，不要手工只改这一处。\n'
  const body = `export const SEED_ROWS: Record<string, EntryRow[]> = ${JSON.stringify(rows, null, 2)}\n`
  mkdirSync(dirname(SEED_PATH), { recursive: true })
  writeFileSync(SEED_PATH, header + body, 'utf8')
}

export function readState() {
  try {
    return readJson(STATE_PATH)
  } catch {
    return { lastRun: null, stages: {} }
  }
}

export function writeStageResult(stage, result) {
  const state = readState()
  state.lastRun = new Date().toISOString()
  state.stages[stage] = result
  writeJson(STATE_PATH, state)
}

export function clearStageResult(stage) {
  const state = readState()
  delete state.stages[stage]
  writeJson(STATE_PATH, state)
}

/** 文件内容指纹：输入没变且上次通过，阶段才允许跳过。 */
export function fileFingerprint(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 阶段是否可跳过：上次通过且输入指纹全部一致。
 * 只要 seed / 目录 / 规则源被改过，指纹对不上就强制重跑，不会拿旧结果放行新数据。
 */
export function stageUpToDate(stage, inputs) {
  const result = readState().stages?.[stage]
  if (result?.status !== 'ok' || !result.fingerprints) {
    return false
  }
  return Object.entries(inputs).every(
    ([name, file]) => result.fingerprints[name] === fileFingerprint(file),
  )
}

/**
 * 运行单个阶段：捕获结果、落状态文件（供 pipeline 判断和失败后单独重跑），
 * 失败时以非零码退出。inputs 声明该阶段依赖的文件，用于指纹判断是否需要重跑。
 */
export async function runStage(stage, run, inputs = {}) {
  logStage(stage, '开始执行')
  const fingerprints = Object.fromEntries(
    Object.entries(inputs).map(([name, file]) => [name, fileFingerprint(file)]),
  )
  try {
    const result = await run()
    // fingerprints 放最后，避免被 result 里的同名键覆盖。
    writeStageResult(stage, {
      status: 'ok',
      at: new Date().toISOString(),
      ...result,
      fingerprints,
    })
    for (const line of result.summary ?? []) {
      console.log(`  ${c.green('✓')} ${line}`)
    }
    console.log(c.green(`[${stage}] 通过`))
    return result
  } catch (error) {
    const failure = {
      status: 'failed',
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
      details: Array.isArray(error?.details) ? error.details : [],
    }
    writeStageResult(stage, failure)
    console.log(c.red(`[${stage}] 失败：${failure.message}`))
    for (const line of failure.details) {
      console.log(`  ${c.red('✗')} ${line}`)
    }
    process.exitCode = 1
    throw error
  }
}

export class StageFailure extends Error {
  constructor(message, details = []) {
    super(message)
    this.name = 'StageFailure'
    this.details = details
  }
}
