// The ablation: run the agent over every task for each config x model x run, grade with the hidden tests,
// and write results.json. Resumable - run it again with the same NAME and finished cells are skipped.
//
//   ANTHROPIC_API_KEY=... npm run eval                      full config, newest Sonnet, one run, all 40 tasks
//   npm run eval -- 03 29                                   only tasks whose id contains 03 or 29
//
// Options (environment variables):
//   CONFIGS=full,no-edit      which configs (see src/tools.ts). "all" = every config. Default: full
//   MODELS=sonnet,haiku       model ids, or a family name for the newest of that family. Default: sonnet
//   RUNS=2                    repeats of every config x model, to see the noise. Default: 1
//   NAME=ablation             folder under runs/ to write to (and resume from). Default: today's date
//   CONCURRENCY=3             tasks running at the same time. Default: 2
//   MAX_STEPS=30              model calls per task before giving up
//   DRY=1                     list the cells that would run and the ones already done, then stop
// Prices come from prices.json ($ per million tokens, matched by substring of the model id).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from '../src/agent.ts';
import type { AgentEvent, AgentResult } from '../src/agent.ts';
import { claude, resolveModel } from '../src/llm.ts';
import type { Model } from '../src/llm.ts';
import { grade, loadTasks, prepare } from '../src/tasks.ts';
import type { Task } from '../src/tasks.ts';
import { CONFIGS } from '../src/tools.ts';
import type { Features } from '../src/tools.ts';

const key = process.env.ANTHROPIC_API_KEY;
if (!key && !process.env.DRY) {
  console.error('Set ANTHROPIC_API_KEY first (or use npm run eval:keychain).');
  process.exit(1);
}
const list = (s: string | undefined, fallback: string) => (s || fallback).split(',').map((x) => x.trim()).filter(Boolean);
const configNames = list(process.env.CONFIGS, 'full').flatMap((c) => (c === 'all' ? Object.keys(CONFIGS) : [c]));
for (const c of configNames) if (!CONFIGS[c]) throw new Error(`Unknown config ${c}. Pick from: ${Object.keys(CONFIGS).join(', ')}`);
const modelNames = await Promise.all(list(process.env.MODELS, process.env.MODEL || 'sonnet').map((m) => (key ? resolveModel(key, m) : m)));
const RUNS = Number(process.env.RUNS ?? 1);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 30);
const NAME = process.env.NAME || new Date().toISOString().slice(0, 10);
const outDir = join('runs', NAME);
mkdirSync(outDir, { recursive: true });

type Price = { input: number; output: number };
const prices: Record<string, Price> = existsSync('prices.json') ? JSON.parse(readFileSync('prices.json', 'utf8')) : {};
const priceFor = (model: string): Price | null => {
  const hit = Object.keys(prices).find((k) => model.includes(k));
  return hit ? prices[hit] : null;
};
/** Cache writes cost 1.25x the input price and cache reads 0.1x (Anthropic's standard ratios). */
const costOf = (r: Pick<AgentResult, 'inputTokens' | 'outputTokens' | 'cacheWriteTokens' | 'cacheReadTokens'>, p: Price | null) =>
  p === null ? null : Math.round(((r.inputTokens + 1.25 * r.cacheWriteTokens + 0.1 * r.cacheReadTokens) * p.input + r.outputTokens * p.output) / 1e6 * 10000) / 10000;

const tasks = loadTasks(process.argv.slice(2));
const allTasks = loadTasks();

export type Cell = {
  model: string;
  config: string;
  run: number;
  task: string;
  kind: string;
  passed: boolean;
  status: string; // done | max_steps | error
  category: string | null; // why it failed, from the transcript (null when it passed)
  steps: number;
  toolCalls: number;
  edits: number; // str_replace calls
  rewrites: number; // write_file calls
  runs: number; // run_command calls
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cost: number | null;
  seconds: number;
  failure?: string;
};

/**
 * A first pass at why a task failed, from what the agent did. Reading the transcript is the real answer;
 * this just sorts them into piles.
 */
