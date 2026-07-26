# Fourtop

**From "find food through people who taste like you" to a product that can actually exist.**

Five hardening rounds. Each round attacks the current version using evidence from prior art, academic literature, competitor behaviour, and startup history. Each response either fixes the design or concedes the point and cuts scope.

---

## 0. The baseline (what the source doc proposed)

> "Find food through people who taste like you."

Core flow as written:
1. User builds a profile from a few signals (cuisines, price, dining style, dietary constraints, neighborhood, vibe)
2. App finds **taste twins** / **taste neighbors**
3. Recommendations come from those people, not from the crowd average
4. Follow-up questions via **anonymous, platform-mediated chat**
5. Mutual opt-in reveals identity or moves to a local group meet-up

Plus loose notes: foot traffic as a popularity signal, removing bot reviews by scraping Yelp, Merge for integrations and scraping, Photon for notifications.

Framing brief from the sponsor deck: *"Don't just wire up a workflow, use AI to make something that expresses, not just executes."*

---

# Round 1: does this thing have a right to exist?

### The attack

**1.1 Beli is already this, already funded, already winning the demographic.**
Beli (founded 2021, NYC) does comparison based restaurant ranking, friend feeds, "friend rating" averages, and literally ships a screen called **Taste Profile**. It raised $5.3M seed from Goodwater and runs ~46 people. 80% of users are under 35 and the app grows almost entirely through referral. The proposed core flow is Beli's shipped product with one variable changed: strangers instead of friends.

**1.2 Google shipped the headline number eight years ago.**
Google Maps "Your Match" gives a 0 to 100 personalized score per restaurant, computed from your ratings, location history, and stated food preferences. So `"this recommendation came from someone whose taste profile matches yours 87%"` is a commodity UI element, available free, on the largest distribution surface in existence, backed by more behavioural data than any startup will ever have.

**1.3 This exact company already ran, and returned roughly nothing.**
Ness Computing (2011) built "personalized restaurant recommendations using machine learning based on what people with similar tastes like." It sold to OpenTable for about $17.3M after raising ~$15M. That is a wash, not an outcome. Nara ran a taste graph recommendation engine across 25 cities and is gone. Foursquare had the best taste graph anyone has ever assembled and abandoned consumer discovery to sell location data B2B. Three serious attempts, zero consumer survivors.

**1.4 The similarity math does not work at this data density.**
POI recommendation matrices run 99%+ sparse. Concretely: NYC has roughly 25,000 restaurants. A genuinely enthusiastic user logs maybe 60 in a year. Two random NYC users' expected overlap is `60 x 60 / 25,000 ≈ 0.14 restaurants`. You cannot compute a meaningful taste similarity from an intersection of zero. Any system reporting "87% match" on that data is silently computing content similarity (cuisine tags, price band, neighborhood), which is exactly what Google already does, for free, better.

**1.5 Anonymous stranger chat plus meetups is a liability, not a feature.**
Secret reached a ~$100M valuation and shut down in 2015 over harassment. Yik Yak shut down in 2017 after bomb threats caused actual school evacuations, because growth outpaced moderation. The proposal is anonymity, plus strangers, plus a built in path to in person meeting. That is the exact configuration that ends products, and it is a grooming vector. It is also the part that gets you removed from the App Store, not the part that gets you users.

**1.6 Scraping Yelp to strip bot reviews is a bad business on three axes.**
*Legal:* hiQ and the 2024 Meta v Bright Data ruling protect logged out public scraping from CFAA liability, but breach of contract and state tort claims survive, and Yelp's ToS forbids scraping outright. *Competitive:* Yelp already removes ~5% of reviews and flags another ~18% as not recommended, using behavioural telemetry you cannot see. *Technical:* the best published detectors hit ~91% on curated Yelp benchmarks and drop toward ~68% on real world Yelp data. So the product is a measurably worse copy of Yelp's own filter, running on a subset of Yelp's data, killable by one WAF rule.

**1.7 Merge cannot do what the notes say.**
Merge's unified API covers HRIS, ATS, CRM, accounting, ticketing, file storage, and knowledge base. It is B2B SaaS infrastructure. There is no Yelp connector, no Google Maps connector, no consumer connector, and Merge is not a scraping tool. "Use merge for integrations + scraping" is not implementable as written.

