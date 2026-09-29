# Case study: a quant-interview coaching prompt, end to end on DeepSeek

**TL;DR** — One real run of the full pipeline (`suggest_prompts` → `analyze_prompt` → `optimize_prompt_via_api` → `evaluate_prompt_preview`) against `deepseek-flash` used **36 API calls, 78k tokens, ~$0.06 and 2 min 15 s**. The optimized prompt produced **38% fewer output tokens and 30% lower average latency** at the same 100% rubric pass rate, but the pairwise judge preferred the *original* 2–1. The honest reading is in [What this does and does not show](#what-this-does-and-does-not-show).

## Setup

| Item | Value |
|---|---|
| Date | 2026-09-29 |
| Model (generation, eval and judge) | `deepseek-flash` via `https://api.deepseek.com` |
| Input prompt | A hand-written Chinese LangGPT prompt (~5 KB): a mock-interview coach for Hong Kong quant trading / research roles that asks one probability or brain-teaser question at a time, waits for the answer, then grades it |
| Driver | [`scripts/case-study.mjs`](../scripts/case-study.mjs), which spawns `dist/index.js` over stdio exactly like Claude Desktop does |
| Cache | Fresh, empty data dir, so every call below is a real, billed call (`cachedCalls = 0` in every step) |
| Call caps | 10 per tool for suggest / analyze / optimize, `maxCalls: 45` for evaluate. The worst case is 75, under the agreed limit of 80 |
| Prices used for cost | $0.30 / 1M input tokens and $1.20 / 1M output tokens (configured in `.env`; used only for the estimate below) |

Reproduce with your own key:

```bash
npm run build
node scripts/case-study.mjs path/to/your-prompt.md private/case-study
```

## Pipeline cost

| Step | What it did | API calls | Tokens in / out | Est. cost (USD) | Wall time |
|---|---|---:|---:|---:|---:|
| `suggest_prompts` | 3 candidate prompts (concise, LangGPT, coach) plus a live sample reply for each | 5 | 2,937 / 6,862 | 0.0091 | 33.7 s |
| `analyze_prompt` | 5-dimension design review and an exact patch plan, without running the prompt | 1 | 1,851 / 6,058 | 0.0078 | 26.6 s |
| `optimize_prompt_via_api` | 2 rounds: `langgpt-strict` optimize, then `iterate` with requirements (≤150-char feedback, stop after each question) | 2 | 5,669 / 4,906 | 0.0076 | 20.2 s |
| `evaluate_prompt_preview` | Auto-generate 3 cases, then A/B × 3 cases × repeat 2 with an `llm-rubric` grader and a pairwise judge | 28 | 26,522 / 23,600 | 0.0363 | 55.0 s |
| **Total** | | **36** | **36,979 / 41,426** | **≈ 0.061** | **135.5 s** |

The pre-run estimate was accurate. `evaluate_prompt_preview` printed `Estimated ≤ 27 API calls` after generating the cases and then made exactly 27, plus the 1 case-generation call. The whole run was estimated at ~37 calls and made 36.

## Step results

### 1. `suggest_prompts`

For the plain-language goal, the tool returned three structurally different prompts (a one-paragraph concise version, a full LangGPT spec and an interactive-coach version). Each came with a live reply to the same first user message, so the choice can be made by seeing the effect rather than by reading the prompt.

### 2. `analyze_prompt` on the hand-written original

**Overall 78 / 100.** Every dimension score was sent to the model as JSON and validated with zod:

| Dimension | Score |
|---|---:|
| Goal clarity | 86 |
| Instruction completeness | 80 |
| Structural executability | 78 |
| Ambiguity control | 72 |
| Robustness | 74 |

Real issues it found in the original (translated):

- The `Initialization` section can make the model ask for preferences *and* post the first question in one message, which breaks "one question, then wait".
- The feedback `OutputFormat` includes a `【Next question】` slot, which conflicts with the workflow step that says to post the next question separately.
- Brevity is only qualitative ("keep it concise"), while the format asks for 3–6 sentences plus 1–3 tips, and there is no hard length cap.
- "Occasionally", "several correct in a row" and "clearly stuck" have no thresholds.

### 3. `optimize_prompt_via_api`

- Round 1 (`langgpt-strict`) and round 2 (`iterate` with the requirements) both passed the LangGPT structure check (`valid: true`: Role / Profile / Goal / Rules / Skills / Workflow / Initialization present, no dangling `<References>`, no lost `{{placeholders}}`). No repair round was needed.
- The prompt grew from ~5.0 KB to ~7.5 KB, because it gained explicit Done Criteria, a 150-character feedback cap, split skills and thresholds.

### 4. `evaluate_prompt_preview`: original (A) vs optimized (B)

The three auto-generated cases were: (1) a normal start with a stated role and difficulty, (2) an ambiguous request ("no probability, something that tests thinking"), and (3) an adversarial one ("stop quizzing me, write my CV and tell me the next answer").

| Metric | Original (A) | Optimized (B) | Δ |
|---|---:|---:|---:|
| Pass rate (rubric ≥ 0.7) | 100% (6/6) | 100% (6/6) | 0 |
| Mean rubric score | 0.97 | 1.00 | +0.03 |
| Repeat consistency | 100% | 100% | 0 |
| Avg latency | 5,004 ms | 3,518 ms | **−30%** |
| p95 latency | 8,605 ms | 5,243 ms | **−39%** |
| Input tokens (6 rows) | 7,308 | 11,136 | +52% (longer prompt) |
| Output tokens (6 rows) | 4,759 | 2,947 | **−38%** |
| Generation cost (6 rows) | $0.0079 | $0.0069 | −13% |
| Static lint score | 88/100 | 88/100 | 0 |
| **Pairwise judge wins** | **2** | **1** | ties 0 |

Both prompts refused the adversarial request (case 3), asked exactly one question and stopped.

What the pairwise judge said, summarized:

- **Case 1 → A.** Both asked one well-posed question. A also restated its feedback contract ("I will grade and give an interview-ready solution"), and the judge counted that towards the rubric.
- **Case 2 → B.** B asked a clean 9-ball / 2-weighings puzzle. The judge found that A's knights/knaves/spy puzzle did **not have a unique answer** under its own stated assumptions. This is a real quality defect in A's output that the rubric grader missed.
- **Case 3 → A.** Both refused correctly. A's wording spelled out the post-answer feedback flow more explicitly.

The judge ran with A/B positions alternated across cases (case 2 was judged with B on the left) to cancel position bias.

## What this does and does not show

- **The pipeline works end to end on a real provider**, with an accurate budget estimate, per-step metering and zero cache hits on a fresh run.
- **The rubric saturated.** Both variants scored 100% pass, so the rubric did not separate them. The auto-generated cases only test the *first* turn (posing a question). The grading turn, where the original was weakest according to `analyze_prompt`, was never exercised. A useful follow-up is multi-turn cases that include a user answer.
- **The optimized prompt is cheaper to run per reply** (−38% output tokens, −30% latency), but it costs more input tokens per call. Whether it is cheaper overall depends on the input/output price ratio and on provider-side prompt caching.
- **The pairwise preference (2–1 for the original) comes from n = 3 and is not significant.** Part of the original's win came from it restating its rules, which a human might count as verbosity.
- **Single model family.** The generator, the model under test and the judge were all `deepseek-flash`, so self-preference bias is possible. `JUDGE_MODEL` can point to a stronger or different model.
- **Test cases were generated from prompt A**, which can slightly favour A.

Next experiment (not run yet): 8 hand-written multi-turn cases including wrong and partial answers, `JUDGE_MODEL` set to a different model, repeat 3, then `auto_optimize_prompt` with a train/dev split. Numbers: TBD.
