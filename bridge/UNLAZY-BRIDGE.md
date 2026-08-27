# UNLAZY-BRIDGE.md - SuperClaude and unlazy integration

How the SuperClaude framework and the `unlazy` skill divide responsibility.
Load order places this last, so it resolves conflicts the other documents create.

## Layer division

**SuperClaude decides what to do and who does it.** Command routing, complexity
scoring, persona activation, MCP selection, decomposition strategy.

**unlazy decides whether it is done.** Acceptance gates written before work,
approved commands as oracles, evidence, re-verification, honest abandonment.

They are complementary, not competing. SuperClaude's planning is upstream of
unlazy's proof. Neither replaces the other.

## When to invoke unlazy

Invoke `/unlazy` (write `GATES.md` first, before implementing) when any holds:

- `/sc:task`, `/sc:spawn`, `/sc:implement`, `/sc:build`, or `/sc:improve` is
  running against work with three or more independently required outcomes
- SuperClaude's wave mode or `--delegate` activates, since anything worth
  fanning out is worth proving complete
- the deliverable is a document, dataset, or batch output rather than code
- the user asks for exhaustive, thorough, or end-to-end work in any language

**Writing the ledger is the first action, not a closing step.** unlazy's Stop
hook allows the session out when no ledger exists, so a task that never creates
one is never enforced. That gap is closed by discipline here, not by tooling.

Do not create gates for a trivial edit, a single-file fix, or a factual answer.

## Terminology collisions, resolved

These words appear in both docsets with different meanings. Always disambiguate.

| Word | SuperClaude meaning | unlazy meaning |
|---|---|---|
| **wave** | multi-stage execution strategy (`--wave-mode`, auto on high complexity plus broad scope; the docs above disagree on the exact threshold, so treat it as a signal rather than a rule) | a dispatch **launch barrier**: `open` -> `start` each leaf -> `seal` -> only then wait |
| **delegate / sub-agent** | `--delegate` spawning Task sub-agents for parallel analysis | a **leaf** that must claim disjoint `OWNS:` paths and be recorded with a host handle before any wait |
| **quality gate** | the 8-step validation cycle, advisory prose | one line in `GATES.md` with a runnable `CHECK:` and `EXPECT:` |
| **validate** | `--validate`, pre-operation risk assessment | post-execution evidence that an oracle passed |
| **loop** | `--loop`, N improvement iterations | the four passes applied within a single leaf |

When speaking to the user, say "dispatch wave" for unlazy's barrier and
"wave mode" for SuperClaude's strategy. Never let one imply the other.

## Precedence when they conflict

1. **An unmet gate outvotes any completion claim.** Never compose a done report
   while a required gate is unmet, abandoned, deferred, or awaiting a decision,
   regardless of persona confidence or SuperClaude's own checklist.
2. **`--uc` never compresses evidence.** Token compression applies to prose. It
   does not apply to measured met/unmet/abandoned counts, qualified gate ids
   such as `leaf-1.2.1:G3`, or the final completion report. Compressing those
   destroys the only thing that makes the report auditable.
3. **Measured evidence outvotes persona judgement.** A persona's confidence is a
   routing signal, not proof. `--reverify` is proof.
4. **Safety flags still win.** `--safe-mode` and approval boundaries outrank both
   systems' speed and completeness pressure. Never auto-approve a `CHECK:`.
5. **SuperClaude picks the mode; unlazy picks the mode's smallest fit.** Wave
   mode activating does not require unlazy's Parallel mode. Use Solo unless the
   work genuinely needs fresh contexts.

## Concrete mappings

- **8-step validation cycle** -> make it runnable. Steps 1 to 4 (syntax, type,
  lint, security) become build and lint gates; step 5 (test) becomes test gates;
  step 8 (integration) becomes branch integration gates. A step with no command
  behind it is a manual gate and must say so.
- **`--delegate` or wave fan-out** -> before launching, give each leaf a narrow
  contract, disjoint `OWNS:` paths, and its own ledger. Claim, open a dispatch
  wave, record every handle, seal, then wait. Re-verify each returned leaf with
  `--reverify`, never `--status`.
- **`qa` persona activates** -> lint the ledger before working it:
  `node C:\Users\Admin\.claude\skills\unlazy\scripts\gate-lint.mjs GATES.md`
  Absolute, because the default shell here is `cmd.exe`, which does not expand
  `~`. The skill's own documents carry the same resolved path.
- **`architect` persona activates** -> fill the PLAN contract inventory before
  fan-out, mapping every independently omittable outcome to an owner and an
  observing gate.
- **`analyzer` persona activates** -> its findings are hypotheses until a gate
  measures them. Do not report a root cause as confirmed without an oracle.
- **`/sc:spawn` depth** -> corresponds to unlazy's `tree N`. Split at natural
  boundaries only, while each leaf stays a coherent deliverable.
- **Non-code deliverables** -> use the ready oracles in
  `C:\Users\Admin\.claude\skills\unlazy\checks\README.md` (file freshness and digest, text
  encoding including CP949, CSV columns and two-source reconciliation, Word
  sections and leftover placeholders, Excel error cells, batch log completion)
  instead of settling for a manual gate. Korean ledger templates:
  `templates/gates-report-ko.md`, `templates/gates-recon-ko.md`.

## Absence claims need positive controls

Both systems encourage asserting that something is gone: no vulnerabilities, no
regressions, no placeholders. An absence check passes identically when the
detector is broken, the path is wrong, or the input is empty. Before trusting
any absence gate, run the same oracle against input that certainly contains what
is forbidden and confirm it fails. Record that control as manual evidence.
`checks/check-batch-log.mjs` enforces this mechanically; everywhere else it is
discipline.

## Token budget

SuperClaude's own documents load on every session. unlazy adds roughly 2K tokens
for `SKILL.md` and up to 11K if every reference is opened. Open only what the
chosen mode needs: Solo needs `references/gates.md`; Orchestrated adds `method`,
`orchestration`, and `dispatch`; Parallel adds `parallel`. Do not preload all of
them to feel prepared.
