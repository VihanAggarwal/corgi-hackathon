# Round 7: reconciling the "Taste Twins" framing

**Addendum to HARDENING.md and FEATURES.md. Same core, one genuinely better objective, one contradiction that has to be resolved before anything else.**

---

## Verdict up front

Three things in this version are improvements and should be adopted immediately. One is a narrow, defensible reopening of something previously cut. One is a direct contradiction of the thesis and cannot ship as written.

| Element | Call |
|---|---|
| **Broadening the palate as the goal** | **Adopt, and make it the objective function.** This is the best idea in the whole document and it is developed below |
| **iMessage as activation and sharing layer** | **Adopt, and run it alongside the agent rather than instead of it.** They solve different problems |
| **Duel cards as shareable objects** | **Adopt.** This is the only real growth mechanism the product has |
| **Trustworthy reviews as an input** | **Adopt in a narrow form only:** review text feeds attribute extraction, never recommendation ranking |
| **"Invite friends to become taste twins"** | **Cannot ship as written.** It inverts the thesis. Resolution below |
| **Name: Taste Twins** | Fine, with one caveat noted at the end |

---

# 7.1 Broadening the palate is a better objective, and it is measurable

The hardened spec optimizes for predicted utility: what will this person enjoy. That is what Google Maps optimizes for, what Yelp optimizes for, and what every recommender since Netflix has optimized for. Being marginally better at it is not a company.

"Broaden your palate" is a **different objective function**, and once stated that way it changes the math rather than just the marketing copy.

## The objective

Instead of maximizing `u(u,d) = θ_u · φ_d`, maximize expected utility **at the frontier of the user's known region**:

```
score(u,d) = P(user rates d positively | theta_u)
             x  novelty(d, R_u)

where R_u = the region of attribute space in which u has
            positively rated items, and novelty is distance
            from R_u's boundary, not from its centroid
```

Distance from the *boundary* rather than the centroid matters. Centroid distance rewards recommending the most alien thing possible, which is how you get a system that sends a person who likes braises a plate of natto and calls it discovery. Boundary distance rewards the adjacent unknown, which is how palates actually grow: one axis at a time.

## The metric nobody else has

**Palate volume:** the measured volume of `R_u`, tracked over time.

This is a north star no competitor optimizes for, and it is legible to a user in a way "recommendation quality" never is:

> Three weeks ago you ate inside a narrow band of salt, fat, and char. You have since added ferment and bitterness and you are eating across roughly 40% more of the space. You still will not touch sweetness in savory food and I have stopped trying.

That paragraph is the product's value proposition, generated from real data, in one screen. It is also the single most compelling thing in any version of this deck.

## Three things it fixes

1. **The Round 3.2 novelty and accuracy tradeoff dissolves.** Under a utility objective, a stretch pick that misses is a failure. Under an expansion objective, a stretch pick that misses is **the cost of the thing the user signed up for**, and the user knows it because the goal is stated. This is the correct resolution and it is much cleaner than the labeled exploration budget.
2. **It gives twins a job the content model provably cannot do.** The content model can only recommend inside `R_u`, because it can only extrapolate from what it has seen you like. Expanding `R_u` requires evidence from **outside your own history**, which is exactly and only what a taste twin provides. This is the strongest answer yet to attack 3.1, and it is worth making the central argument of the pitch.
3. **It makes retention measurable as progress rather than as habit.** A user with a growing palate has a reason to come back that is not novelty seeking.

## The honest risk

**Broadening is an aspirational preference, not a revealed one.** People say they want to expand and then order the pad thai. This is the gym membership problem, and it has killed better funded products than this one.

Mitigation, and it needs testing before it is believed: never make expansion the *ask*. Make it the **retrospective**. Nobody opens an app to broaden their palate. They open it to figure out what to order tonight. The expansion happens because the recommendations lean frontier-ward, and then it gets shown back to them monthly as something they accomplished. Aspiration is a terrible activation story and an excellent retention story.

---

# 7.2 The contradiction: friends cannot be the twins

"Invite friends to become taste twins" inverts the thesis the entire product rests on.

- **Sinha and Swearingen:** friends give better recommendations, but they mostly **remind** you of things you already know. Novelty comes from systems and strangers.
- **Kunkel et al.:** profile similarity and rating overlap drove choice. **Familiarity with the recommender did not.**
- And structurally: your friends eat with you. Their `R` overlaps yours heavily by construction. A friend twin can barely expand your palate, which under the new objective is the only thing that matters.

If twins are friends, this is Beli with duels.

## Resolution

**Friends are the acquisition channel. Strangers are the recommendation source. The invite never promises otherwise.**

- Inviting a friend does not make them a twin. It runs both of you through calibration and then **reports the truth**, which is usually that you are not twins.
- Twin assignment is computed globally over everyone in the system, by cosine, gated at k = 5, with no social graph input at any point. Friendship carries zero weight.
- The friend result is the shareable artifact, and the *disagreement* is more fun than the agreement:

> **You and Kalyan agree on 61% of duels.** You split hardest on sweetness in savory food, which he is fine with and you find genuinely offensive. He is not your taste twin. Your closest match in the system has never met either of you and orders things you would not have looked at.

