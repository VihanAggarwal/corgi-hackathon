# Taste Twins: build spec

**Word of mouth, synthesized. Feature list, Merge integration, development plan.**

---

# Part 1: what "word of mouth" actually means

A recommendation from a friend beats a five star review, and the reason is not warmth. It is three specific properties that reviews structurally cannot have.

| Property | What a friend does | What a review does |
|---|---|---|
| **Provenance** | You know whose taste it is and how it maps to yours | Anonymous stranger, unknown palate, averaged into a number nobody holds |
| **Specificity** | "Get the mapo, skip the dumplings, go before 7 or you'll wait" | "Great food, great service, will be back" |
| **Calibration** | Knows what you will hate and says so unprompted | Never mentions who should avoid it |

The agent's job is to reconstruct all three from many people at once. It is not to sound friendly. Friendliness without those three properties is exactly what a blast recommendation sounds like, which is the thing we are trying to defeat.

## The stance

**The agent is not your friend and should never pretend to be.** It is the person in your life who knows a lot of people and pays attention. Its credibility comes from citing real judgments, not from performing warmth. Faking intimacy is both the fastest way to feel creepy and the fastest way to sound like an ad.

## Voice rules, enforceable in code review

1. **Every claim traces to evidence.** No sentence may assert anything not present in the evidence packet (Part 3). This is architectural, not stylistic.
2. **Lead with the dish, not the venue.** Word of mouth is "get the X," not "check out Y."
3. **Always include a negative.** What to skip, when not to go, who this is wrong for. A recommendation with no downside is an advertisement.
4. **Name the divergence from the crowd.** "This is not what the room orders" is the single most informative sentence the system can produce.
5. **No enthusiasm without cause, and no enthusiasm markers ever.** No exclamation points, no "you'll love," no emoji. Enthusiasm is the tell.
6. **Say when the data is thin.** "Only two people I trust for you have eaten here" is more trustworthy than a confident guess, and it is true.
7. **Short.** Two to four sentences. A friend does not send a paragraph.
8. **Never explain the algorithm.** "People who share your thing about sweetness" not "users with cosine similarity above threshold."

## Target voice

**Wrong:**
> You'll love Hunan Slurp! It's highly rated by users with similar tastes to you. Their noodles are a must-try!

**Right:**
> Hunan Slurp, get the liang pi. Six people who share your thing about sweetness in savory food picked it over the noodles, which is not what the room does here, the room orders noodles. Two of them said it is colder than they expected, so probably not tonight if you are cold.

The second one is doing work. It names a dish, names the population and what defines them, names the contrarian move, and hands over a real caveat. None of it is invented.

---

# Part 2: the anti-blast machinery

The failure mode is a crowd average wearing a friendly voice. Five mechanisms prevent it, and they are all pre-generation. By the time the LLM sees anything, the blast recommendations are already gone.

## 2.1 Divergence requirement (the definition of word of mouth)

An item enters the twin channel only if **twin support exceeds population support by a margin.** If everyone likes it, it is not word of mouth, it is a billboard.

```
lift(d) = P(positive | twins of u) - P(positive | population)
twin channel requires lift(d) > delta
```

The universally beloved place still gets recommended, but through the content model, framed as a safe pick, never as "people like you found this."

## 2.2 Consensus ceiling and noise floor

Carried from Round 2.5. Items where population agreement exceeds 85% carry no information about anyone. Items below 55% are noise, not taste. Both are excluded from similarity fitting and from the twin channel.

## 2.3 k-floor with independence

Minimum 5 supporting twins, and they must be **independent**: no shared invite chain, no same-device history, no burst of accounts created in the same window. Five accounts made by one restaurant do not clear this.

## 2.4 Reliability weighting

A twin's influence is `cosine x reliability`, where reliability is out of sample hit rate. Never displayed to anyone (Round 4.4). A user who is similar but noisy contributes nothing.

## 2.5 Astroturf economics

Gaming this requires building a fake account with a **coherent duel history** that lands in a specific taste cluster, then repeating it five times independently, per cluster you want to reach. Influence is per palate, not global. There is no broadcast. That makes manipulation expensive per person reached, which is the only durable defense any recommendation system has ever had.

---

# Part 3: the evidence packet (this is the "personalized AI")

The LLM never queries the database and never decides anything. It receives a structured packet and renders it as speech. It cannot add facts, and if the packet is thin, the message says so.

```json
{
  "user_axes_relevant": [
    {"axis": "sweetness_in_savory", "value": -2.1, "percentile": 4},
    {"axis": "acid", "value": 1.8, "percentile": 88}
  ],
  "dish": {"name": "liang pi", "venue": "Hunan Slurp",
           "phi_confidence": "high"},
  "twin_support": {"n": 6, "lift": 0.34, "k_floor_met": true},
  "population_baseline": {"top_dish": "noodles", "share": 0.61},
  "caveats": [{"source": "twin_note", "n": 2,
               "claim": "served cold, unexpected"}],
  "expansion": {"outside_region": true, "axis": "sour_ferment",
                "distance": "adjacent"},
  "source_channel": "twin",
  "confidence": "medium"
}
```

