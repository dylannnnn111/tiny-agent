import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, trim } from '../src/agent.ts';
import type { Message, Model, Reply, Request } from '../src/llm.ts';
import { CONFIGS, makeTools } from '../src/tools.ts';
import { grade, loadTasks, prepare } from '../src/tasks.ts';

// A fake model that plays back a script, so the loop can be tested without an API key.
type Turn = Reply['content'];
function scripted(turns: Turn[], seen: Request[] = []): Model {
  let i = 0;
  return async (req) => {
    seen.push(structuredClone(req));
    const content = turns[Math.min(i++, turns.length - 1)];
    return { content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } };
  };
}
const use = (name: string, input: Record<string, unknown>, id = `t${Math.random()}`) => ({ type: 'tool_use' as const, id, name, input });
const say = (text: string) => ({ type: 'text' as const, text });
const tmp = () => mkdtempSync(join(tmpdir(), 'tiny-agent-test-'));

test('stops when the model stops calling tools', async () => {
  const dir = tmp();
  const r = await runAgent({ model: scripted([[say('Nothing to do.')]]), workdir: dir, task: 'hi' });
  assert.equal(r.cacheReadTokens, 0);
  assert.equal(r.status, 'done');
  assert.equal(r.steps, 1);
  assert.equal(r.summary, 'Nothing to do.');
  rmSync(dir, { recursive: true });
});

test('runs tools and feeds the results back', async () => {
  const dir = tmp();
  const seen: Request[] = [];
  const model = scripted(
    [
      [say('Writing it.'), use('write_file', { path: 'src/a.js', content: 'export const a = 1;\n' }, 'w1')],
      [use('run_command', { command: 'node -e "import(\'./src/a.js\').then(m => console.log(m.a + 1))"' }, 'r1')],
      [say('Done: a.js exports 1.')],
    ],
    seen,
  );
  const r = await runAgent({ model, workdir: dir, task: 'make a.js' });
  assert.equal(r.status, 'done');
  assert.equal(r.toolCalls, 2);
  assert.equal(readFileSync(join(dir, 'src/a.js'), 'utf8'), 'export const a = 1;\n');
  const last = seen[2].messages[seen[2].messages.length - 1];
  assert.ok(Array.isArray(last.content) && last.content[0].type === 'tool_result');
  assert.match((last.content[0] as { content: string }).content, /exit code: 0\n2/);
  assert.equal(r.inputTokens, 300);
  rmSync(dir, { recursive: true });
});

test('tool errors go back to the model instead of crashing the loop', async () => {
  const dir = tmp();
  const seen: Request[] = [];
  const r = await runAgent({ model: scripted([[use('read_file', { path: 'missing.js' })], [say('ok')]], seen), workdir: dir, task: 'x' });
  assert.equal(r.status, 'done');
  const result = (seen[1].messages[2].content as { type: string; is_error?: boolean; content: string }[])[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /no such file/);
  rmSync(dir, { recursive: true });
});

test('tools cannot reach outside the project folder', () => {
  const dir = tmp();
  const t = makeTools(dir);
  assert.throws(() => t.run('read_file', { path: '../../etc/passwd' }), /outside the project/);
  assert.throws(() => t.run('write_file', { path: '/tmp/escape.txt', content: 'x' }), /outside the project/);
  assert.throws(() => t.run('run_command', { command: 'sudo ls' }), /not allowed/);
  rmSync(dir, { recursive: true });
});

test('commands do not see the API key', () => {
  const dir = tmp();
  process.env.ANTHROPIC_API_KEY = 'sk-test-secret';
  const out = makeTools(dir).run('run_command', { command: 'env' });
  assert.ok(!out.includes('sk-test-secret'));
  delete process.env.ANTHROPIC_API_KEY;
  rmSync(dir, { recursive: true });
});

test('long output is clipped', () => {
  const dir = tmp();
  const out = makeTools(dir).run('run_command', { command: 'node -e "console.log(\'x\'.repeat(50000))"' });
  assert.ok(out.length < 9000);
  assert.match(out, /characters cut/);
  rmSync(dir, { recursive: true });
});

test('gives up at the step limit', async () => {
  const dir = tmp();
  const r = await runAgent({ model: scripted([[use('list_files', {})]]), workdir: dir, task: 'loop', maxSteps: 4 });
  assert.equal(r.status, 'max_steps');
  assert.equal(r.steps, 4);
  rmSync(dir, { recursive: true });
});

const lastText = (req: Request) => {
  const m = req.messages[req.messages.length - 1];
  return typeof m.content === 'string' ? m.content : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
};

test('notes come back at the end of every later message', async () => {
  const dir = tmp();
  const seen: Request[] = [];
  await runAgent({ model: scripted([[use('note', { text: 'tests live in test/' })], [use('list_files', {})], [say('ok')]], seen), workdir: dir, task: 'x' });
  assert.ok(!lastText(seen[0]).includes('tests live in test/'));
  assert.ok(lastText(seen[1]).includes('- tests live in test/'));
  assert.ok(lastText(seen[2]).includes('- tests live in test/'));
  assert.ok(!seen[2].system.includes('tests live'), 'the system prompt never changes');
  rmSync(dir, { recursive: true });
});

