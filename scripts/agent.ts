// Point the agent at any folder and give it a job.
//   ANTHROPIC_API_KEY=... npm run agent -- path/to/folder "make the tests pass"
//   MODEL=haiku CONFIG=bare ... to pick a model family (or id) and a harness config
// It can read, write and run commands inside that folder, so use a copy you don't mind it changing.
import { runAgent } from '../src/agent.ts';
import { claude, resolveModel } from '../src/llm.ts';
import { CONFIGS } from '../src/tools.ts';

const [dir, ...words] = process.argv.slice(2);
const key = process.env.ANTHROPIC_API_KEY;
if (!dir || !words.length || !key) {
  console.error('Usage: ANTHROPIC_API_KEY=... npm run agent -- <folder> "<task>"');
  process.exit(1);
}
const name = await resolveModel(key, process.env.MODEL || 'sonnet');
const config = process.env.CONFIG || 'full'; // any config from src/tools.ts, e.g. CONFIG=bare
if (!CONFIGS[config]) throw new Error(`Unknown config ${config}. Pick from: ${Object.keys(CONFIGS).join(', ')}`);
const r = await runAgent({
  model: claude(name, key),
  workdir: dir,
  task: words.join(' '),
  features: CONFIGS[config],
  onEvent: (e) => {
    if (e.type === 'model' && e.text) console.log(`\n[${e.step}] ${e.text}`);
    if (e.type === 'tool') console.log(`  ${e.error ? '!' : '>'} ${e.name} ${JSON.stringify(e.input).slice(0, 120)}`);
    if (e.type === 'trim') console.log(`  (trimmed ${e.removed} old tool results)`);
  },
});
console.log(`\n${r.status === 'done' ? 'Done' : 'Stopped at the step limit'}: ${r.steps} steps, ${r.toolCalls} tool calls, ${r.inputTokens + r.outputTokens} tokens.`);
