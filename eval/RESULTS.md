# Eval results

Generated 2026-09-17T19:49:49.291Z · provider `fallback` · 217 installed skills (~12750 manifest tokens) · 20 cases · eval cost $0.00000

Reproduce: `node eval/run-eval.mjs` (re-scores, costs money) or `node eval/run-eval.mjs --reuse` (recomputes every number from the committed `raw-scores.json`, free).

## Headline

| Metric | Value |
| --- | --- |
| Mean pairwise AUC | **0.961** |
| Worst case AUC | 0.750 |
| Cases with perfect separation (AUC = 1.0) | 14 / 18 |
| Median rank of an expected skill | 4 of 217 |
| Irrelevant skills that reached any top 10 | 0 |

AUC is the share of (expected, irrelevant) pairs where the expected skill scored higher. 1.0 is perfect separation, 0.5 is a coin flip.

## Sweep (by maxOn)

Scored once, swept offline. The local scorer emits ranks, not probabilities, so the planner takes a top-N slice and `maxOn` is the knob; thresholds do nothing here.

`recall (visible)` is the share of expected skills that survive gating as either a full description or a name. `hidden on vague prompt` is how many skills get hidden for the two adversarial prompts - low is good, it means a contentless prompt does not trigger confident hiding.

| maxOn | maxNameOnly | recall (full desc) | recall (visible) | mean tokens saved | mean saved | hidden on vague prompt |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | 60 | 64.3% | **92.9%** | 12140 | 95.2% | 0 |
| 10 | 60 | 84.3% | **92.9%** | 11845 | 92.9% | 0 |
| 15 | 60 | 88.6% | **92.9%** | 11521 | 90.4% | 0 |
| 20 | 60 | 88.6% | **92.9%** | 11111 | 87.1% | 0 |
| 30 | 60 | 92.9% | **92.9%** | 10529 | 82.6% | 0 |
| 40 | 60 | 92.9% | **92.9%** | 10157 | 79.7% | 0 |
| 60 | 60 | 92.9% | **92.9%** | 9998 | 78.4% | 0 |

## Skills gating would have hidden, at the shipped defaults

5 of the labelled skills were pushed to `user-invocable-only`. They stay typable as `/name`, but Claude cannot see them. This is the failure mode that matters.

| case | skill | score |
| --- | --- | --- |
| `freight` | `inventory-demand-planning` | 0.00 |
| `content` | `x-api` | 0.00 |
| `laravel-sec` | `security-review` | 0.00 |
| `cpp-build` | `cpp-coding-standards` | 0.00 |
| `cpp-build` | `cpp-review` | 0.00 |

## Per case

| Case | AUC | median rank of expected | expected in top 10 | irrelevant in top 10 | score range |
| --- | --- | --- | --- | --- | --- |
| `rust-borrow` | 1.000 | 3 | 5/5 | 0 | 0.00–1.00 |
| `django-api` | 1.000 | 4 | 4/6 | 0 | 0.00–1.00 |
| `freight` | 0.792 | 11 | 1/3 | 0 | 0.00–1.00 |
| `pr-review` | 1.000 | 7 | 3/5 | 0 | 0.00–1.00 |
| `video` | 1.000 | 7 | 2/3 | 0 | 0.00–1.00 |
| `kmp-compose` | 1.000 | 4 | 6/6 | 0 | 0.00–1.00 |
| `spring-jpa` | 1.000 | 5 | 4/5 | 0 | 0.00–1.00 |
| `swiftui` | 1.000 | 3 | 4/4 | 0 | 0.00–1.00 |
| `postgres` | 1.000 | 2 | 2/2 | 0 | 0.00–1.00 |
| `go-concurrency` | 1.000 | 4 | 5/5 | 0 | 0.00–1.00 |
| `docker-deploy` | 1.000 | 10 | 2/2 | 0 | 0.00–1.00 |
| `content` | 0.875 | 6 | 3/4 | 0 | 0.00–1.00 |
| `research` | 1.000 | 5 | 4/4 | 0 | 0.00–1.00 |
| `prd` | 1.000 | 4 | 3/3 | 0 | 0.00–1.00 |
| `laravel-sec` | 0.875 | 3 | 4/5 | 0 | 0.00–1.00 |
| `cpp-build` | 0.750 | 76 | 2/4 | 0 | 0.00–1.00 |
| `energy` | 1.000 | 1 | 1/1 | 0 | 0.00–1.00 |
| `mcp-server` | 1.000 | 4 | 2/3 | 0 | 0.00–1.00 |

## Detail

### `rust-borrow`

> My Rust build is failing with a borrow checker error in an async handler and the lifetimes do not line up

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `rust-build` | 1.00 |
| 2 | `rust-review` | 1.00 |
| 3 | `rust-patterns` | 0.99 |
| 4 | `rust-testing` | 0.99 |
| 5 | `rust-test` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `rust-patterns` | 3 | 0.99 |
| `rust-build` | 1 | 1.00 |
| `rust-review` | 2 | 1.00 |
| `rust-testing` | 4 | 0.99 |
| `rust-test` | 5 | 0.98 |

