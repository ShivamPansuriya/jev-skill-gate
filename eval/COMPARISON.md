# Jev vs the local scorer

Both arms restricted to the 4 cases each scored, so this is a true head-to-head. Same 217 installed skills, same gating config, prompt-only state.

> The local scorer also ran the full 18-case set (mean AUC 0.961, in RESULTS.md). Only the overlap is compared here. The Jev arm stopped at 4 cases when the free-tier quota ran out.

| | Jev | Local TF-IDF |
| --- | --- | --- |
| Cases scored | 4 | 4 |
| Mean pairwise AUC | **1.000** | 0.948 |
| Expected skills hidden | **0** | 1 |
| Cost per session | ~$0.0009 | $0 |

## Per case

| Case | Jev AUC | Local AUC | Jev median rank | Local median rank | Jev worst rank | Local worst rank |
| --- | --- | --- | --- | --- | --- | --- |
| `rust-borrow` | 1.000 | 1.000 | 3 | 3 | 38 | 5 |
| `django-api` | 1.000 | 1.000 | 6 | 4 | 12 | 28 |
| `freight` | 1.000 | 0.792 | 18 | 11 | 45 | 134 |
| `pr-review` | 1.000 | 1.000 | 3 | 7 | 89 | 24 |

## Skills Jev would have hidden

None.

## Skills Local TF-IDF would have hidden

| case | skill | score |
| --- | --- | --- |
| `freight` | `inventory-demand-planning` | 0.00 |

