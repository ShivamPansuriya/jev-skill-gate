# Jev discrimination run (partial)

Real scores from `typesafe-ai/jev` through the Vercel AI Gateway, captured before the
account's free-tier quota was exhausted. **5 of 6 scenarios completed.** Scenario 6
(Kotlin Multiplatform) has no data — every attempt returned HTTP 429, and it is omitted
rather than estimated.

State was the prompt only, against a neutral working directory, so these numbers measure
prompt→skill matching with no project signals helping.

> Skill counts shift between rows (146 vs 210) because command discovery landed
> mid-run. Ranks are read off each scenario's own output.

## Primary skills

Where a prompt maps to dedicated, well-named skills, Jev puts them at the very top.

| Scenario | Skill | Rank | Score |
| --- | --- | --- | --- |
| Video edit + voiceover | `video-editing` | 1 | 0.95 |
| Video edit + voiceover | `videodb` | 2 | 0.93 |
| Video edit + voiceover | `fal-ai-media` | 3 | 0.90 |
| PR review + test quality | `perform-ai-code-review` | 1 | 0.96 |
| PR review + test quality | `code-review` | 2 | 0.95 |
| PR review + test quality | `test-coverage` | 3 | 0.89 |
| Django REST + auth tests | `django-patterns` | 2 | 0.95 |
| Django REST + auth tests | `django-tdd` | 3 | 0.93 |
| Django REST + auth tests | `django-security` | 4 | 0.93 |
| Django REST + auth tests | `api-design` | 8 | 0.83 |
| Freight rate negotiation | `carrier-relationship-management` | 2 | 0.96 |
| Rust borrow checker | `rust-patterns` | 2 | 0.95 |

No irrelevant skill appeared in any top 5. The non-expected entries that did appear
(`market-research` and `deep-research` on the freight prompt, `python-testing` on the
Django prompt) are defensible rather than wrong.

## Secondary skills, and the two real failures

Skills that are relevant but not the obvious primary match score much lower:

| Scenario | Skill | Score | Outcome at `nameOnly: 0.25` |
| --- | --- | --- | --- |
| Django | `django-verification` | 0.57 | name-only |
| Rust | `rust-testing` | 0.36 | name-only |
| Freight | `logistics-exception-management` | 0.29 | name-only |
| PR review | `security-review` | **0.20** | **hidden** |
| Freight | `inventory-demand-planning` | **0.17** | **hidden** |

The last two are the failure mode that matters: a user asking for a thorough PR review
plausibly wants `security-review`, and Claude would never have known it existed.

**This is why the shipped `nameOnly` threshold is 0.15, not 0.25.** Both skills survive at
0.15, at a cost of about three tokens each. The change is in `src/config.mjs` with the
same reasoning.

## Score distribution

Not compressed. A sharp peak with a long tail:

| Scenario | min | median | max |
| --- | --- | --- | --- |
| Rust | 0.01 | ~0.07 | 0.95 |
| Django | 0.01 | 0.07 | 0.95 |
| Freight | 0.01 | 0.06 | 0.96 |
| Video | 0.02 | 0.07 | 0.95 |
| PR review | 0.02 | 0.25 | 0.96 |

PR review sits higher because "review this code and check test quality" genuinely
overlaps many skills across languages. That is the model being right, not noise.

With a median near 0.07 and primaries near 0.95, `on: 0.6` is comfortably inside the gap
rather than balanced on an edge.

## Reproducing

Needs Gateway credits (free tier will not cover it; the full 20-case run costs about
$0.02):

```bash
export AI_GATEWAY_API_KEY=vck_...
node eval/run-eval.mjs                # resumable; re-run to continue after a 429
node eval/run-eval.mjs --reuse        # re-report from saved scores, free
```