Rules on the renderer:
- Any sentence not grounded in a field is a bug, not a style issue
- `confidence: low` forces a hedge in the output
- `k_floor_met: false` means the twin channel cannot be mentioned at all
- Caveats are mandatory in the output when present
- The renderer never sees user identities, constraint values, or reliability scores

This is what separates personalized AI from a recommender with a chat skin. The personalization is in the packet. The AI is what makes it sound like a person told you.

---

# Part 4: full feature list

## Layer A: core product

| # | Feature | Phase |
|---|---|---|
| A1 | Duel feed: two dishes, pick one, actively selected for information gain | **Hackathon** |
| A2 | Interpretable 24 axis preference vector fit by Bradley-Terry with shrinkage | **Hackathon** |
| A3 | Palate portrait: generated prose profile, rewritten as it learns, must include one unflattering truth | **Hackathon** |
| A4 | Dish corpus: LLM extraction of dish vectors from menus, per axis confidence, hand verified diagnostic pool | **Hackathon** |
| A5 | Twin computation: cosine, k=5 floor, reliability weighted, no social graph input | **Hackathon** |
| A6 | Frontier recommendation: score at the boundary of your region, not the centroid | **Hackathon** |
| A7 | Palate volume tracking: the region you enjoy, measured over time | **Hackathon** |
| A8 | Review text to attribute extraction (sensory claims only, never scores, never ranking) | Phase 2 |
| A9 | Dish logging with rating, in app | Phase 2 |
| A10 | Notes: one line, dish attached, no identity, no reply path, unlocked at a threshold | Phase 3 |
| A11 | Monthly palate expansion recap | Phase 2 |
| A12 | Travel palate passport: your vector in a city with no users | Phase 2 |
| A13 | Cook it: recipe tuned to your axes | Phase 3 |

## Layer B: iMessage extension (activation and sharing)

| # | Feature | Phase |
|---|---|---|
| B1 | Duel card as an inline interactive message, playable in thread, no install | **Hackathon** |
| B2 | Friend comparison result: agreement rate, hardest divergence axis, and the honest "you are not twins" | **Hackathon** |
| B3 | Share a recommendation into a thread as a rich card | **Hackathon** |
| B4 | Invite to calibrate, which seeds the graph without promising twinhood | **Hackathon** |
| B5 | Group thread tag: agent responds only when tagged, uses opted in members' vectors, never reveals whose constraint | Phase 2 |

## Layer C: Photon agent (usage)

| # | Feature | Phase |
|---|---|---|
| C1 | Menu photo to order: vision extraction, on the fly vectors, word of mouth reply | **Hackathon** |
| C2 | Two hour follow up: "how was it" to rating to visible model update | **Hackathon** |
| C3 | Duels as texts, no app needed | Phase 2 |
| C4 | "I'm at X, what do I get" and "find me lunch under $20" | Phase 2 |
| C5 | Twin dispatch: proactive, k-anonymized, lift gated | Phase 2 |
| C6 | Allergy question generator (questions to ask, never a safety guarantee) | Phase 2 |

## Layer D: enterprise (Merge)

Detailed in Part 5. E1 ships in the hackathon, the rest are Phase 2 and 3.

---

# Part 5: Merge integration, itemized

Merge's actual categories are HRIS, ATS, CRM, accounting, ticketing, file storage, and knowledge base. There is no consumer or venue connector and it is not a scraper, so it does no work on the consumer side. It does a great deal of work on the enterprise side, and that side is the best monetization in the design.

| # | Merge category | What we pull | What it does | Phase |
|---|---|---|---|---|
| **E1** | **HRIS** | Dietary and accommodation records already on file | **The dinner where nobody has to announce anything.** Constraints applied as an anonymous filter. The organizer sees "four constraints applied," never which or whose | **Hackathon** |
| **E2** | **File storage** | Expense and travel policy documents | LLM reads the policy once and turns "$45 per diem, $80 for client dinners in NYC" into a hard price filter nobody has to remember | Phase 2 |
| **E3** | **CRM** | Client records, meeting notes, preferences | Client dinner brief: vegetarian per last meeting, hates loud rooms, flying in from Osaka, so not Japanese. Three options with reasoning | Phase 2 |
| **E4** | **HRIS** | New hires, office transfers, start dates | Relocation welcome: a new joiner gets their neighborhood through their own palate instead of a generic "lunch near the office" list | Phase 2 |
| **E5** | **ATS** | Candidate records with stated dietary needs | Interview lunches that work without anyone having to ask the candidate an awkward question | Phase 3 |
| **E6** | **Accounting** | Actual meal spend | Closes the loop on E2: did the dinner land inside policy, without anyone filing anything | Phase 3 |
| **E7** | **Knowledge base** | Company norms and event guidelines | Applies unwritten rules, for example no alcohol at team events, quiet rooms for accessibility | Phase 3 |
| **E8** | **HRIS + internal graph** | Team membership | A company's own employees form a taste cluster over time, so office lunch suggestions get better with use | Phase 3 |

