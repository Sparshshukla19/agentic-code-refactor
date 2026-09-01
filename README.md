# ⚡ AutoRefactor AI: Autonomous Agentic Codebase Refactoring Engine

> A closed-loop, neurosymbolic software engineering agent that refactors legacy codebases using Concrete Syntax Trees (CST), repository-scale dependency graphs, and autonomous self-healing compiler loops.

## Status

This is the project skeleton. Module stubs exist under `src/` with typed
signatures and `not yet implemented` throws — see the build order below.

## Setup

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY / OPENAI_API_KEY
```

## Build order

1. `src/types/` — shared interfaces (done)
2. `src/parser/` — ts-morph AST engine + dependency graph
3. `src/planner/` — task scheduler + context slicer
4. `src/agent/` — LLM client, Zod tool schemas, ReAct loop
5. `src/sandbox/` — process runner, type checker, linter, test runner, reflector
6. `src/vcs/` — git manager, diff generator, PR generator
7. `src/cli/` — Commander.js commands wiring it together
8. `src/server/` — live visualizer dashboard (SSE)

## Try it against the sample target

`test-target/` contains a small legacy JS codebase (`legacyCallback.js`,
`mathUtils.js`, `userController.js`) with a passing Jest test, used to
verify the pipeline produces zero behavioral regressions.

See the architecture overview and comparison matrix in the original
project spec for full technical detail.