function categorise(r: AgentResult, events: AgentEvent[], g: { passed: boolean; output: string }): string | null {
  if (g.passed) return null;
  if (r.status === 'max_steps') return 'ran out of steps';
  const cmds = events.filter((e): e is Extract<AgentEvent, { type: 'tool' }> => e.type === 'tool' && e.name === 'run_command');
  if (!cmds.length) return 'never ran anything';
  const last = cmds[cmds.length - 1].output;
  if (/timed out/i.test(g.output)) return 'hidden tests timed out';
  if (/^exit code: 0/.test(last)) return 'its own check passed, hidden tests failed';
  return 'stopped with a failing check';
}

const cellFile = (model: string, config: string, run: number, task: string) => join(outDir, model, config, `run${run}`, `${task}.json`);
const done = (model: string, config: string, run: number, task: string): Cell | null => {
  const f = cellFile(model, config, run, task);
  if (!existsSync(f)) return null;
  const saved = JSON.parse(readFileSync(f, 'utf8'));
  return saved.cell ?? null;
};

async function one(model: Model, modelName: string, config: string, run: number, t: Task): Promise<Cell> {
  const work = prepare(t);
  const events: AgentEvent[] = [];
  const t0 = Date.now();
  try {
    const r = await runAgent({ model, workdir: work, task: t.prompt, maxSteps: MAX_STEPS, features: CONFIGS[config], onEvent: (e) => events.push(e) });
    const g = grade(t, work);
    const failure = g.passed
      ? undefined
      : g.output
          .split('\n')
          .filter((l) => /not ok|Error|expected|actual|timed out/i.test(l))
          .slice(0, 6)
          .join('\n');
    const count = (name: string) => events.filter((e) => e.type === 'tool' && e.name === name).length;
    const cell: Cell = {
      model: modelName,
      config,
      run,
      task: t.id,
      kind: t.kind,
      passed: g.passed,
      status: r.status,
      category: categorise(r, events, g),
      steps: r.steps,
      toolCalls: r.toolCalls,
      edits: count('str_replace'),
      rewrites: count('write_file'),
      runs: count('run_command'),
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      cacheReadTokens: r.cacheReadTokens,
      cost: costOf(r, priceFor(modelName)),
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      ...(failure ? { failure } : {}),
    };
    const f = cellFile(modelName, config, run, t.id);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, JSON.stringify({ cell, task: { id: t.id, title: t.title, prompt: t.prompt }, summary: r.summary, notes: r.notes, events, grade: g, messages: r.messages }, null, 2));
    return cell;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Every cell to run, skipping the ones already on disk
type Job = { modelName: string; config: string; run: number; task: Task };
const jobs: Job[] = [];
const cells: Cell[] = [];
for (const modelName of modelNames)
  for (const config of configNames)
    for (let run = 1; run <= RUNS; run++)
      for (const task of tasks) {
        const prev = done(modelName, config, run, task.id);
        if (prev) cells.push(prev);
        else jobs.push({ modelName, config, run, task });
      }
console.log(`${NAME}: ${modelNames.join(', ')} x ${configNames.join(', ')} x ${RUNS} run(s) x ${tasks.length} tasks = ${cells.length + jobs.length} cells, ${cells.length} already done, ${jobs.length} to run.`);
if (process.env.DRY) process.exit(0);

const models = Object.fromEntries(modelNames.map((m) => [m, claude(m, key!)]));
const label = (j: Job) => `${j.modelName.replace(/^claude-/, '')} ${j.config.padEnd(11)} r${j.run} ${j.task.id.padEnd(28)}`;
let next = 0;
let spent = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      try {
        const c = await one(models[j.modelName], j.modelName, j.config, j.run, j.task);
        cells.push(c);
        spent += c.cost ?? 0;
        console.log(`${c.passed ? 'pass' : 'FAIL'}  ${label(j)} ${String(c.steps).padStart(2)} steps ${String(c.seconds).padStart(6)}s${c.cost === null ? '' : `  $${c.cost.toFixed(3)}`}${c.category ? `  (${c.category})` : ''}   spent so far $${spent.toFixed(2)}`);
      } catch (e) {
        console.log(`ERROR ${label(j)}: ${(e as Error).message}`);
        cells.push({ model: j.modelName, config: j.config, run: j.run, task: j.task.id, kind: j.task.kind, passed: false, status: 'error', category: 'error', steps: 0, toolCalls: 0, edits: 0, rewrites: 0, runs: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, cost: null, seconds: 0, failure: (e as Error).message });
      }
    }
  }),
);

