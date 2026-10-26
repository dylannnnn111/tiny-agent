# Tiny Agent

[![CI](https://github.com/dylannnnn111/tiny-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/dylannnnn111/tiny-agent/actions/workflows/ci.yml)

A coding agent in about 300 lines of TypeScript, with nothing hidden: no SDK, no framework, plain `fetch` to the Claude API. It can list, read, edit and write files and run commands in one folder, and it keeps going until it decides the job is done.

The interesting part is the ablation. Every piece of the harness around the model has a switch, and the eval runs the same 40 tasks with each piece turned off, so you can see what each one is actually worth.

Write-up: https://dylanlewis.au/projects/tiny-agent - the loop explained line by line, and the results.

## What's in it

- `src/agent.ts` - the loop. Ask the model, run the tools it asks for, hand back the results (errors included), repeat until it stops calling tools or hits the step limit. Each tool-result message ends with a short status: steps left, and the model's own notes.
- `src/tools.ts` - `list_files`, `read_file`, `write_file`, `str_replace`, `run_command` and `note`, plus the feature switches. Paths can't leave the project folder, output is clipped, and commands run with a clean environment so the API key never reaches them.
- `src/llm.ts` - one function that calls the Messages API, with prompt caching and retries for rate limits and dropped connections.
- `tasks/` - 40 JavaScript tasks, one JSON file each. Each has starter files the agent sees, hidden tests it never sees, and a reference solution. Tasks 1-20 are small (bug fixes, new functions, a couple of features and data jobs). Tasks 21-40 are harder: changes across several files, vague specs, bugs you can only find by reading the failing test output, a slow function to speed up, and traps that reward the lazy route (hard-coding the visible tests, editing the tests, copying the golden file, trusting a wrong hint).
- `src/tasks.ts`, `scripts/eval.ts` - copy a task into a temp folder, run the agent, then copy in the hidden tests and grade it.

## The switches

| Switch | On | Off |
| --- | --- | --- |
| `edit` | `str_replace` tool for small edits | the only way to change a file is to rewrite it in full |
| `feedback` | `run_command` returns the exit code and the output | it returns the exit code only |
| `trim` | old tool output is blanked once the conversation passes ~40k tokens | the conversation only grows |
| `notes` | a `note` tool; notes are repeated back every step | no scratchpad |
| `budget` | the model is told how many steps it has left | the step limit is silent |

Configs (`src/tools.ts`): `full` (everything on), `no-edit`, `no-feedback`, `no-trim`, `no-notes`, `no-budget` (one switch off each), and `bare` (everything off).

## Run it

Needs Node 22.6 or later (uses Node's built-in TypeScript support, so there's nothing to install).

```sh
npm test               # 14 tests of the loop, tools and switches, using a scripted fake model (no API key needed)
npm run check-tasks    # proves every task is fair: starter fails the hidden tests, reference solution passes

# One config, newest Sonnet, every task
ANTHROPIC_API_KEY=... npm run eval
npm run eval:keychain                     # reads the key from the macOS Keychain instead

# The ablation: every config, two models, two runs each, resumable under runs/ablation/
CONFIGS=all MODELS=sonnet,haiku RUNS=2 NAME=ablation npm run eval:keychain
npm run eval -- 29 34                     # just some tasks (results.json at the root is only written for full runs)
DRY=1 CONFIGS=all RUNS=2 NAME=ablation npm run eval   # count the cells, and how many are already done

# Point it at your own folder
ANTHROPIC_API_KEY=... npm run agent -- ./some-copy "make the tests pass"
CONFIG=bare MODEL=haiku npm run agent -- ./some-copy "make the tests pass"
```

`MODELS` takes model ids or family names (`sonnet`, `haiku`, `opus` mean the newest of that family your key can use). `CONCURRENCY` (default 2) is how many tasks run at once. `MAX_STEPS` (default 30) is model calls per task. Costs come from `prices.json` ($ per million tokens for input, output, cache writes and cache reads, matched by substring of the model id; the file has Sonnet 5.5, Haiku 5.5 and Opus 5.5 as of October 2026). Check it against Anthropic's pricing page before a run you care about. Haiku 5.5 charges more for prompts over 100K tokens; that tier isn't modelled because no request here gets near it. Finished cells are re-priced from their saved token counts every time eval runs, so after changing prices, rerun the same command with full model ids and no API calls are made.

Every cell (model x config x run x task) is written to `runs/<NAME>/...` as soon as it finishes, with the full transcript, so a crash or a Ctrl-C loses at most the cells in flight; run the same command again and it carries on. `results.json` has a row per cell, a summary per model x config (pass rate, the spread across runs, steps, tokens, cost, failure categories, pass rate by task kind), and the task list.

## Safety

The agent runs real shell commands on your machine. They run inside the task folder with a stripped-down environment, and a few obviously dangerous commands are refused, but that is a speed bump, not a sandbox. The benchmark only ever gives it a temporary copy of a task. If you point it at your own work, use a copy, or run it in a container.

The Dockerfile does that: the container only sees the folder you mount and runs as an unprivileged user.

```
docker build -t tiny-agent .
docker run --rm -it -e ANTHROPIC_API_KEY -v "$PWD/some-copy:/work" tiny-agent "make the tests pass"
```

## Licence

MIT