**1.8 Per city cold start, repeated forever.**
A taste twin graph needs many users *in your city* with *overlapping* logged venues. Every new city restarts from zero liquidity. This is the hardest bootstrap shape in consumer software and it is why local social apps die.

**1.9 No monetization survives contact.**
Reservation commissions belong to OpenTable and Resy, who own the supply relationship. Delivery affiliate belongs to DoorDash and Uber. Promoted listings need scale you do not have. A pre scale discovery app has leverage on none of them.

**1.10 The wedge is a feature, not a product.** Beli can ship "taste twins" in one sprint.

### The response

**Kill list, no negotiation:**
- Anonymous stranger chat and stranger meetups. Deleted, not mitigated.
- Yelp scraping as the data spine.
- Bot review detection as a product.
- "87% taste match" as a headline number.
- "Social network for food" as the category.

**What survives is the insight, not the mechanism.** And the insight is real, non obvious, and supported by two findings that point in opposite directions:

1. **Sinha and Swearingen (2001), "Comparing Recommendations Made by Online Systems and Friends":** friends consistently produced *better* recommendations than six commercial recommender systems. But critically, friends' recommendations mostly **reminded** users of things they already knew about, while the systems surfaced items that were **new and unexpected**.

2. **Kunkel et al., "Trust Related Effects of Expertise and Similarity Cues in Human Generated Recommendations":** in human sourced recommendations, **profile similarity and rating overlap significantly influenced choice, while familiarity with the recommender did not.**

Read together those give a genuine thesis:

> **Trust comes from demonstrated taste overlap. Novelty comes from strangers. Friendship supplies neither.**
> The ideal recommender is therefore a stranger with proven overlap, which is precisely what Beli (friends, so novelty poor) and Google (algorithm, so trust poor) both fail to deliver.

That thesis is worth keeping. The mechanism has to change.

**Fix 1.4 (the math): stop computing similarity from co-visitation.**
Two mechanisms replace it:

- **Forced choice calibration.** Instead of a preference form, present head to head pairs drawn from an item pool engineered so the population splits near 50/50. Fifteen well chosen binary splits partition users into 2^15 cells. This is adaptive testing, not a survey. It gives dense signal from a cold user in about ninety seconds.
- **Similarity on the disagreement axis.** Everyone likes the good restaurant. Weight each co-rating by the **entropy of the population's rating distribution on that item**. Two people agreeing a beloved place is great tells you nothing. Two people both disliking a critically adored place tells you a great deal. This yields a meaningful similarity from roughly 8 informative overlapping items rather than 500 arbitrary ones.

**Fix 1.8 (cold start): launch a bounded graph, not a city.** Beli grew 80% by referral inside social clusters. Density inside a closed group is achievable; density across a metro is not.

**Fix 1.5 (safety): no stranger to stranger free text in v1, at all.**

**Fix 1.7 (Merge): the honest Merge surface is B2B, and it is developed properly in Round 5.**

---

# Round 2: attack the fixed version

### The attack

**2.1 The 90 second calibration is a wall in front of an app nobody agreed to want.**
Fifteen screens before any value is a conversion disaster. Beli's actual genius is that the ranking comparison happens *after* you logged a meal you already ate. The preference work is a byproduct of something the user wanted to do anyway. Yours is a tax.

**2.2 The data import path is fantasy for consumers.** Google Takeout takes hours to days, produces a multi gigabyte archive, and Maps Timeline has been moved on device with a repeatedly changing export format. Asking for that before first value is worse than the fifteen questions.

**2.3 Entropy weighted similarity is a clever invented metric with zero evidence it improves recommendations users accept.** Worse, its failure mode is structural: weighting by disagreement selects for **contrarians**. Your taste twins become systematically the people with unusual opinions, and your recommendations become weird rather than good.

**2.4 A closed campus graph has the wrong shape.** A campus has maybe 60 restaurants in range and students rotate through 15. There is no discovery problem there. The discovery problem is real in dense, high optionality, high turnover markets, which is exactly where cold start is hardest.

**2.5 Deleting chat deletes the "human" from "make it feel human."** You optimized risk to zero by removing the product.

**2.6 Still no wedge against Beli.** They have the ratings data and 46 employees.

