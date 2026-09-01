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


/** Project Readme/

# TokenCLI: Context-Aware Token-Optimized Developer Engine

An intelligent, lightweight Command-Line Interface (CLI) developer engine designed to reduce LLM token overhead by **35% to 55%** while maximizing inference speed, code reasoning accuracy, and developer throughput.

---

## 1. Problem Statement

Modern Large Language Models (LLMs) have transformed software engineering workflows. However, direct integration into developer tooling suffers from critical systemic inefficiencies:

* **Massive Token Waste & Bloat:** Typical developer queries dump full source files, boilerplate code, verbose docstrings, and large imports into prompt payloads, consuming unnecessary tokens.
* **Prohibitive Inference Costs:** High token counts exponentially inflate API consumption costs, making continuous terminal/CI-CD workflows commercially unsustainable.
* **Context Dilution ("Lost in the Middle"):** Supplying unstructured, excessive context lowers model reasoning accuracy, leading to hallucinations and inaccurate diffs.
* **Latency Bottlenecks & Rate Limiting:** Large payloads drastically increase Time-to-First-Token (TTFT), degrading terminal UX and triggering frequent Tokens-Per-Minute (TPM) 429 throttling errors.

---

## 2. Existing Solutions

| Category | Typical Tools | Key Limitations |
| :--- | :--- | :--- |
| **Web-Based LLM Interfaces** | ChatGPT, Claude Web, Gemini Web | Manual copy-pasting; breaks keyboard-first terminal workflow; no direct access to local Git diffs or filesystem. |
| **Heavy IDE Copilots / Plugins** | GitHub Copilot, Cursor | Monolithic background indexing; lack of granular user control over token budgets and context pruning. |
| **Generic CLI Wrappers** | Basic API shell wrappers | Naive payload transmission without syntax-aware compression, AST parsing, or local sanitization. |

---

## 3. Proposed Solution

A high-performance CLI utility that sits directly between the local developer environment and LLM endpoints, applying deterministic pre-flight token reduction before API dispatch.

## 3. Proposed Solution

TokenCLI acts as a lightweight pre-flight compression proxy on your local machine. Before any prompt leaves your terminal, it deterministically extracts only the essential code and data needed for the task, cutting payload size in half.

### How It Works in 4 Steps:

1. **Local Context Capture:** The CLI inspects only the target workspace files, git changes (`git diff -U2`), or terminal error logs.
2. **Deterministic Pre-Flight Compression:**
   * **AST Skeletons:** Removes function bodies and implementation details, keeping only exported functions, classes, and types.
   * **Diff Slicing:** Isolates the exact lines changed rather than attaching entire source files.
   * **Relevance Filtering:** Pulls in only directly referenced dependencies using fast local indexing.
   * **Secret Redaction:** Strips `.env` keys and sensitive tokens on your device before network transmission.
3. **Dynamic Model Routing:** Automatically dispatches quick/simple fixes to lightweight, low-cost models (e.g., Flash / Mini) and reserves large reasoning models for complex refactors.
4. **Fast Terminal Streaming:** Delivers the optimized response directly into your terminal output in real time without lag.


### Core Architecture Highlights
* **Abstract Syntax Tree (AST) Pruning:** Strips non-essential function implementations from dependencies, preserving only exported signatures, types, and interfaces.
* **Targeted Unified Diff Slicing:** Extracts precise git diff ranges (`git diff -U2`) instead of full file buffers.
* **Context Relevance Scoring:** Uses fast local lexical/vector search to supply only actively referenced modules.
* **Local Secret & Privacy Guard:** Strips API credentials, private tokens, and environment variables on the client side before network dispatch.

---

## 4. How It Is Better

| Feature / Metric | Standard CLI / Raw LLM Tool | TokenCLI Engine | Net Benefit |
| :--- | :--- | :--- | :--- |
| **Token Payload Overhead** | 100% (Raw, uncompressed context) | **45% - 65% of original** | **35% - 55% Token Reduction** |
| **Average Response Latency** | 2.8s - 5.5s (High TTFT) | **0.8s - 1.6s (Instant stream)** | **~3x Faster Terminal Output** |
| **API Cost per Query** | High ($$$) | Low ($) | **Direct 40%+ Cost Savings** |
| **Context Signal-to-Noise** | Low (Boilerplate-heavy) | High (Relevant symbols only) | **Fewer Hallucinations** |
| **TPM / Rate Limit Safety** | High frequency of 429 errors | Optimized throughput headroom | **Continuous Developer Flow** |
| **Local Environment Safety** | Potential key leakage | Pre-flight regex & entropy scrub | **Zero Secret Exfiltration** |

---

## 5. Future Advancements

* **Client-Side Edge SLMs:** Embed lightweight local models (e.g., Llama 3 / Qwen 2.5 0.5B via ONNX/WASM) directly in the CLI to filter and summarize context with zero API cost.
* **Semantic Vector Prompt Caching:** Cache embeddings and recurring code abstractions locally to eliminate redundant context calls across repeat commands.
* **Bi-Directional AST Patching:** Provide auto-apply CLI commands (`tokencli apply`) that parse LLM output directly back into the code tree with automated verification and formatting.
* **CI/CD Quality & Token Gatekeeper:** Pre-commit hooks and GitHub Actions integrations to audit token budgets on team pull requests.

---

## 6. Tech Stacks

### CLI & Application Core
* **Language & Runtime:** Node.js (TypeScript)
* **CLI Framework:** Commander.js 
* **Terminal UI / UX:** Chalk, Ink, Ora, Boxen

### Code Analysis & Optimization Engine
* **AST Parsing:** Tree-sitter / Babel Parser / SWC
* **Local Search & Retrieval:** BM25 / MiniSearch / Orama (Local Vector Search)
* **Diff Engine:** Git-diff-parser, Diff2Html

### LLM Orchestration & APIs
* **SDKs & Providers:** LangChain / Vercel AI SDK, OpenAI API, Anthropic SDK, Google Gen AI SDK
* **Output Enforcement:** Zod / Structured JSON Schemas