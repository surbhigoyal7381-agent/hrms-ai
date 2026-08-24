# Fairness and Transparency Charter

> "Best in industry" is not a feature list. It is a set of things we will and will not do, written down before there is commercial pressure to bend them.

This file exists because the pressure will come. A customer will ask for keystroke monitoring. An investor will ask why we do not score employees. A sales cycle will stall on a feature we said we would not build. **Decisions made in advance, in writing, with reasons, survive that pressure. Decisions made in the meeting do not.**

Every agent reads this. The Reviewer enforces it.

---

## Part 1 — What "fair" means here, operationally

Fairness is not a value we assert. It is four properties we can test.

| Property | What it means | How we check it |
|---|---|---|
| **Consistent** | The same inputs produce the same outcome regardless of who the person is | Fixture set balanced across groups; assert outcome distribution |
| **Explainable** | The person affected can be told why, in one plain sentence | Every decision surface has a `reason` that is never null and never a code |
| **Contestable** | There is a route to a human who can overturn it | Every negative outcome carries a next step (`UX-04`) |
| **Accountable** | A named human owns every decision about a person | `decided_by` is a column, not a convention |

If a feature cannot satisfy all four, it does not ship as a decision. It may ship as information.

### The fairness review gate

Any feature that ranks, scores, rates, sorts, filters, flags, or recommends **people** must answer these before implementation. The BA writes the answers into the requirements; the Reviewer checks them.

1. **What does this change for the person at the bottom of the list?** If the answer is "nothing", why are we ranking at all? If the answer is "they get less", this is a decision, not information — apply the full set.
2. **What data feeds it, and does any of it proxy for a protected characteristic?** Tenure proxies for age. Location proxies for caste, race and class. Interruption counts in meetings proxy for gender. Referral source proxies for existing network composition. **Naming the proxy is the job** — you rarely eliminate it, but you must know it is there.
3. **Who is systematically disadvantaged by this design?** Part-time workers. People on parental or medical leave. Night-shift staff. People whose work is invisible — the ones who unblock others, mentor juniors, fix things quietly. Remote workers in a hybrid org. New joiners. **An engagement product that rewards visibility punishes the people who make visibility possible for others.**
4. **What is the gaming strategy?** Every people-metric is gamed within two quarters. Write down how, and what we do about it. If recognition counts can be inflated by mutual back-scratching, say so and design for it.
5. **What is the counter-metric?** The number that would tell us this is working badly while the headline number looks good.

### Fairness is a test, not an opinion

Run the ranking or scoring over a fixture population balanced across groups. Record the outcome distribution. **Record it even when it passes** — an auditor, a regulator, and a journalist will all eventually ask what you knew and when. "We assessed it and here is the result" is a completely different answer from "we never looked."

---

## Part 2 — Transparency, and where it stops

Transparency is one of our four pillars. It is also the pillar most easily turned into harm, so it needs a sharper definition than "be open."

### The rule

> **Default to showing a person everything that is about them, and everything that affects them.**
> **Default to hiding what is about someone else.**
> **When those collide, the more vulnerable person's privacy wins, and we say so in the UI.**

That last clause matters. Silent asymmetry breeds suspicion. A visible "this is hidden, and here is why" is more trust-building than a screen that pretends nothing is missing.

### Default visibility matrix

Tenant admins may restrict these further. **They may not make anything more visible than the "Everyone" column without an explicit, logged, in-product decision that employees are notified of.**

| Data | The person | Their manager | Skip-level | HR | Everyone in tenant |
|---|---|---|---|---|---|
| Own profile, role, org position | ✅ | ✅ | ✅ | ✅ | ✅ |
| Own salary | ✅ | Policy-gated | ❌ | ✅ | ❌ |
| Salary **band** for own role | ✅ | ✅ | ✅ | ✅ | ✅ |
| Own performance rating **and its reason** | ✅ | ✅ | ✅ | ✅ | ❌ |
| Who decided it, and when | ✅ | ✅ | ✅ | ✅ | ❌ |
| Own leave balance and history | ✅ | Balance only | ❌ | ✅ | ❌ |
| Reason a request was rejected | ✅ | ✅ | ✅ | ✅ | ❌ |
| Org chart and reporting lines | ✅ | ✅ | ✅ | ✅ | ✅ |
| Open positions and who is hiring | ✅ | ✅ | ✅ | ✅ | ✅ |
| Policies that apply to them, and version history | ✅ | ✅ | ✅ | ✅ | ✅ |
| Who has viewed their sensitive data | ✅ | ❌ | ❌ | ✅ | ❌ |
| Survey responses attributed to them | ❌ **nobody, ever, if promised anonymous** | ❌ | ❌ | ❌ | ❌ |
| Identity of a grievance/POSH complainant | Case handlers only, need-to-know | ❌ | ❌ | Restricted | ❌ |

**Salary bands are visible; individual salaries are not.** This is the deliberate middle position: pay-range transparency addresses the information asymmetry that drives unfair outcomes, without exposing individuals to comparison they did not consent to. It is also increasingly what pay-transparency regulation asks for `[LAW — VERIFY per market]`.

**"Who has viewed my sensitive data" is a feature.** Most systems log access and show it to nobody. Showing Aisha that three people opened her salary record last month, and who they were, costs us one screen and buys a category of trust that competitors do not have.

### Where transparency legitimately stops

Not everything hidden is a cover-up. These are principled limits, and the product should say so out loud rather than hiding the fact that something is hidden:

- **Anonymity that was promised.** Absolute. No admin override, no legal-hold exception path, no "just this once" for an executive. If a survey said anonymous, there must be **no query path** from response to identity. This is enforced in the schema, not in the UI.
- **Small groups.** A team of four cannot receive anonymous feedback that stays anonymous. Suppress below the threshold and explain why the number is not shown.
- **Ongoing investigations.** Premature disclosure endangers complainants. Time-boxed, audited, with the scope of the exception recorded.
- **Other people's personal data.** Transparency about *me* never means transparency about *my colleague*.
- **Genuine security context.** Rare. Must be specific, not a general excuse.

**What is never a valid reason to hide something:** it is embarrassing to the company; it would prompt questions about pay equity; it makes a manager look bad; it might increase attrition. Those are reasons the information matters.

### The Transparency Ledger

The mechanism that makes the pillar real rather than aspirational.

**Every decision that affects a person creates a ledger entry**, visible to that person by default:

```
what happened      Leave request 12–14 Sept rejected
who decided        Rohan Mehta (Engineering Manager)
when               22 Aug 2026, 14:32 IST
why                "Two others are already off that week and we have the
                    release on the 13th. Can you take 19–21 instead?"
what you can do    Discuss with Rohan · Request HR review · Withdraw
```

Design rules:

- **`reason` is `NOT NULL`.** A decision surface that lets a manager reject without typing a reason is a defect, not a convenience. This is enforced in the schema.
- **Reasons are written to the person, not about them.** "Capacity constraint — team utilisation at 87%" is a system talking to itself. The example above is a human talking to Aisha.
- **The ledger is append-only.** Corrections append; they do not overwrite. Rewriting a reason after the fact is exactly what a ledger exists to prevent.
- **If AI contributed, the entry says so** in plain language, with the main factors and the recorded human decider (`COMP-71`–`COMP-73`).

---

## Part 3 — What we refuse to build

This is the most commercially uncomfortable section and the most important one. Some of these will be asked for by paying customers. **The answer is no, and here is the reason we give them.**

### Surveillance

We do not build, and will not integrate:

- **Keystroke logging, screenshot capture, or webcam monitoring.** No exceptions for "productivity insights."
- **Continuous location tracking** of employees. Location tied to a specific, disclosed, time-bounded purpose — a field-service check-in, a site-safety headcount — is legitimate. Ambient tracking is not.
- **Sentiment or emotion scoring of private communications.** Reading employees' messages to score their mood is surveillance with a friendly UI.
- **"Flight risk" scores shown to managers.** The harm is concrete and well understood: the flagged person is quietly excluded from long-term projects, which causes the attrition the model predicted. A self-fulfilling prophecy is not a prediction. Aggregate, anonymised retention analysis for HR is a different thing and is fine.
- **Productivity scores that reduce a person to a number** for comparison or ranking.
- **Covert anything.** If an employee would be surprised to learn it is happening, it does not ship. Surprise is the test.

**How we say no:** "We do not build monitoring tools. We build tools that make good work visible. If the underlying problem is that you cannot tell what your remote team is doing, monitoring will not fix it — it will confirm your worst assumptions and cost you the people you most want to keep. Here is what we would build instead."

### Dark patterns

- No manufactured urgency in HR flows. A benefits deadline is a fact; a countdown timer designed to panic someone is manipulation.
- No consent-fatigue design. Withdrawing consent takes the same number of taps as granting it (`COMP-12`), and the withdrawal control is the same size and prominence as the grant control.
- No opt-out-by-default for anything an employee would reasonably decline.
- No pre-ticked boxes. Anywhere.
- No streaks, badges or leaderboards on wellbeing, leave, or attendance. Gamifying rest produces people who do not rest.
- No "your manager will see that you declined" pressure framing.

### Automated decisions about people

- No AI-only adverse decision. Ever. Rating, pay, PIP, termination, rejection, disciplinary flag (`AI-02`).
- No automated ranking of people against each other without a named human owner of the outcome.
- No black-box scores. If we cannot explain the main factors in one plain sentence, we do not show the score.

### The overriding test

> **If we would not be comfortable explaining this feature, in plain language, to the employees it operates on — we do not build it.**

Not to the buyer. To the people it is done to. Those are different audiences and the second one is the honest test.

---

## Part 4 — How this gets enforced

A charter that lives only in a document is decoration. This one has teeth in four places:

1. **PM** — the opportunity brief names the pillar, the counter-metric, and who is disadvantaged by the design. A feature that fails the refuse-to-build list is declined at gate 1, in writing, with the reason recorded so the next person who asks gets the same answer.
2. **BA** — the visibility matrix becomes an explicit permissions matrix per feature. `reason NOT NULL` is a requirement with a test. The fairness review gate questions are answered in `20-requirements.md`.
3. **Full-Stack** — the ledger is schema, not convention. Anonymity has no query path. `decided_by` is a column.
4. **Reviewer** — checks this file as part of every review, and **a violation is a BLOCKER**, ranked by consequence to a person like everything else.

## Part 5 — Reviewing the charter itself

This document should change as we learn — but changes need friction, or it will quietly erode under commercial pressure.

- Review every six months, or when a customer request conflicts with it
- **Every change is a commit with reasoning in the message.** Removals especially — a deleted line in Part 3 should be visible in the history forever
- Adding a restriction: normal decision
- Removing a restriction: requires the argument written down, and the argument must address the harm the restriction was preventing, not just the revenue it is costing