**2.7 Frequency is the silent killer, and it kills this.**
How often does a person genuinely need a *new* restaurant recommendation? For most people, one to three times a month. That is below the retention floor for a standalone consumer app. Beli survives on a different loop entirely: it is a **logging and status** app (rank your meals, publish your list, compare with friends), and discovery is the pretext, not the habit. You have no equivalent habit.

### The response

2.7 is the deepest criticism and it reframes everything. **The habit cannot be "find a restaurant." The habit has to be something that happens multiple times a week, with the recommendation as a byproduct.**

So what actually happens multiple times a week? **Deciding where to eat with other people.**

The real unit of friction is not "find a good restaurant." It is *"four of us are trying to pick a place, it is 6:40pm, nobody will commit, and the group chat has been three shrug emojis for eleven minutes."* Highest frequency, highest felt pain, most universal, least solved.

Supporting evidence that the pull is real: both Ness (2013) and Nara (2013) eventually shipped group decision features. Both did it as a late bolt on to a discovery engine. That is the wrong order.

**Pivot the surface from discovery engine to group decision engine, with the taste graph as the engine underneath.**

New core flow:
1. Someone opens a session: *dinner, Thursday, 4 people, Lower East Side, around $40*
2. Each person swipes about 8 cards. This is not onboarding. It is the task, and it is fun.
3. The system resolves to one pick **with a stated reason**: *"this is the one all four of you put top three. Maya was the holdout and this is her number two."*
4. Every swipe in every session silently builds the taste model.
5. Sessions require participants, so the social graph arrives for free and **every use is a three person invite event**.

What this fixes:

| Criticism | Resolution |
|---|---|
| 2.1 onboarding tax | Preference elicitation *is* the product now, not a gate in front of it |
| 2.7 frequency | Group meals run 4 to 8 times a month, and the decision moment fires even when the answer is a familiar place |
| 1.8 cold start | Each session imports 3 users; the graph seeds itself in clusters |
| 2.4 density | The wedge is the group, not the city; it works at any venue density |
| 2.5 human feel | Restored, but between people who already know each other, so zero stranger safety surface |
| 2.6 Beli wedge | Beli is a solo logging and status app. Real time group decisioning is a different product, a different loop, and a different dataset. Beli's "friend rating" is an **average**, which is the wrong primitive for group decisions (see Round 3) |

**2.2 conceded:** Takeout import demoted to an optional power user path, removed from onboarding entirely.

**2.3 conceded and deferred:** in the group framing you do not need taste twins in v1 at all. You need **preference aggregation**, which unlike invented similarity metrics is a rigorous, centuries old field with real results. Taste twins become act two, built on dense data act one produces.

---

# Round 3: attack the group decision pivot

### The attack

**3.1 This is a famous graveyard.** "Tinder for restaurants" and group dinner deciders are a decade long procession of corpses. The reason is brutal and simple: the group already has a coordination tool, it is the group chat, and no app beats "send three links in iMessage."

**3.2 Multiplayer activation is the hardest activation shape there is.** The product literally does not function with one user. If one of four does not install, the session dies. That is N=4 activation.

**3.3 You have not said what you do instead of averaging, and averaging is mathematically the wrong answer.** Averaging produces the blandest possible restaurant, the one nobody hates and nobody wanted. That is exactly the 4.2 star crowd average failure the original idea was reacting against. Average four people and you have rebuilt the crowd average at N=4.

**3.4 You abandoned the actual insight.** The source doc was about *whose opinion to trust*. Group decisioning does not use that at all.

**3.5 Monetization is now worse.** A session utility used 4 to 8 times a month has no payment moment and no supply side relationship.

**3.6 No moat.** OpenTable, Resy, Google, and Apple can all ship "pick a place with friends."

### The response

3.1 and 3.2 have the same answer: **do not require the group to install anything, and live inside the group chat instead of fighting it.**

**The session is a link.** One person installs. They paste a link into the chat they already use. The other three tap it, swipe 8 cards in a web view with no account, and the session resolves. Participants who swipe get a device scoped profile that becomes a real account the day they organize their own session.

This converts N=4 activation into **N=1 activation with a guaranteed 3 person exposure event per use.** That is the Doodle / Calendly / Splitwise pattern, and it is the only pattern that has ever worked for group coordination software.