## Non negotiable guardrails on all of it

Dietary and medical records are GDPR Article 9 special category data. The following are architectural, not policy:

1. **Constraints are applied as set intersection before any model call.** The LLM never receives a constraint value, a constraint type, or a person it belongs to. It receives a pre-filtered candidate list and a count.
2. **Never displayed, never attributed, never exported.** The organizer sees a number, not a list.
3. **Never enters `θ`.** Two people are not taste twins because they are both kosher.
4. **Explicit per employee consent, revocable, with deletion propagating.**
5. **Nothing from the enterprise side ever touches the consumer recommendation ranking, and nothing is ever sold.**

---

# Part 6: development plan

## Phase 0: validate before building (one weekend, no code)

The premise is falsifiable and the test is cheap. Do this first.

| Step | Detail |
|---|---|
| Recruit | 30 people, one neighborhood |
| Pool | 40 dishes, hand verified attributes |
| Collect | 20 duels each in a Google Form |
| Fit | Bradley-Terry in a spreadsheet, 30 users, 24 axes |
| Test | Send each person 3 content picks and 3 twin picks, shuffled, unlabeled |
| Measure | Rating, and "was this outside what you'd normally order" |
| **Kill condition** | If twin picks do not beat content picks **on items rated outside the usual**, the twin premise is dead. Stop and rethink before writing code |

## Phase 1: hackathon (72 hours)

| Hours | Track | Deliverable | Done when |
|---|---|---|---|
| 0 to 10 | Data | Corpus: ~300 venues, ~8,000 dishes, LLM extraction with confidence, 200 hand verified | Diagnostic pool verified, extraction accuracy above 90% against it |
| 0 to 10 | Infra | Supabase, pgvector, RLS on constraints and reliability, auth | Constraint table unreadable by anything but the filter path |
| 10 to 22 | Model | Bradley-Terry fit, shrinkage, active duel selection | `θ` stable in under 15 duels |
| 10 to 24 | iMessage | **B1 duel card, B4 invite, B3 share** | A phone that has never seen the product plays a duel in a thread |
| 22 to 32 | Model | **A5 twins**, k floor, lift gate, reliability weighting | Twins stay off below threshold, and blast items are provably excluded |
| 24 to 34 | iMessage | **B2 comparison result**, including the honest not-twins outcome | Two phones compare and get a real divergence axis |
| 32 to 42 | Generation | **Evidence packet + renderer**, voice rules enforced | No output sentence exists that is not in the packet |
| 34 to 44 | Agent | **C1 menu photo to order** | An unseen menu returns a grounded, specific reply |
| 42 to 50 | Generation | **A3 palate portrait**, **A7 palate volume** | Portrait includes a true unflattering line, volume renders as a number and a sentence |
| 44 to 52 | Agent | **C2 two hour follow up** | A text reply updates `θ` and the change is visible |
| 52 to 60 | Enterprise | **E1 Merge HRIS team dinner** | Four constraints applied, zero displayed |
| 60 to 68 | Demo | QR path, seeded corpus labeled as seeded, failure states | Four cold phones complete the flow in under 90 seconds |
| 68 to 72 | Rehearse | Three clean runs including on hostile wifi | Works with the network off for the corpus path |

**Cut order if time runs short:** E1 Merge, then C2, then A3, then B2. **Never cut B1 or C1.** Those two are the product.

## Phase 2: post hackathon, weeks 1 to 8

A8 review extraction, A9 logging, A11 recap, A12 travel, B5 group threads, C3 to C6 agent expansion, E2 to E4 Merge. Corpus expands to a full borough. Twins turn on at population scale.

## Phase 3: months 3 to 6

A10 notes with full moderation, A13 cook it, E5 to E8, menu intelligence B2B with the published firewall, second city.

---

# Part 7: what each number proves

| Metric | Target | What its failure means |
|---|---|---|
| Twin expansion rate minus content expansion rate | strongly positive | **At or below 0, twins are decorative and the product is a worse Google.** This is the one that matters |
| Palate volume growth per active user per month | positive and measurable | Flat means expansion is marketing, not mechanism |
| Duel cards sent per active user | 1.5+ | Below 0.4 there is no growth loop and CAC kills it |
| Invite to calibration completion | 40%+ | Below 20% the card is not compelling enough to spread |
| Duels per weekly active | 40+ | Below 15 the feed is not a habit and `θ` never stabilizes |
| Agent replies acted on | 20%+ | Below 8% the word of mouth voice is not landing |
| Menu extraction accuracy vs verified pool | 90%+ | Below 75% the corpus poisons the model |
| Twin recs meeting the lift gate | plenty available | If few items clear it, the population is too small or too homogeneous |
