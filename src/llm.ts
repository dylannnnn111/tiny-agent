// Talking to Claude: one function that sends the conversation and gets the next message back.
// Plain fetch against the Messages API, no SDK, so nothing is hidden.

export type Text = { type: 'text'; text: string };
export type ToolUse = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResult = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type Block = Text | ToolUse | ToolResult;
export type Message = { role: 'user' | 'assistant'; content: string | Block[] };
export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };

export type Request = { system: string; messages: Message[]; tools: ToolDef[] };
export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number; // tokens written to the prompt cache this call
  cache_read_input_tokens?: number; // tokens read from it (billed at a tenth of the price)
};
export type Reply = { content: (Text | ToolUse)[]; stop_reason: string; usage: Usage };

/** Anything that turns a request into a reply. The real one is Claude; tests use a scripted fake. */
export type Model = (req: Request) => Promise<Reply>;

const API = `${process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1`;
const headers = (key: string) => ({
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
});

const CACHE = { cache_control: { type: 'ephemeral' } };

/**
 * Mark the prompt for caching: the system prompt, and the last block of the last message.
 * The API looks back from that marker for the longest prefix it has already seen, so each step of
 * the loop only pays full price for what is new since the step before.
 */
function cached({ system, messages, tools }: Request) {
  const last = messages[messages.length - 1];
  const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
  const marked = content.map((b, i) => (i === content.length - 1 ? { ...b, ...CACHE } : b));
  return {
    system: [{ type: 'text', text: system, ...CACHE }],
    messages: [...messages.slice(0, -1), { role: last.role, content: marked }],
    tools,
  };
}

export function claude(model: string, apiKey: string, maxTokens = 4096): Model {
  return async (req) => {
    for (let attempt = 0; ; attempt++) {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let res: Response;
      try {
        res = await fetch(`${API}/messages`, {
          method: 'POST',
          headers: headers(apiKey),
          body: JSON.stringify({ model, max_tokens: maxTokens, ...cached(req) }),
        });
      } catch (e) {
        if (attempt >= 5) throw e; // the network dropped out; try again a few times
        await wait(2000 * 2 ** attempt);
        continue;
      }
      if (res.ok) return (await res.json()) as Reply;
      // Rate limits and overloads are worth waiting out; anything else is a real error
      const retry = res.status === 429 || res.status === 529 || res.status >= 500;
      if (!retry || attempt >= 5) throw new Error(`API ${res.status}: ${await res.text()}`);
      await wait(Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt);
    }
  };
}

/** The newest model of a family ("sonnet", "haiku", "opus") this key can use, so names don't go stale. */
export async function newest(apiKey: string, family = 'sonnet'): Promise<string> {
  const res = await fetch(`${API}/models?limit=100`, { headers: headers(apiKey) });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const { data } = (await res.json()) as { data: { id: string }[] }; // newest first
  const hit = data.find((m) => m.id.includes(family));
  if (!hit) throw new Error(`No ${family} model on this key. Pick one of: ${data.map((m) => m.id).join(', ')}`);
  return hit.id;
}

/** Turn "sonnet" into the newest Sonnet, and leave a full model id alone. */
export async function resolveModel(apiKey: string, name: string): Promise<string> {
  return /^(sonnet|haiku|opus)$/.test(name) ? newest(apiKey, name) : name;
}

export const newestSonnet = (apiKey: string) => newest(apiKey, 'sonnet');