**3.3 is the technical heart, and it is where the real IP lives.** The answer is not averaging. It is social choice aggregation with an explicit fairness memory:

- **Condorcet family aggregation, not mean score.** A Condorcet winner beats every alternative head to head. That is a fundamentally different object from a high average: it is the "everyone's top three" pick rather than the "nobody's enemy" pick. When no Condorcet winner exists (cycles are common in small groups), resolve with ranked pairs and **say so in the UI**: *"no clear winner, here are the two that split you."*
- **Minimax regret, not maximum mean.** Optimize for the least satisfied member, not the average. This is the single most important product decision in the whole design, because a group's memory of a dinner is set by the person who had the worst time.
- **The fairness ledger.** Track, per group, who has been conceding. Weight the next session toward the person who gave way last time, and say it out loud: *"going with Maya's pick, she took one for the team twice in a row."*

The fairness ledger is the moat. No competitor can compute it without your longitudinal group history, and it maps onto a real, deeply felt social dynamic that every friend group has and no product has ever named. It is also what makes it *feel human*, which was the literal brief in the sponsor deck.

**3.4 answered by sequencing.** The taste twin insight is not abandoned, it is promoted to act two. Once sessions accumulate, you know exactly how each person ranked items in **head to head contests against a controlled item pool**, which is the dense, low sparsity signal Round 1 proved you could never get from co-visitation. **The group decision product is the data collection instrument for the taste graph.** Ness and Nara built the graph first and had no reason for users to feed it. That is the inversion.

**3.5 monetization, three staged paths:**

1. **Demand shaped supply.** You know a specific party of 4 has resolved to eat in a specific neighborhood at a specific hour. That is qualified, time bound, party sized booking intent, worth far more than an impression. Sell **soft night fill**: a restaurant bids to be added as a candidate in sessions for Tuesday and Wednesday 6 to 8pm within its radius. Disclosed on the card, capped at one per session, and it can never win the vote by weighting. It is an added candidate, and the group votes it up or down.
2. **Consumer subscription** for group history, the fairness ledger, and unlimited sessions. Small, but it is the honest "would you pay" test.
3. **Never** fight OpenTable and Resy for reservation commission. Hand the booking off to whatever rail the restaurant already uses and take nothing on it in v1.

**3.6 moat:** it is not the algorithm, it is the **longitudinal group ledger**. Google can compute a match score. Google cannot know that in this specific friend group Maya always concedes and Josh always steers Thai. That data only exists through repeated sessions in your product, and it compounds.

---

# Round 4: attack the moat and the ethics

### The attack

**4.1 The fairness ledger is creepy and socially explosive.** "Maya always concedes" is a machine generated fact about a real person, displayed to her friends. You are inserting an algorithmic scorekeeper into a friendship. The likely outcome is not delight, it is someone getting called out and the group deleting the app.

**4.2 Paid restaurant insertion is precisely what destroyed trust in Yelp.** Your entire premise is "the crowd average is corrupted by incentives," and your business model is selling incentives into the recommendation.

**4.3 Condorcet over 8 cards from 4 voters is statistically thin.** With 4 voters and 8 alternatives, ties and cycles are the common case, not the edge case. You will constantly land in "here are two, you decide," which is the exact failure state you promised to eliminate.

**4.4 The candidate pool is the real product and you have not said where it comes from.** If the 8 cards are Google Places sorted by rating, you are a skin on Google's ranking and the aggregation math is decoration.

**4.5 Zero install participants means no notifications, no identity, no retention, and a device keyed profile that evaporates in a private tab.**

**4.6 You are now three products** (group decider, taste graph, restaurant demand marketplace) with hackathon time.

### The response

**4.1 is the sharpest criticism in all five rounds and it demands a design change, not a defense.** The ledger becomes **private by default and framed as credit, never as debt**:

- Never display "X always concedes." Only ever display *"this one's on Maya"* at the moment she **wins**. Positive, at the moment of payoff.
- The concession count is visible **only to the person it describes**. The group sees the outcome and a one line reason, nothing else.
- No leaderboards, no streaks, no percentages about people. **Numbers about places, never numbers about people.** That is a stated product principle, written into the design doc.
- The system's voice is a considerate friend, never a referee.