test('the model is told its step budget, unless that is switched off', async () => {
  const dir = tmp();
  const seen: Request[] = [];
  await runAgent({ model: scripted([[use('list_files', {})], [use('list_files', {})], [say('ok')]], seen), workdir: dir, task: 'x', maxSteps: 4 });
  assert.match(lastText(seen[0]), /Steps left: 4 of 4/);
  assert.match(lastText(seen[1]), /Steps left: 3 of 4\. Finish/);
  const quiet: Request[] = [];
  await runAgent({ model: scripted([[use('list_files', {})], [say('ok')]], quiet), workdir: dir, task: 'x', features: { budget: false } });
  assert.equal(quiet[0].messages[0].content, 'x');
  assert.ok(!lastText(quiet[1]).includes('Steps left'));
  rmSync(dir, { recursive: true });
});

test('str_replace edits one exact match and refuses anything else', () => {
  const dir = tmp();
  const t = makeTools(dir);
  t.run('write_file', { path: 'a.js', content: 'let x = 1;\nlet y = 1;\nlet z = 2;\n' });
  assert.match(t.run('str_replace', { path: 'a.js', old_str: 'let z = 2;', new_str: 'let z = 3;' }), /line 3/);
  assert.equal(readFileSync(join(dir, 'a.js'), 'utf8'), 'let x = 1;\nlet y = 1;\nlet z = 3;\n');
  assert.throws(() => t.run('str_replace', { path: 'a.js', old_str: '= 1;', new_str: '= 0;' }), /appears 2 times/);
  assert.throws(() => t.run('str_replace', { path: 'a.js', old_str: 'nope', new_str: '' }), /not found/);
  assert.throws(() => t.run('str_replace', { path: 'missing.js', old_str: 'a', new_str: 'b' }), /no such file/);
  rmSync(dir, { recursive: true });
});

test('feature switches change the tools on offer and what they return', () => {
  const dir = tmp();
  const full = makeTools(dir);
  assert.deepEqual(full.defs.map((d) => d.name), ['list_files', 'read_file', 'write_file', 'str_replace', 'run_command', 'note']);
  const bare = makeTools(dir, CONFIGS.bare);
  assert.deepEqual(bare.defs.map((d) => d.name), ['list_files', 'read_file', 'write_file', 'run_command']);
  assert.throws(() => bare.run('str_replace', { path: 'a', old_str: 'a', new_str: 'b' }), /unknown tool/);
  assert.equal(bare.run('run_command', { command: 'echo hello; exit 3' }), 'exit code: 3');
  assert.match(full.run('run_command', { command: 'echo hello; exit 3' }), /exit code: 3\nhello/);
  rmSync(dir, { recursive: true });
});

test('with trimming off the conversation is never touched', async () => {
  const dir = tmp();
  const seen: Request[] = [];
  const big = 'z'.repeat(30_000);
  const turns = [[use('write_file', { path: 'big.txt', content: big })], [use('read_file', { path: 'big.txt' })], [use('read_file', { path: 'big.txt' })], [say('ok')]];
  await runAgent({ model: scripted(turns, seen), workdir: dir, task: 'x', contextBudget: 8_000, features: { trim: false } });
  assert.ok(!JSON.stringify(seen[3].messages).includes('[trimmed'));
  const trimmed: Request[] = [];
  await runAgent({ model: scripted(turns, trimmed), workdir: dir, task: 'x', contextBudget: 8_000 });
  assert.ok(JSON.stringify(trimmed[3].messages).includes('[trimmed'));
  rmSync(dir, { recursive: true });
});

test('trimming blanks the oldest tool output first and keeps the latest round', () => {
  const big = 'y'.repeat(20_000);
  const round = (id: string): Message[] => [
    { role: 'assistant', content: [use('read_file', { path: 'a' }, id)] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: big }] },
  ];
  const messages: Message[] = [{ role: 'user', content: 'task' }, ...round('1'), ...round('2'), ...round('3')];
  const removed = trim(messages, 8_000);
  assert.equal(removed, 2);
  const results = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result') as { content: string }[];
  assert.match(results[0].content, /^\[trimmed 20000/);
  assert.match(results[1].content, /^\[trimmed/);
  assert.equal(results[2].content, big);
});

test('the grader passes a correct fix and fails the starter', async () => {
  const [task] = loadTasks(['01-']);
  const starter = prepare(task);
  assert.equal(grade(task, starter).passed, false);
  const fixed = prepare(task);
  // A scripted "agent" that applies the reference fix through the real tools
  const fix = task.solution['fizzbuzz.js'];
  await runAgent({ model: scripted([[use('write_file', { path: 'fizzbuzz.js', content: fix })], [say('fixed')]]), workdir: fixed, task: task.prompt });
  assert.equal(grade(task, fixed).passed, true);
  for (const d of [starter, fixed]) rmSync(d, { recursive: true });
});