### `django-api`

> Write a Django REST Framework endpoint for user authentication with pytest tests and check it for security holes

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `django-tdd` | 1.00 |
| 2 | `django-security` | 1.00 |
| 3 | `django-patterns` | 0.99 |
| 4 | `django-verification` | 0.99 |
| 5 | `security-review` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `django-patterns` | 3 | 0.99 |
| `django-tdd` | 1 | 1.00 |
| `django-security` | 2 | 1.00 |
| `django-verification` | 4 | 0.99 |
| `api-design` | 28 | 0.88 |
| `python-testing` | 13 | 0.94 |

### `freight`

> I need to negotiate freight rates with our carriers and build a performance scorecard for the quarterly review

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `carrier-relationship-management` | 1.00 |
| 2 | `code-review` | 1.00 |
| 3 | `perform-ai-code-review` | 0.99 |
| 4 | `cpp-build` | 0.99 |
| 5 | `build-fix` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `carrier-relationship-management` | 1 | 1.00 |
| `logistics-exception-management` | 11 | 0.95 |
| `inventory-demand-planning` | 134 | 0.00 |

### `pr-review`

> Review this pull request thoroughly, grill the author on test quality, and check the blast radius before I merge

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `perform-ai-code-review` | 1.00 |
| 2 | `code-review` | 1.00 |
| 3 | `quality-gate` | 0.99 |
| 4 | `quality-nonconformance` | 0.99 |
| 5 | `plankton-code-quality` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `perform-ai-code-review` | 1 | 1.00 |
| `code-review` | 2 | 1.00 |
| `security-review` | 24 | 0.89 |
| `test-coverage` | 7 | 0.97 |
| `onelens` | 14 | 0.94 |

### `video`

> Edit this footage into a short clip and generate an AI voiceover track for it

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `ai-first-engineering` | 1.00 |
| 2 | `video-editing` | 1.00 |
| 3 | `ai-regression-testing` | 0.99 |
| 4 | `hyperresearch-prd-26-patcher` | 0.99 |
| 5 | `perform-ai-code-review` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `video-editing` | 2 | 1.00 |
| `videodb` | 25 | 0.89 |
| `fal-ai-media` | 7 | 0.97 |

### `kmp-compose`

> Design a Kotlin Multiplatform app using Compose with coroutines and flows, following clean architecture

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `compose-multiplatform-patterns` | 1.00 |
| 2 | `kotlin-coroutines-flows` | 1.00 |
| 3 | `android-clean-architecture` | 0.99 |
| 4 | `kotlin-patterns` | 0.99 |
| 5 | `refactor-clean` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `compose-multiplatform-patterns` | 1 | 1.00 |
| `kotlin-coroutines-flows` | 2 | 1.00 |
| `kotlin-patterns` | 4 | 0.99 |
| `android-clean-architecture` | 3 | 0.99 |
| `kotlin-testing` | 8 | 0.97 |
| `kotlin-review` | 6 | 0.98 |

### `spring-jpa`

> My Spring Boot service has an N+1 query problem in a JPA repository and the endpoint is timing out

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `jpa-patterns` | 1.00 |
| 2 | `onelens` | 1.00 |
| 3 | `springboot-patterns` | 0.99 |
| 4 | `springboot-security` | 0.99 |
| 5 | `springboot-verification` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `springboot-patterns` | 3 | 0.99 |
| `jpa-patterns` | 1 | 1.00 |
| `java-coding-standards` | 8 | 0.97 |
| `springboot-verification` | 5 | 0.98 |
| `postgres-patterns` | 11 | 0.95 |

### `swiftui`

> Build a SwiftUI view with Swift 6 strict concurrency and persist state in an actor

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `swift-concurrency-6-2` | 1.00 |
| 2 | `swiftui-patterns` | 1.00 |
| 3 | `swift-actor-persistence` | 0.99 |
| 4 | `swift-protocol-di-testing` | 0.99 |
| 5 | `cpp-build` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `swiftui-patterns` | 2 | 1.00 |
| `swift-concurrency-6-2` | 1 | 1.00 |
| `swift-actor-persistence` | 3 | 0.99 |
| `swift-protocol-di-testing` | 4 | 0.99 |

### `postgres`

> This Postgres query is slow and I need to write a zero-downtime migration to add an index

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `postgres-patterns` | 1.00 |
| 2 | `database-migrations` | 1.00 |
| 3 | `agentation` | 0.99 |
| 4 | `claw` | 0.99 |
| 5 | `agentation-self-driving` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `postgres-patterns` | 1 | 1.00 |
| `database-migrations` | 2 | 1.00 |

### `go-concurrency`

> I have a goroutine leak and a race condition in my Go service, and the benchmarks regressed

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `go-review` | 1.00 |
| 2 | `go-build` | 1.00 |
| 3 | `golang-testing` | 0.99 |
| 4 | `golang-pro` | 0.99 |
| 5 | `go-test` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `golang-patterns` | 6 | 0.98 |
| `golang-pro` | 4 | 0.99 |
| `golang-testing` | 3 | 0.99 |
| `go-review` | 1 | 1.00 |
| `go-test` | 5 | 0.98 |