// Summarise: one row per model x config, with the spread across runs
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const summary = modelNames.flatMap((model) =>
  configNames.map((config) => {
    const mine = cells.filter((c) => c.model === model && c.config === config);
    const perRun = Array.from({ length: RUNS }, (_, i) => mine.filter((c) => c.run === i + 1));
    const passRates = perRun.map((r) => (r.length ? r.filter((c) => c.passed).length / r.length : 0));
    const costs = mine.map((c) => c.cost);
    const failures: Record<string, number> = {};
    for (const c of mine) if (c.category) failures[c.category] = (failures[c.category] ?? 0) + 1;
    const byKind: Record<string, { passed: number; total: number }> = {};
    for (const c of mine) {
      byKind[c.kind] ??= { passed: 0, total: 0 };
      byKind[c.kind].total++;
      if (c.passed) byKind[c.kind].passed++;
    }
    return {
      model,
      config,
      features: CONFIGS[config],
      runs: RUNS,
      passed: mine.filter((c) => c.passed).length,
      total: mine.length,
      passRate: Math.round(mean(passRates) * 1000) / 1000,
      passRateMin: Math.min(...passRates),
      passRateMax: Math.max(...passRates),
      meanSteps: Math.round(mean(mine.map((c) => c.steps)) * 10) / 10,
      meanSeconds: Math.round(mean(mine.map((c) => c.seconds)) * 10) / 10,
      inputTokens: sum(mine.map((c) => c.inputTokens + c.cacheWriteTokens + c.cacheReadTokens)),
      outputTokens: sum(mine.map((c) => c.outputTokens)),
      cacheHitRate: Math.round((sum(mine.map((c) => c.cacheReadTokens)) / Math.max(1, sum(mine.map((c) => c.inputTokens + c.cacheWriteTokens + c.cacheReadTokens)))) * 1000) / 1000,
      cost: costs.every((c) => c === null) ? null : Math.round(sum(costs.map((c) => c ?? 0)) * 100) / 100,
      failures,
      byKind,
    };
  }),
);

const results = {
  name: NAME,
  date: new Date().toISOString().slice(0, 10),
  maxSteps: MAX_STEPS,
  models: modelNames,
  configs: Object.fromEntries(configNames.map((c) => [c, CONFIGS[c]])),
  prices: Object.fromEntries(modelNames.map((m) => [m, priceFor(m)])),
  tasks: allTasks.map((t) => ({ id: t.id, title: t.title, kind: t.kind })),
  summary,
  cells: cells.sort((a, b) => a.model.localeCompare(b.model) || a.config.localeCompare(b.config) || a.run - b.run || a.task.localeCompare(b.task)),
};
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
const complete = tasks.length === allTasks.length;
if (complete) writeFileSync('results.json', JSON.stringify(results, null, 2));

console.log('');
for (const s of summary) console.log(`${s.model.replace(/^claude-/, '').padEnd(28)} ${s.config.padEnd(12)} ${(s.passRate * 100).toFixed(0).padStart(3)}% (${s.passed}/${s.total}, runs ${(s.passRateMin * 100).toFixed(0)}-${(s.passRateMax * 100).toFixed(0)}%)  ${s.meanSteps} steps/task${s.cost === null ? '' : `  $${s.cost.toFixed(2)}`}`);
const total = sum(cells.map((c) => c.cost ?? 0));
console.log(`\nTranscripts in ${outDir}/${complete ? ', summary copied to results.json' : ' (partial task list, so results.json at the root was not touched)'}.${total ? ` Total cost about $${total.toFixed(2)}.` : ' No prices.json entry matched, so no cost.'}`);

// Leftover temp folders from crashed runs are harmless but worth knowing about
const stale = readdirSync(join(process.env.TMPDIR ?? '/tmp')).filter((f) => f.startsWith('tiny-agent-')).length;
if (stale > 20) console.log(`(${stale} old tiny-agent-* folders in your temp dir - safe to delete)`);