That converts the mechanic from surveillance into what it honestly is: **the app remembering the thing a good friend would remember.**

**4.2 conceded, with hard rules published publicly:**
- A paid candidate can enter the pool. It can never receive a weight, a boost, or a tiebreak.
- It is labeled on the card itself, not buried in settings.
- One per session maximum, and only in time windows the restaurant genuinely needs filled.
- **Priced on outcome (the group picked it), not on exposure.** This structurally aligns the incentive with actually being a good fit: a restaurant that keeps getting voted down sees its cost per win rise until it stops bidding. That is a self correcting quality mechanism and the exact inverse of impression based ad models.
- The rule set is published. Trust is the only asset here, and ambiguity kills the product.

**4.3 real problem, real fix.** Do not run Condorcet on 8 arbitrary cards:
1. Apply the group's **hard filters** first (dietary, distance, price band, open now, seats a 4 top). Set intersection, not scoring. This usually cuts a neighborhood to a handful.
2. Select the k=8 candidates to **maximize expected decisiveness plus information gain** given what is already known about the participants. Active learning: choose the ballot most likely to produce a clear winner *and* most informative for the taste model.
3. Add a **veto primitive** separate from ranking. One per person per session, absolute. Vetoes resolve most cycles instantly and map perfectly onto real behaviour ("not Thai again").
4. When there genuinely is no winner, report it honestly. *"Two way split, here is who is on each side"* is a useful output, not a failure.

**4.4 correct, and it is the most important unglamorous work in the build.** The candidate pool comes from a **constraint first index**, not a rating first one. The differentiating fields are the ones Google ranks badly on: current wait, whether it seats a 4 top at 7pm Thursday, whether it is too loud to hold a conversation, whether the vegetarian option is real or an afterthought. Sources: Google Places API for the base entity, hours, and geometry (licensed, not scraped), the restaurant's own site and menu, and, as the honest version of the source doc's foot traffic idea, **Google Places' own popular_times / current popularity signal rather than a five figure Placer.ai license.** Stated limitation: it is a coarse aggregate, it is a feature, it is not a moat.

**4.5 partially conceded.** Web participants get a device scoped profile plus a one tap "save your picks" upgrade **at the moment the session resolves**, which is peak payoff and the correct moment to ask. No notification dependency in v1, because the session lives in the group chat where the notification already happens. The retention loop is the **organizer**, not the participants. Participants convert by becoming organizers.

**4.6 fully conceded.** Scope discipline in Round 5.

---

# Round 5: attack execution, evidence, and honesty

### The attack

**5.1** Every claim above is a hypothesis. What is the cheapest experiment that could falsify the core one?
**5.2** Hackathon scale and company scale are being conflated. Judges see three minutes. The fairness ledger requires longitudinal data you will not have.
**5.3** "Everyone has this problem" is the single most common founder self deception. You have not validated that the pain is install worthy.
**5.4** The sponsor requirement (Merge, Corgi, Photon) has been quietly dropped.
**5.5** You are storing who eats with whom, where, and when, plus inferred religion (halal, kosher) and health (allergies). Under GDPR Article 9 that is special category data.
**5.6** What number says this is working, and what number kills it?

### The response

**5.1 The cheapest falsifying test: build nothing.**
Recruit 20 real friend groups. For their next dinner, run the decision by hand: a Google Form for constraints, eight candidate links, collect rankings, aggregate manually with ranked pairs, send back one pick with a stated reason. One weekend, no code.
Measure two things: (a) did they actually go to the pick, (b) did they ask you to run it again. If fewer than half come back, the frequency thesis is false and the whole design collapses. This is the correct order of operations and it costs a weekend instead of a quarter.

**5.2 Hackathon scope, separated from company scope.**

*The demo, 3 minutes:*
1. Organizer creates a live session on stage.
2. **QR code on the screen. Judges scan it and swipe on their own phones.** No install, no account.
3. The resolution appears live with a stated reason and the veto that resolved the cycle called out by name.

Judges participating **is** the demo. It proves zero install participation, the aggregation, and the stated reason in one shot.

For the fairness ledger, seed a demo group with six prior sessions and **label it as seeded demo data on screen**. Never present fabricated history as real usage.