That last sentence sells the product better than any agreement result would, and it is honest.

This also means the invite mechanic and the twin mechanic are cleanly separable in the build, which is good, because the invite ships in the hackathon and twins are gated on data volume.

---

# 7.3 iMessage: two layers, not one

The activation framing and the agent framing solve different problems and both should exist. They do not compete except for build hours.

| Layer | What it is | What it solves | Ships |
|---|---|---|---|
| **Extension (activation)** | iMessage app extension: duel cards sent into a thread, played inline, results shared back | Distribution and cold start. A duel card is a natural social object and the only organic growth mechanism in the design | **Hackathon** |
| **Agent (usage)** | Photon conversational agent: menu photo to order, the two hour follow up | Frequency and logging. Fires at the table, turns rating into a text reply | **Hackathon, reduced scope** |

The extension is the safer build: inline interactive message payloads are a well documented iOS pattern with no dependency on an unverified third party API. The agent is the more impressive one. Build the extension first and the agent second, because the extension cannot fail in a way that breaks the demo.

One rule carried forward unchanged from Round 4: **the extension moves duel cards and results, never messages between users about each other, and never a channel to a stranger.** All sharing is user initiated, into threads the user already has, with people they already chose.

---

# 7.4 Reviews, in the only form that survives Round 1

Round 1 cut review data because aggregating opinions from strangers with unknown taste is the exact failure the product exists to fix, and because bot detection is an unwinnable race against Yelp's own telemetry.

There is one narrow use that does not have those problems:

**Review text is an input to `φ` (what a dish *is*), never to ranking (whether you should order it).**

An LLM pass over review text extracts sensory corrections the menu does not contain:

- "much spicier than the menu suggests" → raise the heat axis
- "portions are enormous" → raise price per satiety
- "you cannot hear yourself talk" → venue noise
- "the vegetarian option is an afterthought" → constraint quality flag

This is attribute extraction, not opinion aggregation. It fixes the weakest part of the whole design (killer #2, the corpus), and it sidesteps bot detection entirely, because the filter is not "is this a real person" but **"does this sentence contain a specific, checkable sensory claim."** That is a much easier classification problem, and a bot writing "amazing service, five stars" contributes nothing either way and is discarded by the same filter.

Hard boundaries:
- Review scores are never ingested. Only text.
- No review or its author is ever surfaced to a user.
- Extracted claims carry confidence and are masked below threshold, same as menu extraction.
- Licensed or first party sources only. The Round 1 scraping cut stands.

---

# 7.5 Revised metrics

Replacing the north star from HARDENING, since the objective changed:

| Metric | Target | Kill threshold |
|---|---|---|
| **North star:** growth in palate volume per active user per month | measurable and positive | flat after 8 weeks means expansion is not happening and the premise is decorative |
| Twin sourced picks rated positively **and** outside `R_u` | 35%+ | below 20% means twins expand nothing |
| Twin sourced expansion rate minus content sourced expansion rate | strongly positive | **at or below 0 kills the twin premise.** The content model cannot expand `R_u` by construction, so if it matches twins here, `R_u` is measured wrong |
| Duel cards sent into iMessage threads per active user | 1.5+ | below 0.4 means there is no growth loop |
| Invite to calibration completion | 40%+ | below 20% means the card is not compelling |
| Duels per weekly active user | 40+ | below 15 means the feed is not a habit |

Row three is now the falsifying test. It is a sharper version of the Round 5 experiment and it can run on the same 30 person weekend, because palate volume is computable from the same ratings.

---

# 7.6 Revised demo

1. A judge gets a duel card **in Messages**, sent from the presenter's phone to theirs. They play it inline. No install.
2. Ten cards later, their palate portrait appears, written, on screen.
3. They send a card to the judge next to them. The result comes back: **the two of them are not taste twins**, and the screen says exactly where they diverge.
4. The system names the region of the space neither of them has ever eaten in, and recommends the one dish sitting just past the edge of it.
5. The agent handles the last beat: a menu photo, and the order.

Beat 3 is the one that lands, because it is the moment the product tells a judge something true and slightly unflattering about themselves in front of a room. Nothing else in a hackathon does that.

---

# 7.7 On the name

**Taste Twins** is clear, it is the source doc's own language, and it says what the product does. The one caveat: it names the mechanism with the hard kill threshold rather than the benefit. If row three above comes back at zero, the twins get cut and the name is stranded on a product that is now a palate expansion engine.

Not a reason to change it now. A reason to run the 30 person test before printing anything.

---

## What is now settled across all seven rounds

- **Core:** find food through people who taste like you. Unchanged since the source doc.
- **Unit:** the dish.
- **Objective:** expand the region of attribute space the person enjoys, not just predict inside it.
- **Mechanism:** interpretable 24 axis vectors, fit from duels, twins by cosine with no social graph input.
- **Human layer:** attributed by taste, never by identity. No stranger channel exists anywhere in the product.
- **Surfaces:** iMessage extension for activation and sharing, Photon agent for the table, app as the backstop.
- **Enterprise:** Merge, dietary constraints as anonymous filters, act two.
- **The one rule:** numbers about places, never numbers about people.
