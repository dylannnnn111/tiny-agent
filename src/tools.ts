// The agent's hands: a handful of tools that only work inside one folder.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ToolDef } from './llm.ts';

export const MAX_OUTPUT = 8000; // characters of any one tool result the model gets to see

/** Which parts of the harness are switched on. Every one can be turned off for the ablation. */
export type Features = {
  edit: boolean; // the str_replace tool (off: the only way to change a file is to rewrite all of it)
  feedback: boolean; // command output comes back (off: run_command returns the exit code and nothing else)
  trim: boolean; // old tool output is blanked when the conversation gets long
  notes: boolean; // the note tool, a scratchpad that survives trimming
  budget: boolean; // the model is told how many steps it has left (off: the limit is silent)
};

export const ALL_ON: Features = { edit: true, feedback: true, trim: true, notes: true, budget: true };

/** The configs the eval runs: everything on, each feature off on its own, and everything off. */
export const CONFIGS: Record<string, Features> = {
  full: ALL_ON,
  'no-edit': { ...ALL_ON, edit: false },
  'no-feedback': { ...ALL_ON, feedback: false },
  'no-trim': { ...ALL_ON, trim: false },
  'no-notes': { ...ALL_ON, notes: false },
  'no-budget': { ...ALL_ON, budget: false },
  bare: { edit: false, feedback: false, trim: false, notes: false, budget: false },
};

const str = { type: 'string' } as const;

export function toolDefs(f: Features = ALL_ON): ToolDef[] {
  const defs: ToolDef[] = [
    {
      name: 'list_files',
      description: 'List files in the project, recursively. Paths are relative to the project folder.',
      input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Folder to list. Default "."' } } },
    },
    {
      name: 'read_file',
      description: 'Read a text file from the project.',
      input_schema: { type: 'object', properties: { path: str }, required: ['path'] },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file with the full new contents. Folders are created as needed.',
      input_schema: { type: 'object', properties: { path: str, content: str }, required: ['path', 'content'] },
    },
  ];
  if (f.edit)
    defs.push({
      name: 'str_replace',
      description:
        'Edit a file by replacing one exact string with another. old_str must appear exactly once in the file (include enough surrounding lines to make it unique). Cheaper than rewriting the whole file.',
      input_schema: { type: 'object', properties: { path: str, old_str: str, new_str: str }, required: ['path', 'old_str', 'new_str'] },
    });
  defs.push({
    name: 'run_command',
    description: f.feedback
      ? 'Run a shell command in the project folder, for example "node --test" or "node script.js". Returns the exit code and output. Times out after 30 seconds.'
      : 'Run a shell command in the project folder, for example "node --test" or "node script.js". Returns only the exit code (0 means success); output is not shown. Times out after 30 seconds.',
    input_schema: { type: 'object', properties: { command: str }, required: ['command'] },
  });
  if (f.notes)
    defs.push({
      name: 'note',
      description: 'Save a short note to your memory. Notes are repeated back to you every step, even after old tool output is trimmed from the conversation.',
      input_schema: { type: 'object', properties: { text: str }, required: ['text'] },
    });
  return defs;
}

export const TOOL_DEFS = toolDefs();

// A speed bump, not a sandbox: run the agent somewhere disposable (see the README).
const BLOCKED = [/\bsudo\b/, /\brm\s+-[a-z]*r[a-z]*f?\s+[\/~]/i, /\bcurl\b.*\|\s*(ba)?sh/, /\bgit\s+push\b/, /\bnpm\s+publish\b/];

function clip(s: string): string {
  return s.length <= MAX_OUTPUT ? s : `${s.slice(0, MAX_OUTPUT / 2)}\n... [${s.length - MAX_OUTPUT} characters cut] ...\n${s.slice(-MAX_OUTPUT / 2)}`;
}

export function makeTools(root: string, features: Features = ALL_ON) {
  const base = resolve(root);
  /** Resolve a path and refuse anything outside the project folder. */
  const inside = (p: unknown): string => {
    const full = resolve(base, String(p ?? '.'));
    if (full !== base && !full.startsWith(base + sep)) throw new Error(`${p} is outside the project folder`);
    return full;
  };

  const list = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (name === 'node_modules' || name === '.git') return [];
      const full = join(dir, name);
      return statSync(full).isDirectory() ? list(full) : [relative(base, full)];
    });

  const run = (name: string, input: Record<string, unknown>): string => {
    switch (name) {
      case 'list_files': {
        const files = list(inside(input.path ?? '.'));
        return files.length ? files.join('\n') : '(no files)';
      }
      case 'read_file': {
        const p = inside(input.path);
        if (!existsSync(p)) throw new Error(`no such file: ${input.path}`);
        return clip(readFileSync(p, 'utf8'));
      }
      case 'write_file': {
        const p = inside(input.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(input.content ?? ''));
        return `Wrote ${String(input.content ?? '').length} characters to ${input.path}`;
      }
      case 'str_replace': {
        if (!features.edit) throw new Error('unknown tool str_replace');
        const p = inside(input.path);
        if (!existsSync(p)) throw new Error(`no such file: ${input.path}`);
        const text = readFileSync(p, 'utf8');
        const oldStr = String(input.old_str ?? '');
        if (!oldStr) throw new Error('old_str is empty');
        const count = text.split(oldStr).length - 1;
        if (count !== 1) throw new Error(count === 0 ? `old_str was not found in ${input.path} (it must match exactly, whitespace included)` : `old_str appears ${count} times in ${input.path}; include more surrounding text so it matches once`);
        const next = text.replace(oldStr, () => String(input.new_str ?? ''));
        writeFileSync(p, next);
        const line = text.slice(0, text.indexOf(oldStr)).split('\n').length;
        return `Replaced ${oldStr.length} characters at line ${line} of ${input.path}`;
      }
      case 'run_command': {
        const cmd = String(input.command ?? '');
        if (BLOCKED.some((re) => re.test(cmd))) throw new Error('that command is not allowed here');
        const r = spawnSync(cmd, {
          cwd: base,
          shell: true,
          encoding: 'utf8',
          timeout: 30_000,
          // A clean environment: in particular the API key never reaches commands the model writes
          env: { PATH: process.env.PATH, HOME: base, TZ: process.env.TZ ?? 'UTC', NODE_NO_WARNINGS: '1' },
        });
        const timedOut = (r.error as { code?: string } | undefined)?.code === 'ETIMEDOUT';
        const code = `exit code: ${timedOut ? 'timed out after 30s' : r.status}`;
        if (!features.feedback) return code;
        return clip(`${code}\n${r.stdout ?? ''}${r.stderr ?? ''}`.trim());
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  };
  return { defs: toolDefs(features), run, features };
}