*Cut from the hackathon build entirely:* taste twins, the paid candidate auction, subscriptions, the Takeout importer, the B2B surface, notifications.

**5.3 conceded.** Validation plan in the metrics table below. The demo is not evidence. 20 hand run sessions are evidence.

**5.4 Sponsor integration, honestly.**

- **Merge.** The honest surface is not restaurant data, it is the **B2B side**, and it is genuinely the best monetization in the whole design. A company connects its existing stack through Merge (HRIS for dietary and accommodation records already on file, file storage for expense and budget policy, CRM for client dinner context). Fourtop then plans **team dinners and client dinners that respect everyone's dietary needs without anyone having to announce them at the table.** That uses Merge's flagship category, it is genuinely humane, and companies pay for software while consumers do not. Guardrail: HRIS dietary and medical records are exactly the Article 9 category, so this is explicitly consent gated, applied only as an anonymous filter, and never surfaced per person.
- **Photon.** **I could not verify what Photon is** from public sources. Build the notification and realtime layer behind an interface so the provider is swappable, and confirm the actual API before committing. If it is a push provider, it drives "session resolved" and "session closes in 5 minutes."
- **Corgi.** Also unverified, most likely the hackathon host rather than an integration target. Confirm before relying on it.

**5.5 Privacy design, written as constraints:**
- Dietary constraints are stored as **filters on a session**, never as attributes on a person visible to others. The group sees "3 hard constraints applied," never whose.
- Location is **session scoped**: a radius the organizer chooses. No background location, ever, under any circumstance.
- The social graph is derived from sessions, never exported, never sold.
- Article 9 data (religion via halal/kosher, health via allergy) is explicit consent only, never used for advertising, and never enters the paid candidate auction. The auction matches on session level constraints only, and the restaurant never receives group identity or constraints. The auction is strictly one way.
- Retention: raw swipes 24 months, derived preference vector until account deletion, deletion removes both.

**5.6 Metrics, with kill criteria:**

| Metric | Target | Kill threshold |
|---|---|---|
| **North star:** resolved sessions per organizer per month | 4+ | below 1.5 |
| Group repeat rate within 30 days | 40%+ | **below 20% after 100 groups kills the thesis** |
| Participant to organizer conversion in 30 days | 15%+ | below 8% means no viral loop |
| Sessions resolving to a single pick without manual override | 70%+ | below 50% means the aggregation is not working |
| Post meal "was that right?" yes rate **from the person whose top pick lost** | 80%+ | below 60% means minimax regret is failing |
| Organizer first session completed within 10 min of install | 60%+ | below 35% is an activation problem |

The fifth row is the one that actually tests the thesis. Anyone can satisfy the winner. The product is only real if the person who lost the vote still says it was the right call.

---

# The design, consolidated

## Name

**Fourtop.** It is real restaurant industry jargon for a table of four. It signals group and food simultaneously, it sounds like an insider term rather than an AI product, and it carries no "smart" or "AI" prefix. Alternative if you want the algorithm forward framing: **Quorum**.

## One line

> Fourtop settles where your group is eating, in about ninety seconds, and remembers who compromised last time.

## Positioning against the alternatives

| Alternative | What it does | What it fails at |
|---|---|---|
| The group chat | Free, already installed, everyone is there | No resolution mechanism. Loudest or most stubbornly patient person wins |
| Google Maps | Enormous data, personalized match score | Single player. Cannot resolve four people |
| Beli | Social ranking, taste profiles, friend feed | Single player logging and status. Its "friend rating" is an average, which is the wrong primitive for a decision |
| OpenTable / Resy | Booking the table | Only useful after the decision is made |

Fourtop is the only thing that operates on **the decision itself, between multiple people, in real time**.

## The one sentence that carries the whole product

**Numbers about places, never numbers about people.**

## Architecture of the recommendation model

**Preference space.** Roughly 24 **interpretable** axes (spice tolerance, novelty appetite, price sensitivity, noise tolerance, formality, richness, cuisine affinities). Interpretable on purpose, because the UI has to state a reason and a 256 dimension embedding cannot.

