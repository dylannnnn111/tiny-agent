// The agent: ask the model what to do, do it, show it what happened, repeat.
import type { Block, Message, Model, Text, ToolResult, ToolUse } from './llm.ts';
import { ALL_ON, makeTools } from './tools.ts';
import type { Features } from './tools.ts';

export type AgentOptions = {
  model: Model;
  workdir: string; // the only folder the tools can touch
  task: string;
  maxSteps?: number; // model calls before we give up
  contextBudget?: number; // rough token budget before old tool output gets trimmed
  features?: Partial<Features>; // switch harness parts off (see tools.ts); everything is on by default
  onEvent?: (e: AgentEvent) => void;
};

export type AgentEvent =
  | { type: 'model'; step: number; text: string; tools: string[] }
  | { type: 'tool'; step: number; name: string; input: Record<string, unknown>; output: string; error: boolean }
  | { type: 'trim'; step: number; removed: number };

export type AgentResult = {
  status: 'done' | 'max_steps';
  steps: number;
  toolCalls: number;
  inputTokens: number; // uncached input tokens
  outputTokens: number;
  cacheWriteTokens: number; // input tokens written to the prompt cache
  cacheReadTokens: number; // input tokens served from it
  summary: string; // the model's last words
  notes: string[];
  messages: Message[];
};

const SYSTEM = `You are a coding agent working in a small JavaScript project (Node.js, ES modules).
Use the tools to look around, make changes and run things. Check your work: run the tests if there are any, or write a quick check of your own.
When the task is done, reply with a one-paragraph summary of what you changed and do not call any more tools.`;

/**
 * What the model is told alongside each tool result: how many steps it has left, and its notes.
 * This goes at the end of the newest message rather than in the system prompt, so the earlier
 * conversation never changes and the prompt cache keeps working.
 */
function status(step: number, maxSteps: number, notes: string[], f: Features): Text | null {
  const parts: string[] = [];
  if (f.budget) {
    const left = maxSteps - step;
    parts.push(left <= 3 ? `Steps left: ${left} of ${maxSteps}. Finish with what you have.` : `Steps left: ${left} of ${maxSteps}.`);
  }
  if (f.notes && notes.length) parts.push(`Your notes:\n${notes.map((n) => `- ${n}`).join('\n')}`);
  return parts.length ? { type: 'text', text: parts.join('\n\n') } : null;
}

/** About four characters per token is close enough for deciding when to trim. */
const tokens = (messages: Message[]) => JSON.stringify(messages).length / 4;

/**
 * Keep the conversation under budget by blanking the oldest tool output first.
 * The model's own messages stay, so it still knows what it did, and the latest round is never touched.
 */
export function trim(messages: Message[], budget: number): number {
  let removed = 0;
  for (let i = 0; i < messages.length - 2 && tokens(messages) > budget; i++) {
    const m = messages[i];
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result' && !b.content.startsWith('[trimmed')) {
        b.content = `[trimmed ${b.content.length} characters to save space - run the tool again if you need this]`;
        removed++;
      }
    }
  }
  return removed;
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const { model, workdir, task, maxSteps = 30, onEvent = () => {} } = opts;
  const f: Features = { ...ALL_ON, ...opts.features };
  const contextBudget = f.trim ? (opts.contextBudget ?? 40_000) : Infinity;
  const tools = makeTools(workdir, f);
  const notes: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  let toolCalls = 0;
  let summary = '';

  const first = status(0, maxSteps, notes, f);
  const messages: Message[] = [{ role: 'user', content: first ? [{ type: 'text', text: task }, first] : task }];

  for (let step = 1; step <= maxSteps; step++) {
    const removed = trim(messages, contextBudget);
    if (removed) onEvent({ type: 'trim', step, removed });

    // 1. Ask the model for its next move
    const reply = await model({ system: SYSTEM, messages, tools: tools.defs });
    usage.inputTokens += reply.usage.input_tokens;
    usage.outputTokens += reply.usage.output_tokens;
    usage.cacheWriteTokens += reply.usage.cache_creation_input_tokens ?? 0;
    usage.cacheReadTokens += reply.usage.cache_read_input_tokens ?? 0;
    messages.push({ role: 'assistant', content: reply.content });

    const text = reply.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    const calls = reply.content.filter((b): b is ToolUse => b.type === 'tool_use');
    onEvent({ type: 'model', step, text, tools: calls.map((c) => c.name) });
    if (text) summary = text;

    // 2. No tool calls means it thinks it's finished
    if (calls.length === 0) {
      return { status: 'done', steps: step, toolCalls, ...usage, summary, notes, messages };
    }

    // 3. Run every tool it asked for and hand back the results, errors included
    const results: ToolResult[] = calls.map((call) => {
      toolCalls++;
      let output: string;
      let error = false;
      try {
        if (call.name === 'note' && f.notes) {
          notes.push(String(call.input.text ?? ''));
          output = 'Saved.';
        } else output = tools.run(call.name, call.input);
      } catch (e) {
        output = `Error: ${(e as Error).message}`;
        error = true;
      }
      onEvent({ type: 'tool', step, name: call.name, input: call.input, output, error });
      return { type: 'tool_result', tool_use_id: call.id, content: output, ...(error ? { is_error: true } : {}) };
    });
    const tail = status(step, maxSteps, notes, f);
    messages.push({ role: 'user', content: (tail ? [...results, tail] : results) satisfies Block[] });
  }
  return { status: 'max_steps', steps: maxSteps, toolCalls, ...usage, summary, notes, messages };
}