### `docker-deploy`

> Containerize this service and set up a CI pipeline with health checks and a rollback strategy

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `deployment-patterns` | 1.00 |
| 2 | `skill-health` | 1.00 |
| 3 | `docs` | 0.99 |
| 4 | `pm2` | 0.99 |
| 5 | `ralphinho-rfc-pipeline` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `docker-patterns` | 10 | 0.96 |
| `deployment-patterns` | 1 | 1.00 |

### `content`

> Write a technical blog post about our launch and adapt it for LinkedIn and X

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `article-writing` | 1.00 |
| 2 | `kotlin-test` | 1.00 |
| 3 | `cpp-test` | 0.99 |
| 4 | `rust-test` | 0.99 |
| 5 | `content-engine` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `article-writing` | 1 | 1.00 |
| `content-engine` | 5 | 0.98 |
| `crosspost` | 6 | 0.98 |
| `x-api` | 217 | 0.00 |

### `research`

> Do deep research on this market with citations from primary sources and give me a report

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `market-research` | 1.00 |
| 2 | `deep-research` | 1.00 |
| 3 | `find-skills` | 0.99 |
| 4 | `prompt-optimizer` | 0.99 |
| 5 | `hyperresearch` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `deep-research` | 2 | 1.00 |
| `hyperresearch` | 5 | 0.98 |
| `market-research` | 1 | 1.00 |
| `exa-search` | 6 | 0.98 |

### `prd`

> Turn this feature request into a full product requirements document with user stories and flows

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `hyperresearch-prd-21-personas-stories` | 1.00 |
| 2 | `hyperresearch-prd-18-product-inventory` | 1.00 |
| 3 | `nutrient-document-processing` | 0.99 |
| 4 | `hyperresearch-prd-22-flows-entities` | 0.99 |
| 5 | `hyperresearch-prd-19-feature-decomposition` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `hyperresearch-prd` | 6 | 0.98 |
| `hyperresearch-prd-21-personas-stories` | 1 | 1.00 |
| `hyperresearch-prd-22-flows-entities` | 4 | 0.99 |

### `laravel-sec`

> Audit this Laravel app for SQL injection and CSRF issues and add tests for the fixes

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `laravel-security` | 1.00 |
| 2 | `laravel-verification` | 1.00 |
| 3 | `laravel-tdd` | 0.99 |
| 4 | `django-security` | 0.99 |
| 5 | `laravel-plugin-discovery` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `laravel-security` | 1 | 1.00 |
| `laravel-tdd` | 3 | 0.99 |
| `laravel-patterns` | 6 | 0.98 |
| `laravel-verification` | 2 | 1.00 |
| `security-review` | 194 | 0.00 |

### `cpp-build`

> My CMake build is failing with a template instantiation error and a linker problem

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `cpp-build` | 1.00 |
| 2 | `build-fix` | 1.00 |
| 3 | `kotlin-build` | 0.99 |
| 4 | `rust-build` | 0.99 |
| 5 | `gradle-build` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `cpp-build` | 1 | 1.00 |
| `cpp-coding-standards` | 76 | 0.00 |
| `cpp-testing` | 6 | 0.98 |
| `cpp-review` | 77 | 0.00 |

### `energy`

> We need to optimize our electricity tariffs across facilities and evaluate a renewable PPA

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `energy-procurement` | 1.00 |
| 2 | `prompt-optimize` | 1.00 |
| 3 | `learn-eval` | 0.99 |
| 4 | `laravel-plugin-discovery` | 0.99 |
| 5 | `impeccable` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `energy-procurement` | 1 | 1.00 |

### `mcp-server`

> Build an MCP server that exposes tools to Claude, and check the API docs for the SDK

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `mcp-server-patterns` | 1.00 |
| 2 | `docs` | 1.00 |
| 3 | `update-docs` | 0.99 |
| 4 | `claude-api` | 0.99 |
| 5 | `backend-patterns` | 0.98 |

Expected skills:

| skill | rank | score |
| --- | --- | --- |
| `mcp-server-patterns` | 1 | 1.00 |
| `claude-api` | 4 | 0.99 |
| `context7-mcp` | 12 | 0.95 |

### `adversarial-vague-fix` (adversarial)

> fix it

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `build-fix` | 1.00 |
| 2 | `gradle-build` | 1.00 |
| 3 | `cpp-build` | 0.99 |
| 4 | `kotlin-build` | 0.99 |
| 5 | `rust-build` | 0.98 |

### `adversarial-vague-faster` (adversarial)

> make this faster

Top 5 scored:

| # | skill | score |
| --- | --- | --- |
| 1 | `andrej-karpathy-skills:karpathy-guidelines` | 1.00 |
| 2 | `i-have-adhd:i-have-adhd` | 1.00 |
| 3 | `agent-harness-construction` | 0.00 |
| 4 | `agentation` | 0.00 |
| 5 | `agentation-self-driving` | 0.00 |