- User vector `θ_u`. Venue vector `φ_v` in the same space, extracted from menu text and review text by an LLM, not from star ratings. This is the genuine "connect any data to any LLM" move.
- Predicted utility `u(u,v) = θ_u · φ_v + b_v + geo + price + constraint terms`.
- Swipes are **pairwise comparisons**, fit with Bradley-Terry logistic regression on venue vector differences. Pairwise data is far more robust than star ratings and it is what you actually collect.
- Cold start: population prior plus the organizer's first eight swipes. Usable immediately because the space is low dimensional and interpretable.
- Taste twins (act two): cosine over `θ`, reported **only** when two users share enough high entropy co-rated items. Otherwise show no number at all. Never fake precision like "87%."

## Aggregation pipeline

```
1. HARD FILTER      constraints -> candidate set C          (set intersection, not scoring)
2. BALLOT SELECT    pick k=8 from C maximizing
                    expected decisiveness + information gain (active learning)
3. COLLECT          swipe order = partial ranking, plus <=1 absolute veto per person
4. PRUNE            drop every vetoed item
5. CONDORCET        winner beats all alternatives pairwise? -> done
6. RANKED PAIRS     no Condorcet winner -> Tideman resolution
7. MINIMAX REGRET   among statistical ties, pick the option minimizing
                    the worst individual's rank loss
8. FAIRNESS LEDGER  final tiebreak ONLY, never a weight on the vote
9. STATE THE REASON one sentence, naming the mechanism that decided it
```

Step 8 being a tiebreak rather than a weight is deliberate and load bearing. The moment the ledger can override the vote, the product is a manipulation engine rather than a decision aid.

## Data model sketch

```
users            id, handle, created_at, is_organizer
devices          id, user_id?, fingerprint, first_seen        -- zero install participants
groups           id, name, created_by
group_members    group_id, user_id, joined_at
sessions         id, group_id, organizer_id, window_start, radius_m,
                 center_geog, price_band, party_size, status
constraints      session_id, kind, value                      -- unattributed by design
venues           id, gplace_id, name, geog, price_band, hours,
                 seats_4top, noise_level, phi vector(24)
ballots          session_id, device_id, venue_id, rank, vetoed
resolutions      session_id, venue_id, method, reason_text, decided_at
concessions      session_id, user_id, regret_score            -- PRIVATE to that user
prefs            user_id, theta vector(24), n_comparisons, updated_at
```

Postgres with pgvector on Supabase. RLS is not optional here: the `concessions` table must be readable only by its own subject, enforced at the database, not the application.

## Stack

Next.js App Router on Vercel, Supabase (Postgres + pgvector + RLS + Auth), Google Places API for the venue index, an LLM pass for venue vector extraction, ranked pairs and Bradley-Terry implemented directly (both are under 100 lines and neither needs a library).

## 72 hour build order

| Hours | Build | Done when |
|---|---|---|
| 0 to 6 | Venue index for one neighborhood, ~300 venues, Places API plus LLM extraction of `φ` | 300 venues with populated vectors and hard constraint fields |
| 6 to 14 | Session creation, shareable link, zero install swipe web view | A phone that has never seen the app can swipe via link |
| 14 to 24 | Ranked pairs + minimax regret + veto handling, with unit tests on synthetic ballots | Known cycle cases resolve correctly |
| 24 to 32 | Resolution screen with generated stated reason | Reason names the actual deciding mechanism, not a template |
| 32 to 42 | Bradley-Terry fit, `θ` updates on every session | Second session ballots are visibly better targeted than the first |
| 42 to 52 | Fairness ledger, private concessions, credit framing only | The subject sees their own count; the group sees only the outcome line |
| 52 to 62 | Seeded demo group, QR flow, live judge participation path | Four cold phones complete a session in under 90 seconds |
| 62 to 72 | Polish, failure states, the honest "no winner" screen, rehearse | Demo runs three times clean, including on hostile wifi |

## What was kept from the original document

- The thesis that trust in a recommendation comes from **demonstrated taste overlap**, not from a crowd average. Kept and strengthened with the literature.
- "Make it feel human." Kept, and it is now the fairness ledger and the stated reason, rather than a chat box.
- Taste twins. Kept, moved to act two, powered by data act one generates.
- Foot traffic. Kept, downgraded to a constraint (will there be a 45 minute wait), sourced from Google popular_times rather than a licensed dataset.

## What was cut, and why

