// The benchmark: 20 small coding tasks, one JSON file each in tasks/. Every task has starter files
// the agent sees, hidden tests it never sees, and a reference solution used only to prove the task is fair.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Files = Record<string, string>; // path -> contents
export type Task = {
  id: string;
  title: string;
  kind: string;
  prompt: string;
  solutionRun?: string; // a command to run after applying the solution (e.g. to generate a file)
  files: Files;
  check: Files;
  solution: Files;
};

export const TASKS_DIR = new URL('../tasks/', import.meta.url).pathname;

export function loadTasks(only?: string[]): Task[] {
  return readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(TASKS_DIR, f), 'utf8')) as Task)
    .filter((t) => !only?.length || only.some((o) => t.id.includes(o)));
}

export function writeFiles(root: string, files: Files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A fresh temporary folder with the task's starter files. */
export function prepare(task: Task): string {
  const work = mkdtempSync(join(tmpdir(), `tiny-agent-${task.id}-`));
  writeFiles(work, task.files);
  return work;
}

/** Copy the hidden tests in and run them. Passing means every test passed. */
export function grade(task: Task, work: string): { passed: boolean; output: string } {
  writeFiles(join(work, '__check__'), task.check);
  const files = Object.keys(task.check).map((f) => join('__check__', f));
  // Drop NODE_TEST_CONTEXT: if this runs inside a test runner, a nested runner would report to it instead of exiting non-zero
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: work, encoding: 'utf8', timeout: 60_000, env });
  return { passed: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
