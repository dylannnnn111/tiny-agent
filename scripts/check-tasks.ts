// Prove every task is fair: the starter files fail the hidden tests, and the reference solution passes them.
//   npm run check-tasks
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { grade, loadTasks, prepare, writeFiles } from '../src/tasks.ts';

let bad = 0;
for (const t of loadTasks(process.argv.slice(2))) {
  const before = prepare(t);
  const starter = grade(t, before);
  rmSync(before, { recursive: true, force: true });

  const after = prepare(t);
  writeFiles(after, t.solution);
  if (t.solutionRun) execSync(t.solutionRun, { cwd: after });
  const solved = grade(t, after);
  rmSync(after, { recursive: true, force: true });

  const ok = !starter.passed && solved.passed;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${t.id.padEnd(24)} starter ${starter.passed ? 'passes (should fail)' : 'fails'}, solution ${solved.passed ? 'passes' : 'FAILS'}`);
  if (!solved.passed) console.log(solved.output.split('\n').filter((l) => /not ok|Error|expected|actual/.test(l)).slice(0, 8).join('\n'));
}
console.log(bad ? `\n${bad} task(s) need fixing` : '\nAll tasks are fair.');
process.exit(bad ? 1 : 0);