| Cut | Reason |
|---|---|
| Anonymous stranger chat | Secret and Yik Yak. Grooming vector, moderation cost, App Store risk |
| Stranger meetups | Same, worse |
| Yelp scraping | ToS breach exposure survives hiQ and Bright Data; Yelp can kill it with a WAF rule |
| Bot review detection as a product | Worse than Yelp's own filter, on a subset of Yelp's data |
| "87% taste match" headline | Google shipped it in 2018, free, better backed |
| Per city launch | Cold start with no liquidity mechanism |
| Merge for restaurant scraping | Merge has no consumer or venue connectors and is not a scraper |

## The three things most likely to kill this

1. **The frequency thesis is wrong.** Group meals happen, but the *decision* may not be painful enough to open an app for. This is why the 20 hand run sessions come before any code.
2. **iMessage and WhatsApp ship it.** Group polls plus place cards already exist in adjacent form. The defense is the ledger and the constraint index, neither of which a platform will bother building.
3. **The ledger reads as creepy despite the design work.** Round 4's fixes are a hypothesis, not a proof. Test the exact wording with real friend groups before shipping it, and be willing to cut it entirely, in which case the product is still a good decision utility, just without the moat.

---

## Sources

- [Comparing Recommendations Made by Online Systems and Friends, Sinha and Swearingen 2001](https://www.ercim.eu/publication/ws-proceedings/DelNoe02/RashmiSinha.pdf)
- [Trust Related Effects of Expertise and Similarity Cues in Human Generated Recommendations, Kunkel et al.](https://ceur-ws.org/Vol-2068/humanize5.pdf)
- [Beli, Snapshots teardown](https://www.readsnapshots.com/p/beli-food-for-thought) and [Beli company profile, Tracxn](https://tracxn.com/d/companies/beli/__dGog-htkIGO9dxx0slXqdOmKWXD_C9Gm8V6ij9YUamA)
- [How the Beli App Is Gamifying Our Restaurant Experiences, TODAY](https://www.today.com/food/trends/what-is-beli-app-rcna217748)
- [Ness Gets Social With Personalized Restaurant App, Forbes](https://www.forbes.com/sites/tomiogeron/2011/12/08/ness-gets-social-with-personalized-restaurant-app/) and [Ness adds group decisions, TechCrunch](https://techcrunch.com/2013/11/21/restaurant-recommendation-engine-ness-now-helps-groups-decide-where-to-eat-adds-support-for-web-android-users-too/)
- [Nara brings restaurant recommendations to 25 cities, TechCrunch](https://techcrunch.com/2012/11/14/nara-brings-its-restaurant-recommendation-service-to-ios-and-android-expands-to-25-cities/)
- [Google Maps "Your Match" personalized recommendations, TechCrunch](https://techcrunch.com/2018/06/26/the-new-google-maps-with-personalized-recommendations-is-now-live/)
- [Yelp Trust and Safety Report 2025](https://blog.yelp.com/news/2025-trust-and-safety-report/)
- [AI system spots fake reviews with 93% accuracy on Amazon, 91% on Yelp](https://techxplore.com/news/2026-05-ai-fake-accuracy-amazon-yelp.html)
- [Fake Review Detection: Classification and Analysis of Real and Pseudo Reviews (UIC)](https://www2.cs.uh.edu/~arjun/tr/UIC-CS-TR-yelp-spam.pdf)
- [Meta Platforms v Bright Data, Farella Braun + Martel](https://www.fbm.com/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data/) and [hiQ v LinkedIn analysis](https://www.fbm.com/publications/what-recent-rulings-in-hiq-v-linkedin-and-other-cases-say-about-the-legality-of-data-scraping/)
- [Why Yik Yak failed, Failory](https://www.failory.com/cemetery/yik-yak) and [Yik Yak shuts down, Rappler](https://www.rappler.com/technology/168547-yik-yak-app-shutdown/)
- [RELINE: POI recommendations and matrix sparsity](https://arxiv.org/pdf/1902.00773)
- [Merge alternatives and connector categories, Nango](https://nango.dev/blog/4-most-popular-merge-dev-alternatives/) and [Unified MCP vs Merge Agent Handler](https://unified.to/blog/unified_mcp_vs_merge_agent_handler_a_2026_comparison)
