# Step-by-step: a 5-agent HRMS product team in Claude Code

This folder is a drop-in team. Five subagents, a shared context file, an NFR catalogue, a handoff protocol, and four slash commands that drive them.

**Read this in order. Step 4 is the one that decides whether this works.**

---

## What is in the box

```
your-hrms-repo/
├── CLAUDE.md                  ← shared context every agent reads first
├── .claude/
│   ├── agents/  (5 subagents)
│   │   ├── hrms-product-manager.md
│   │   ├── hrms-business-analyst.md
│   │   ├── hrms-fullstack-engineer.md
│   │   ├── hrms-test-automation.md
│   │   └── hrms-techno-functional-reviewer.md
│   └── commands/
│       ├── discover.md        → /discover
│       ├── feature.md         → /feature
│       ├── review.md          → /review
│       ├── nfr-check.md       → /nfr-check
│       └── compliance-check.md → /compliance-check
└── docs/
    ├── 00-team-charter.md     who owns what, and where the "missing" roles went
    ├── 01-handoff-protocol.md handoffs are files, not conversations
    ├── 02-definition-of-done.md the gates, including the anti-over-engineering test
    ├── 03-nfr-catalog.md      NFRs written for HR software specifically
    ├── 04-worked-example.md   one feature traced through all five gates
    ├── 05-compliance-catalog.md  DPDP + GDPR + EU AI Act + ISO/SOC, and the
    │                             module-by-module compliance feature map
    └── features/              one folder per feature, created as you go
```

---

## Step 0 — Prerequisites (15 minutes)

1. **Claude Code installed** and working in a terminal. Run `claude --version` to confirm.
2. **A git repository** for your HRMS — even an empty one. These agents are built to live in a repo and read code; without one you lose most of their value.
3. **A rough idea of your first feature.** Not a spec. One sentence is enough.

You do not need a chosen tech stack yet. `CLAUDE.md` §7 handles that as an open decision.

---

## Step 1 — Create the repo skeleton (5 minutes)

```bash
mkdir -p your-hrms/.claude/agents your-hrms/.claude/commands your-hrms/docs/features
cd your-hrms
git init
```

## Step 2 — Copy the files in (2 minutes)

Copy `CLAUDE.md`, `.claude/`, and `docs/` from this bundle into your repo root. Then:

```bash
git add . && git commit -m "chore: HRMS agent team"
```

**Commit them.** These files are team assets. When a teammate joins, they inherit the same five agents and the same standards.

## Step 3 — Confirm the agents loaded (2 minutes)

Start Claude Code in the repo and ask:

```
List the subagents available in this project and what each one owns.
```

You should get all five back. If you do not:

- Check the files are at `.claude/agents/*.md` relative to the directory you launched `claude` from
- Check the YAML frontmatter is intact — the `---` fences, and `name:` matching the filename
- Check `name:` uses lowercase and hyphens only

> **Verify against your version.** Subagent frontmatter has gained fields over time. The files here use only `name`, `description`, `model`, `color`, and `disallowedTools` on the reviewer. If your version rejects any of them, delete that line — only `name` and `description` are required.

## Step 4 — Rewrite CLAUDE.md for your product (60–90 minutes) ⬅ **the step that matters**

**Do not skip this.** Everything downstream is only as good as this file. The version shipped here is a scaffold I wrote from a generic reading of your goal — it is a starting shape, not your product.

Work through it in this order:

1. **§1 Mission and pillars.** Are engagement, collaboration, inclusiveness and transparency really your four? Change the metrics to ones you can actually measure in your first year.
2. **§3 Personas.** Replace Aisha, Rohan, Meera, Sunil, Priya with people you have actually spoken to. Use real names from real interviews if you can. Generic personas produce generic requirements.
3. **§5 Where we win.** My five differentiators are hypotheses, not research. Keep the ones you believe, delete the rest, add yours. Mark each one as a bet you intend to test.
4. **§7 Technology.** Either fill in your real stack, or leave it marked PROPOSED and let the first `/discover` session resolve it. **Do not let the agents treat my proposed stack as decided** — that notice is there on purpose.
5. **The one-way doors.** Multi-tenancy, time model, money representation, effective-dating, data residency. Decide these deliberately and early. Getting them wrong is the difference between a refactor and a rewrite.

Then do the same for `docs/03-nfr-catalog.md`: every number in `[brackets]` is a guess. Replace them with your targets. An NFR nobody chose is an NFR nobody will honour.

**Then `docs/05-compliance-catalog.md`.** Decide your target markets, delete the frameworks that do not apply to you, and — this is the important bit — **take the ones that do apply to a qualified lawyer in that market before you build against them.** Everything in that file was checked in August 2026 against public commentary, and it is there to tell you what to *ask about*, not what the law *is*. The EU deferred its high-risk AI obligations by 16 months while I was writing it. Then read §3, the module-by-module compliance feature map, and put those features into your roadmap rather than into a backlog labelled "compliance".

**Sanity check:** hand `CLAUDE.md` to someone who knows HR but not your product. If they cannot tell you what the product is for and who it is for, the agents will not know either.

## Step 5 — Your first run (30 minutes)

Start with thinking, not building:

```
/discover managers forget to recognise good work, and quiet contributors get overlooked
```

The PM agent should come back with a story, three options including a no-software one, a competitor scan, a cheap experiment, and a recommendation. **Read it critically.** If it feels generic, that is a signal about your `CLAUDE.md`, not about the agent — go back to step 4.

Then run one small feature end to end:

```
/feature simple peer recognition on a team wall
```

It pauses at each of the five gates. **Use the pauses.** The whole value of the pipeline is that a wrong turn costs you five minutes at gate 1 instead of two days at gate 4.

Compare what you get against `docs/04-worked-example.md`.

## Step 6 — The operating rhythm

| Situation | What to run |
|---|---|
| Fuzzy idea, not sure it is real | `/discover <problem>` |
| Decided to build something | `/feature <name>` |
| Someone (or an agent) wrote code outside the pipeline | `/review <path>` |
| Inherited code, or before a release | `/nfr-check <module>` |
| Before entering a market, or before a security questionnaire | `/compliance-check <module> <jurisdiction>` |
| One specific job | Name the agent directly: `Use the hrms-business-analyst subagent to write the permissions matrix for payroll` |

**Do not run all five agents on everything.** A typo fix does not need a product manager. The Full-Stack agent's tier table (S / M / L) exists so small work stays small.

## Step 7 — Tune them over the first month

These agents get sharper the way a real team does — from specifics.

- **When an agent produces something wrong, do not just correct it in chat.** Add the rule to its `.md` file. Chat corrections evaporate; file edits compound.
- **When a bug reaches production, add it to an agent's checklist.** That is how the team stops repeating a mistake. Two months in, your checklists should look nothing like mine — they should be full of your specific scars.
- **When `CLAUDE.md` passes ~400 lines**, move detail into `docs/` and link. Context is a budget; spend it on what changes decisions.
- **Every decision that took an argument goes in `docs/features/<slug>/99-decision-log.md`**, with the reasoning. Six months from now you will want to know why leaderboards were rejected.

## Step 8 — Add a sixth agent only when the pain is real

Do not start with more than five. Add one when you can name the specific thing that keeps falling through:

| Add | When |
|---|---|
| Data / analytics engineer | You are building a warehouse and people-analytics pipelines rather than reading from the app database |
| Security & compliance specialist | You start a SOC 2 / ISO 27001 / ISO 27701 process, or you sell into regulated enterprises. Note this is an agent for *evidence and control design* — it does not replace a lawyer |
| Localisation / compliance analyst | You go past two countries' payroll rules |
| Design systems engineer | You have more than one squad and the UI has started to diverge |

---

## Where this goes wrong, and how to tell

| Symptom | Real cause | Fix |
|---|---|---|
| Output is generic and could be about any product | `CLAUDE.md` is still my scaffold | Step 4, properly |
| Agents contradict each other | Ownership blurred — two agents wrote the same artefact | Re-read `00-team-charter.md`; enforce one artefact per agent |
| Everything comes back "looks good" | The reviewer is not being made to run tests and reproduce examples | Use `/review`, which instructs it to; check it pasted real output |
| Features balloon in scope | Gate 0 is being skipped | Make the PM answer the four simplicity questions in writing, every time |
| Tests pass but bugs ship | Tests were written from the code | The test agent must write `40-test-plan.md` before reading the implementation. Check the file timestamps if you suspect it |
| An agent invents a library method | It skipped verification | Its file already forbids this; add the specific incident to its checklist so it stops |
| The pipeline feels like overhead | You are running all five on small work | Use tiers. `/feature` is for features, not fixes |

---

## What I could not verify, and you should

I want to be straight about the edges of this, because a confident wrong answer is worse than a flagged uncertainty.

1. **Subagent chaining.** Claude Code's documentation shows subagents invoked by natural language, `@`-mention, and the `--agent` flag. I did **not** find a documented, guaranteed way to enforce a deterministic ordered chain. That is exactly why the handoff protocol is file-based: the pipeline works whether or not automatic chaining does. The `/feature` command asks for the stages in order and pauses between them, which is reliable because you are the one advancing it.
2. **Frontmatter fields.** `name` and `description` are required; the others I used are documented but availability varies by version. If a field errors, delete it.
3. **Whether subagents inherit `CLAUDE.md`.** I could not confirm this definitively. Every agent file therefore *instructs* the agent to read `CLAUDE.md` first, rather than assuming it arrives automatically.
4. **The proposed tech stack in `CLAUDE.md` §7.** Written as a reasonable default, not validated against your constraints. Marked PROPOSED for that reason.
5. **Every legal, statutory, data-protection and payroll rule in `docs/05-compliance-catalog.md`.** I checked the major items against public sources in August 2026 and cited them at the end of that file, but every one of those sources is secondary commentary from law firms and consultancies, not the primary instrument. Specifically flagged as moving targets: India's DPDP Rules phasing, the EU AI Act's high-risk deferral (which changed in July 2026), Colorado SB 24-205 (amended more than once), and the CERT-In incident-reporting clock (frequently mis-stated in secondary sources). The agents are instructed to mark all of this `[LAW — VERIFY]` and never state it as fact. **Neither I nor these agents are lawyers.** Get qualified counsel in each market before any of it reaches a payslip, a rejection letter, or a regulator.
6. **The competitive claims and the differentiators** in `CLAUDE.md` §5. Directionally reasonable, not researched to a standard you should quote in a sales deck. Treat them as hypotheses to test.
7. **HR trend framing.** Informed by public 2026 HR-trend write-ups (AIHR, Paychex among them), which are themselves largely vendor and practitioner commentary rather than peer-reviewed research. Useful for orientation; not evidence.

---

## The one thing to remember

The agents are not the product of this exercise. **`CLAUDE.md` and the NFR catalogue are.** The agents are just five consistent ways of applying them. If you spend your time anywhere, spend it there.
