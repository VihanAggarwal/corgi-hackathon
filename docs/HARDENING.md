# Find food through people who taste like you

**Hardening the core, not replacing it.**

Five rounds. Each round attacks the current version using prior art, academic literature, competitor behaviour, and startup history. Each response either fixes the design or concedes and cuts scope. The one thing that is never on the table is the core: **recommendations come from people whose taste demonstrably matches yours, not from a crowd average.** Everything else is negotiable.

---

## 0. The baseline (from the source doc)

> "Find food through people who taste like you."

Core flow as written:
1. User builds a profile from a few signals (cuisines, price, dining style, dietary constraints, neighborhood, vibe)
2. The app finds **taste twins** / **taste neighbors**
3. Recommendations come from those people, not from the crowd average
4. Follow-up questions through **anonymous, platform-mediated chat**
5. Mutual opt-in reveals identity or moves to a local group meet-up

What the doc says makes it unique:
- Not Yelp, not better search. A **social proof layer** for food discovery
- The similarity graph is the asset: "people who like what you like also liked this," "this came from someone whose taste matches yours 87%," "this person has consistently recommended places you liked"
- Old word-of-mouth, scaled with AI

Loose notes: foot traffic as a popularity signal, scrape Yelp to strip bot reviews, Merge for integrations and scraping, Photon for notifications.

Framing brief from the sponsor deck: *"Don't just wire up a workflow, use AI to make something that expresses, not just executes."*

---

# Round 1: does this have a right to exist?

### The attack

**1.1 Beli is already this, funded, and winning the demographic.** Beli (2021, NYC) does comparison based ranking, friend feeds, friend rating averages, and literally ships a screen called **Taste Profile**. $5.3M seed from Goodwater, ~46 people, 80% of users under 35, growth almost entirely by referral. The proposed flow is Beli's shipped product with one variable changed: strangers instead of friends.

**1.2 Google shipped the headline number eight years ago.** Maps "Your Match" gives a 0 to 100 personalized score per restaurant from your ratings, location history, and stated preferences. So "matches your taste 87%" is a commodity UI element, free, on the largest distribution surface in existence, backed by more behavioural data than any startup will assemble.

**1.3 This exact company already ran and returned nothing.** Ness Computing (2011) built personalized restaurant recommendations from people with similar tastes. Sold to OpenTable for ~$17.3M after raising ~$15M. That is a wash. Nara ran a taste graph across 25 cities and is gone. Foursquare had the best taste graph ever assembled and abandoned consumer discovery to sell location data B2B. Three serious attempts, zero survivors.

**1.4 The similarity math does not work at this data density.** POI matrices run 99%+ sparse. NYC has ~25,000 restaurants. An enthusiastic user logs maybe 60 a year. Expected overlap between two random users is `60 x 60 / 25,000 = 0.14 restaurants`. You cannot compute taste similarity from an intersection of zero. Any system reporting "87%" on that data is silently computing content similarity (cuisine tag, price band, neighborhood), which is what Google already does, free, better.

**1.5 Anonymous stranger chat plus meetups is a liability, not a feature.** Secret hit a ~$100M valuation and shut down in 2015 over harassment. Yik Yak shut down in 2017 after bomb threats caused school evacuations. Anonymity plus strangers plus a built in path to meeting in person is the exact configuration that ends products. It is a grooming vector. It is the part that gets you removed from the App Store, not the part that gets you users.

**1.6 Scraping Yelp to strip bot reviews is bad on three axes.** *Legal:* hiQ and the 2024 Meta v Bright Data ruling protect logged out public scraping from CFAA liability, but breach of contract and state tort claims survive, and Yelp's ToS forbids scraping. *Competitive:* Yelp already removes ~5% of reviews and flags another ~18% as not recommended, using behavioural telemetry you cannot see. *Technical:* the best published detectors hit ~91% on curated Yelp benchmarks and fall toward ~68% on real world data. You would ship a measurably worse copy of Yelp's own filter, on a subset of Yelp's data, killable by one WAF rule.

**1.7 Merge cannot do what the notes say.** Merge covers HRIS, ATS, CRM, accounting, ticketing, file storage, knowledge base. It is B2B SaaS infrastructure. No Yelp connector, no Maps connector, no consumer connector, and it is not a scraper. "Merge for integrations + scraping" is not implementable as written.

**1.8 Per city cold start, forever.** A twin graph needs many users *in your city* with *overlapping* logged venues. Every new city restarts at zero liquidity.

**1.9 No monetization survives contact.** Reservation commission belongs to OpenTable and Resy. Delivery affiliate belongs to DoorDash and Uber. Promoted listings need scale you do not have.

**1.10 Frequency is the silent killer.** How often does a person genuinely need a *new restaurant*? One to three times a month for most people. That is below the retention floor for a standalone app. Beli survives on a different loop: it is a logging and status app, and discovery is the pretext, not the habit. Taste twins as specified have no habit at all.

### The response

**Kill list, no negotiation:**
- Anonymous stranger chat. Deleted, not mitigated.
- Stranger meetups. Deleted.
- Yelp scraping as the data spine. Deleted.
- Bot review detection as a product. Deleted.
- "87% taste match" as a displayed number. Deleted.
- "This person has consistently recommended places you liked" as displayed text. Deleted (kept as an internal weight, see Round 4).

**The core survives, and the literature actually supports it better than the source doc knew.**

1. **Sinha and Swearingen (2001), "Comparing Recommendations Made by Online Systems and Friends":** friends produced *better* recommendations than six commercial recommenders. But friends mostly **reminded** users of things they already knew, while systems surfaced items that were **new and unexpected**.

2. **Kunkel et al., "Trust Related Effects of Expertise and Similarity Cues in Human Generated Recommendations":** in human sourced recommendations, **profile similarity and rating overlap significantly influenced choice, while familiarity with the recommender did not.**

Read together:

> **Trust comes from demonstrated taste overlap. Novelty comes from strangers. Friendship supplies neither.**
> The ideal recommender is a stranger with proven overlap. Beli (friends, novelty poor) and Google (algorithm, trust poor) both structurally fail at this.

That is the source doc's thesis, and it is correct. The mechanism has to change.

**The one change that fixes 1.1, 1.2, 1.4, and 1.10 simultaneously: the unit is the dish, not the restaurant.**

This is not a pivot. It is a *literal reading* of the core. The doc says "find **food** through people who taste like you," not "find restaurants." Restaurants were an assumption inherited from Yelp.

What changes when the unit is the dish:

| Problem | Why the dish unit fixes it |
|---|---|
| **1.10 frequency** | You choose a restaurant 1 to 3 times a month. You choose a **dish** every single time you eat out, including at places you already know. The decision fires 5x to 10x more often, and it fires at familiar venues where discovery apps are useless |
| **1.1 Beli** | Beli ranks restaurants you visited. It has no dish layer, no dish data, and its primitive (a venue score) cannot express "the lamb here is exceptional and everything else is fine" |
| **1.2 Google** | Your Match scores venues. Google has no dish level ground truth at scale and no mechanism to collect it, because nobody rates dishes on Maps |
| **1.3 why now** | Ness and Nara would have needed manual dish tagging across every menu in a city. LLM menu extraction makes a structured dish corpus buildable at near zero marginal cost. This is genuinely new since 2013 and it is the honest "why now" |
| **1.4 sparsity** | Solved separately and completely below. This is the important one |

**Fix 1.4 properly: never model item identity. Model attributes.**

The sparsity argument is correct and unanswerable *if* similarity is computed from co-visitation. So do not compute it from co-visitation.

- Every dish is projected into a fixed, interpretable **~24 axis attribute space**: heat, acid, fat, salt, sweetness, umami depth, texture contrast, richness, funk/ferment, char, herb forward, portion format, protein, technique, novelty of preparation, price per satiety, and so on. Extraction is an LLM pass over menu text plus dish description, not star ratings.
- Every user is a vector `θ_u` in **the same space**, fit from pairwise comparisons.
- Similarity between two users is cosine over `θ`, which requires **no overlapping items at all**. Two people who have never eaten in the same city can be twins.

This dissolves the sparsity problem rather than mitigating it. The 99% sparse matrix is never constructed. The dimensionality is 24, not 25,000, and it is dense by construction.

**Fix 1.8 (cold start): the content model works at n=1.** Because the model is content based in a low dimensional interpretable space, a single user with a fitted `θ` gets useful recommendations on day one with zero other users in the system. Twins are an **upgrade that turns on at a data threshold**, not a precondition. Launch by dish density in one neighborhood and one price band, not by city.

**Fix 1.5 (safety): no stranger to stranger channel exists in v1, at all.** The "human" in the brief is delivered by attribution and reasoning, not by a chat box. Developed in Round 3.

**Fix 1.6:** the bot review problem stops being your problem the moment you never ingest crowd reviews. Your signal is your own users' forced comparisons.

**Fix 1.9 (money):** dish level intent is worth more than venue level intent, and it generates a B2B asset nobody currently has. Developed in Round 4.

**Fix 1.7 (Merge):** honest answer in Round 5.

---

# Round 2: attack the dish unit

### The attack

**2.1 A structured dish corpus does not exist anywhere.** Menus are PDFs, images, Squarespace pages, Instagram posts, and chalkboards. They change weekly. Specials are not published. You are proposing to build the hardest data asset in local commerce as a side effect.

**2.2 Dish sparsity is an order of magnitude worse than venue sparsity.** 25,000 NYC restaurants times ~40 dishes each is a million items. If co-visitation was hopeless at 25,000, co-ordering is absurd at 1,000,000.

**2.3 Users will not log dishes.** Photo logging is work. Beli's logging succeeds because it is tied to status and ranking. Yours is data entry with no payoff.

**2.4 The 90 second calibration is a wall in front of an app nobody agreed to want.** Fifteen screens before any value is a conversion disaster.

**2.5 Weighting similarity by disagreement selects for contrarians.** If informative items are the divisive ones, your twins are systematically the people with unusual opinions, and your recommendations become weird rather than good.

**2.6 "87%" is dead but the disease is not.** Any similarity display invites false precision, and the first thing a user does is check whether the number is believable.

**2.7 LLM menu extraction hallucinates.** A dish vector that says a dish is spicy when it is not poisons the model, and you have no ground truth to catch it.

### The response

**2.2 is answered by 1.4 and does not survive.** Item co-occurrence is never computed. Similarity is cosine over `θ` in 24 dimensions. A million dishes is not a sparsity problem, it is a *coverage* problem, which is a different and much more tractable thing.

**2.3 and 2.4 have the same answer: the elicitation is the product, and it is a game.**

The main surface is a **duel feed**. Two dishes, side by side, photo and one line. Pick one. Repeat. It is fast, it is genuinely enjoyable, it works on a train, and it requires no restaurant to be nearby and no meal to be happening.

- Every duel is a Bradley-Terry pairwise observation on `φ_a - φ_b`. Pairwise data is far more robust than star ratings, and it is what you can actually collect.
- Duels are **actively selected** to maximize information gain about `θ_u` given the current posterior. Early duels are diagnostic. Later duels drift toward local, orderable dishes and become recommendations in disguise.
- There is **no onboarding questionnaire**. There is no "step 1 of 15." The first duel is the first screen, and a usable `θ` exists after roughly 12 duels, which is under 90 seconds, but the user is never told they are being onboarded.
- Logging what you actually ate is **optional and never required**. It improves the model and it powers notes (Round 3), but the duel feed alone is sufficient to fit `θ`.

This is the same trick that makes Beli work (the preference work is a byproduct of something the user wanted to do anyway), applied to a surface that fires daily rather than monthly.

**2.5 conceded and fixed with a three part estimator.**

Naive entropy weighting does select contrarians. The fix:

1. **Informativeness weighting with a consensus floor.** Weight a shared judgement by the population entropy on that comparison, but discard comparisons where population agreement exceeds 85% (uninformative) *and* those below 55% (noise, not taste).
2. **Shrinkage toward the population prior.** `θ_u` is regularized toward the population mean with strength inversely proportional to `n_comparisons`. A user with 12 duels is mostly prior. A user with 400 is mostly themselves. This prevents early users from being assigned exotic twins on noise.
3. **A twin must be predictive, not just similar.** A candidate twin's influence weight is `cosine(θ_u, θ_v) x reliability_v`, where `reliability_v` is that user's out of sample hit rate on other users with similar `θ`. Contrarians who are *right* survive. Contrarians who are noisy are down-weighted to nothing.

**2.6 conceded as a display rule.** Never show a similarity percentage. Ever. Similarity is expressed **in the language of the axes that drove it**, which is possible because the space is interpretable on purpose:

> *"From people who, like you, want more acid and less sugar than most."*

That is more informative than "87%", it is honest about what the model actually knows, and it cannot be falsified by a user who does not recognize the number.

**2.7 real, and handled by confidence gating rather than by pretending it is solved.**

- Extraction returns a vector **plus a per axis confidence**. Low confidence axes are masked, not guessed.
- A curated **diagnostic pool** of ~200 dishes per launch neighborhood is verified by hand. Two hundred items is one afternoon. Duels used for calibration are drawn *only* from the verified pool, so model fitting never runs on hallucinated attributes.
- The unverified long tail is used for **recommendation** but never for **calibration**, and errors there are corrected by user feedback rather than propagated into `θ`.
- Menu drift is handled by re-extraction on a schedule plus a user facing "this isn't on the menu" one tap report.

**2.1 conceded as the real work.** The corpus is the unglamorous core of the company and it should be scoped honestly: one neighborhood, ~300 venues, ~8,000 dishes for v1. Sources are Google Places API for the entity, hours, and geometry (licensed, not scraped), the restaurant's own site and menu, and first party user logs. Foot traffic from the source doc survives here, demoted to a constraint (is there a 45 minute wait) and sourced from Places `popular_times` rather than a five figure Placer.ai license. Stated limitation: it is a coarse aggregate, it is a feature, it is not a moat.

---

# Round 3: attack the twin mechanism and the "human" layer

### The attack

**3.1 If the content model works, the twins are decoration.** You just argued `θ` plus `φ` produces good recommendations at n=1. So what do twins add that the content model does not already have? If the answer is "nothing measurable," the entire premise of the product is ornamental.

**3.2 Twins lower the hit rate.** Novelty and accuracy trade off. Users punish a bad recommendation far harder than they reward a surprising one. A twin sourced pick that misses costs you more trust than the content model's safe pick earns.

**3.3 You deleted chat, so where is the human?** The brief was "make it feel human." A cosine similarity with a nicely worded label is not human. It is a recommender with better copywriting.

**3.4 Twins do not exist until you have users, and the app is least impressive exactly when you are pitching it.**

**3.5 If you bring back any user generated text, you have rebuilt Yelp with less data.** A note about a dish is a review. You spent Round 1 arguing reviews are corrupted.

### The response

**3.1 is the sharpest criticism in the document and it deserves a precise answer, not a defense.**

Content model and twins do measurably different jobs, and the design should state which is which **in the UI**:

- **The content model sets the accuracy floor.** It answers "what will this specific person reliably enjoy." It is safe, it is dense, it works cold, and it is boring by construction, because it can only recommend things that resemble what it already knows you like.
- **Twins supply what the content model structurally cannot: items whose appeal is not predictable from their attributes.** The dish that is better than it sounds. The unpromising looking thing at the bad looking place. Attribute vectors cannot represent execution quality, and execution is most of what makes food good. A twin is the only mechanism that transmits "this specific kitchen does this specific thing unusually well."

That is the honest division of labor, and it maps exactly onto Sinha and Swearingen: systems surface the unexpected, humans supply the trusted. Here the human supplies both, because the human is selected *by* demonstrated overlap.

**3.2 conceded, and handled by an explicit, labeled exploration budget.**

- A results set is a fixed mix: roughly 70% model sourced, 30% twin sourced, and **each card says which it is**.
- Twin cards are framed as stretches, not as certainties: *"a stretch, from people who share your palate."* A labeled miss costs almost nothing. An unlabeled miss costs trust.
- The mix is a user visible dial (Safe / Balanced / Adventurous). Letting the user choose their own novelty tolerance is both better product and a clean way to measure the tradeoff empirically.

**3.3 The human feel comes from three things, none of which is a chat box.**

1. **Attribution by taste, not by identity.** *"Ordered by people who, like you, think most ramen is oversalted."* That sentence is only possible because the space is interpretable, and it does the psychological work that "87% match" was trying to do, honestly.
2. **Notes.** One line, written by a user about a dish they logged. Attached to the **dish**, never to a profile. No identity, no username, no avatar, no reply channel, no thread. Surfaced to you only if the author is in your twin set.
3. **The stated reason.** Every recommendation names the mechanism that produced it, in one sentence. No black box, ever.

**3.5 answered directly: a note and a review are the same text carrying completely different information.** A Yelp review is from a stranger whose taste is unknown, aggregated into a mean that no individual holds. A note is from someone whose *disagreement pattern* matches yours on the comparisons that actually separate people. The filtering, not the writing, is the product. This is precisely the source doc's "social proof layer" claim, and it holds.

Constraints that keep notes from becoming Yelp:
- One line, capped at ~140 characters, prompted ("what should someone order it with?" / "what surprised you?")
- Only writable about a dish you logged
- Never rankable, never scored, never upvoted. No karma, no reputation display
- Never shown to non twins

**3.4 conceded and sequenced.** Twins are **off by default** and turn on per user at a hard threshold (see Round 5 metrics). Below threshold, the UI says nothing about twins and shows no twin cards. The product is honest and useful as a pure content recommender on day one, and it gets better rather than starting broken. For the demo, this is solved by making the judges themselves the twin population (Round 5).

---

# Round 4: attack safety, privacy, and trust

### The attack

**4.1 Notes are a harassment and spam vector.** Free text from strangers, distributed by an algorithm, is the thing every platform regrets shipping.

**4.2 The taste profile leaks special category data.** Halal and kosher constraints reveal religion. Allergy constraints reveal health. Under GDPR Article 9 that is special category data, and you are proposing to use it for matching.

**4.3 Twin matching can de-anonymize.** In a small launch geography, a sufficiently distinctive `θ` plus a handful of logged dishes identifies a person. "People like you ordered this" with a twin set of two is a person, not a population.

**4.4 The source doc explicitly wanted "this person has consistently recommended places you liked."** That is a reputation score about a human being, generated by a machine, shown to strangers. You are building a rating system for people.

**4.5 The B2B menu intelligence business is a direct conflict of interest.** You will be selling restaurants insight derived from a system that also decides what those restaurants' customers see. That is Yelp's original sin.

**4.6 You are now three products again** (consumer recommender, dish corpus, B2B analytics) on hackathon time.

### The response

**4.1 conceded, with hard constraints:**
- No free text until a user has logged N verified dishes and completed the duel threshold. New accounts cannot write.
- Prompted, capped, single line, about a dish, never about a person or a venue's staff.
- No reply channel exists anywhere in the product. There is no path from reading a note to contacting its author. This is architectural, not a setting.
- Automated classification pass on submission, plus one tap report. Two reports auto-hides pending review.
- Notes are the **last** thing shipped, not the first, and the product is complete without them.

**4.2 conceded, with a firm rule: dietary constraints are filters, never features.**
- Stored as hard filters applied to the candidate set. Set intersection, not scoring.
- **Never used in similarity computation.** `θ` is fit on flavor and format preference only. Two people are not twins because they are both kosher.
- Never displayed, never exported, never entering any B2B surface, never used for advertising, explicit consent only.
- The group or public surface only ever shows that a filter was applied, never which one or whose.

**4.3 real, and fixed with a k-anonymity floor.**
- No twin sourced item is surfaced unless at least **k = 5** distinct twins support it.
- Never name, link, or identify an individual twin. There is no twin profile page. There is no "your twins" list.
- Notes are shown without any authorship handle, and only when the k floor is met on the underlying signal.

**4.4 This is the one place the source doc has to be overruled, and the principle is worth stating as the product's spine:**

> **Numbers about places, never numbers about people.**

Recommender reliability is computed, because 2.5 needs it, and it is used as an internal weight. It is **never displayed**, never exposed to the user it describes, and never aggregated into anything a person could be ranked by. The moment a user can see their own or anyone else's reliability score, the product becomes a status game and the honest signal dies.

**4.5 conceded, and the firewall is published:**
- What is sold: **aggregate, anonymized, threshold gated dish level performance.** "Your short rib loses 71% of head to head duels against comparable dishes within one mile, and the losses concentrate among people who want more acid." No restaurant has ever been able to buy that, and it is genuinely valuable.
- What is **never** sold and never buyable: ranking, boosts, weights, tiebreaks, customer identity, twin sets, constraints, or targeting.
- If paid placement ever ships, the rules are published in advance: labeled on the card, one per session maximum, priced on outcome (the user ordered it) rather than exposure, and structurally incapable of receiving a weight. A restaurant that keeps getting passed over sees its cost per conversion rise until it stops bidding. That is self correcting, and it is the inverse of impression based advertising.
- v1 sells nothing. Trust is the only asset the product has.

**4.6 conceded.** Scope discipline in Round 5.

---

# Round 5: attack execution, evidence, and honesty

### The attack

**5.1** Every claim above is a hypothesis. What is the cheapest experiment that could falsify the central one?
**5.2** Hackathon scale and company scale are being conflated. Judges see three minutes, and twins require a user base you will not have.
**5.3** "Everyone has this problem" is the most common founder self deception. Nothing here is validated.
**5.4** The sponsor requirements (Merge, Corgi, Photon) have quietly disappeared.
**5.5** What number says this is working, and what number kills it?

### The response

**5.1 The falsifying test, and it requires no code.**

The central claim is: *a taste matched stranger beats a content model at recommending food you will actually enjoy.* If that is false, everything above is elaborate decoration.

The weekend test:
1. Recruit 30 people. Build a 40 dish diagnostic pool by hand from one neighborhood.
2. Each person runs 20 duels in a Google Form. Fit `θ` in a spreadsheet (Bradley-Terry on 24 axes with 30 users is a laptop job).
3. For each person, generate **three content model picks** and **three twin sourced picks**, shuffled, unlabeled.
4. They go eat. They rate each dish they tried, and separately answer "would you have found this yourself?"

Kill condition: if twin sourced picks do not beat content picks on satisfaction *among items rated as unexpected*, the premise is dead. Cost: one weekend, zero engineering. This is the correct order of operations.

**5.2 Hackathon scope, separated from company scope.**

*The three minute demo:*
1. **QR code on screen. Judges scan it and run 12 duels on their own phones.** No install, no account.
2. Their `θ` appears live, expressed in words, not numbers: *"you want acid and heat, you are indifferent to richness, you avoid sweet."*
3. The room becomes the twin population. Show, live, which judge is which judge's taste twin, and what that twin's picks are for the judge who has not seen them yet.
4. One dish card resolves with a stated reason naming the mechanism.

Judges participating **is** the demo. It proves elicitation speed, the interpretable space, twin formation, and the stated reason in one shot, and it solves 3.4 by manufacturing a twin population in ninety seconds.

Seeded corpus data is labeled as seeded on screen. Never present fabricated history as real usage.

*Cut from the hackathon build entirely:* notes, photo logging, the B2B surface, subscriptions, paid placement, notifications, any importer, anything with a reply channel.

**5.3 conceded.** The demo is not evidence. The 30 person test is evidence, and it happens before the codebase grows.

**5.4 Sponsors, honestly.**

- **Merge.** There is no consumer or venue connector and it is not a scraper, so the source doc's use is not implementable. The honest surface is **B2B, and it is genuinely the best monetization in the design**: a company connects its stack (HRIS for dietary and accommodation records already on file, file storage for budget policy, CRM for client context), and the product plans team and client dinners that respect everyone's constraints **without anyone having to announce them at the table.** That uses Merge's flagship categories, it is humane rather than gimmicky, and companies pay for software while consumers do not. Guardrail: HRIS dietary and medical records are exactly the Article 9 category from 4.2, so it is explicitly consent gated, applied only as an anonymous filter, and never surfaced per person. **Act two, not hackathon scope.**
- **Photon.** I could not verify what Photon is from public sources. Build the realtime and notification layer behind an interface so the provider is swappable, and confirm the actual API before committing. If it is a push provider, it drives "your twin found something near you."
- **Corgi.** Also unverified, most likely the hackathon host rather than an integration target. Confirm before relying on it.

**5.5 Metrics with kill criteria.**

| Metric | Target | Kill threshold |
|---|---|---|
| **North star:** duels completed per weekly active user | 40+ | below 15 means the feed is not a habit |
| Twin sourced pick satisfaction minus content pick satisfaction, on items rated unexpected | +0.5 on a 5 point scale | **at or below 0 kills the entire premise** |
| Week 4 retention | 25%+ | below 10% and it is a toy |
| Duels to a stable `θ` (posterior variance below threshold) | under 15 | above 30 means calibration is too slow to survive onboarding |
| Recommendation acted on (ordered or saved) | 20%+ | below 8% means the model is not useful |
| Menu extraction per axis accuracy against the hand verified pool | 90%+ | below 75% means the corpus poisons the model |
| Notes reported per 1,000 shown | under 5 | above 20 means notes ship never |

The second row is the only one that matters. Everything else measures whether the product works. That row measures whether the *idea* is true.

---

# The design, consolidated

## Name

The core does not depend on the name, and it is the easiest thing to change. **Palate** is plain and searchable. **Doppel** is algorithm forward (taste doppelganger). **Mise** is restaurant jargon, which signals insider rather than AI product. No "smart" or "AI" prefix, in any case.

## One line

> Find food through people who taste like you. Not the crowd average, not your friends, and not a black box.

## Positioning

| Alternative | What it does | What it fails at |
|---|---|---|
| Yelp / Google reviews | Enormous coverage, crowd averages | The mean opinion is an opinion nobody holds. Venue level only |
| Google Maps "Your Match" | Personalized 0 to 100 venue score, free, huge data | Venue level, black box, no dish layer, no human provenance |
| Beli | Social ranking, taste profile, friend feed | Friends, so novelty poor (Sinha and Swearingen). Venue level. Averages friend ratings |
| Asking a friend | Trusted | Your friends do not share your palate, and they recommend what you already know |

This is the only product where the recommendation comes from **a specific stranger whose taste overlap with yours is demonstrated rather than assumed**, at the level of the actual food.

## The sentence that carries the product

**Numbers about places, never numbers about people.**

## Model architecture

**Preference space.** ~24 **interpretable** axes: heat, acid, fat, salt, sweetness, umami depth, funk/ferment, char, herb forward, texture contrast, richness, portion format, protein, technique, novelty of preparation, price per satiety, noise tolerance, service formality, and cuisine affinities. Interpretable on purpose, because the UI has to state a reason and a 256 dimension embedding cannot.

- Dish vector `φ_d`, extracted by an LLM from menu text, dish description, and photos, with **per axis confidence**. Low confidence axes are masked, never guessed. This is the honest version of "connect any data to any LLM."
- User vector `θ_u`, fit by **Bradley-Terry logistic regression on `φ_a - φ_b`** over observed duels. Pairwise data, not star ratings.
- Predicted utility `u(u,d) = θ_u · φ_d + b_d + venue_execution_d + geo + price`.
- Regularization: `θ_u` shrinks toward the population prior with strength inversely proportional to `n_comparisons`.
- Twin similarity: `cos(θ_u, θ_v)`, requiring **zero overlapping items**, gated on both users clearing a comparison count threshold.
- Twin influence weight: `cos(θ_u, θ_v) x reliability_v`, where reliability is out of sample hit rate. Never displayed.
- Similarity is **never** reported as a number. It is reported as the axes that drive it.

## Recommendation pipeline

```
1. HARD FILTER    dietary, distance, price, open now, availability
                  set intersection, never scoring. Constraints never enter theta

2. CONTENT SCORE  u(u,d) over the filtered candidate set
                  this alone is a complete, shippable product

3. TWIN SET       V = {v : cos(theta_u, theta_v) > tau and n_v > n_min}
                  if |V| < k_min, twins are OFF and the UI says nothing about them

4. TWIN SIGNAL    dishes with >= k=5 supporting twins, weighted by
                  cos x reliability, with informativeness weighting and a
                  consensus floor (discard >85% and <55% population agreement)

5. ASSEMBLE       ~70% content sourced, ~30% twin sourced, mix user adjustable
                  every card labeled with its source

6. STATE REASON   one sentence naming the actual mechanism, in the language
                  of the axes. Never a percentage. Never a template

7. NOTE ATTACH    if a twin wrote a note on this dish and k is met, attach it
                  no identity, no handle, no reply path
```

Step 3's gate is load bearing. A product that fakes twins before it has them is a product that teaches its earliest and most valuable users that it lies.

## Data model sketch

```
users          id, handle, created_at, notes_unlocked_at
devices        id, user_id?, fingerprint, first_seen      -- zero install duelling
venues         id, gplace_id, name, geog, price_band, hours, popular_times
dishes         id, venue_id, name, description, phi vector(24),
               phi_confidence vector(24), verified bool, last_extracted_at
duels          id, device_id, dish_a, dish_b, winner, context, created_at
logs           id, user_id, dish_id, rating, created_at
notes          id, user_id, dish_id, body, status, reported_count
prefs          user_id, theta vector(24), n_comparisons, posterior_var, updated_at
constraints    user_id, kind, value                       -- FILTERS ONLY, never in theta
reliability    user_id, score, updated_at                 -- INTERNAL, never rendered
```

Postgres with pgvector on Supabase. RLS is not optional: `constraints` and `reliability` must be unreadable by anyone but the system and, for constraints, their own subject. Enforced at the database, not the application.

## Stack

Next.js App Router on Vercel. Supabase (Postgres + pgvector + RLS + Auth). Google Places API for the venue index, licensed rather than scraped. An LLM pass for `φ` extraction. Bradley-Terry fit implemented directly (under 100 lines, no library needed).

## 72 hour build order

| Hours | Build | Done when |
|---|---|---|
| 0 to 8 | Venue and dish corpus for one neighborhood: ~300 venues, ~8,000 dishes, Places API plus LLM `φ` extraction with confidence | 8,000 dishes vectorized, 200 hand verified as the diagnostic pool |
| 8 to 16 | Duel feed, zero install via link or QR, device scoped profiles | A phone that has never seen the app can duel in under 5 seconds from scan |
| 16 to 26 | Bradley-Terry fit with shrinkage, active duel selection by information gain | `θ` stabilizes in under 15 duels on synthetic and real users |
| 26 to 34 | Interpretable profile screen: `θ` rendered as sentences, not numbers | A stranger reads their profile and says "that's actually right" |
| 34 to 44 | Twin computation, k floor, on/off gating, reliability weighting | Twins stay off below threshold and produce sane sets above it |
| 44 to 54 | Recommendation assembly, 70/30 mix, source labels, stated reasons | Reason names the real mechanism, never a template, never a percentage |
| 54 to 64 | Live demo path: QR, room as twin population, seeded corpus labeled as seeded | Four cold phones go scan to twin match in under 90 seconds |
| 64 to 72 | Polish, failure states, the honest "not enough data for twins yet" screen, rehearse | Demo runs three times clean, including on hostile conference wifi |

## Kept from the source doc

| Kept | How it survived |
|---|---|
| "Find food through people who taste like you" | Unchanged. It is the spine of the whole design |
| Taste twins and the similarity graph | Kept and made computable, by moving from co-visitation to a 24 axis interpretable preference space |
| Recommendations from people, not the crowd average | Kept, and it is now the measured claim that can kill the product |
| Social proof layer, word of mouth scaled | Kept, delivered by taste attributed provenance and notes rather than by chat |
| "Make it feel human" | Kept, relocated from a chat box to the stated reason and the taste attributed note |
| Foot traffic | Kept, downgraded to a wait time constraint, sourced from Places `popular_times` |
| Merge | Kept, moved to its only honest surface (B2B dining with dietary constraints from HRIS), act two |

## Cut, and why

| Cut | Reason |
|---|---|
| Anonymous stranger chat | Secret, Yik Yak. Grooming vector, moderation cost, App Store risk. No reply channel exists anywhere in the product |
| Stranger meetups | Same, worse |
| Yelp scraping | ToS exposure survives hiQ and Bright Data. Killable by one WAF rule |
| Bot review detection as a product | Worse than Yelp's own filter, on a subset of Yelp's data. Moot once you never ingest reviews |
| "87% taste match" | Google shipped it in 2018, free, better backed. Replaced by axis language |
| "This person consistently recommended places you liked" | A machine generated reputation score about a human. Kept as an internal weight, never rendered |
| Venue as the unit | Wrong frequency, wrong differentiation, and not what the core sentence actually says |
| Per city launch | Cold start with no liquidity mechanism. Launch by neighborhood dish density |

## The three things most likely to kill this

1. **Twins add nothing over the content model.** If a well fit 24 axis content model already gets the recommendation right, the human layer is ornamental and the product is a worse Google. This is why the 30 person test comes before the codebase, and why it is the one metric with a hard kill threshold.
2. **The corpus is harder than it looks.** Menus are chaos, extraction is imperfect, and dish level data has defeated better funded teams. The defense is a small verified diagnostic pool doing the model fitting, with the messy long tail confined to recommendation only.
3. **Nobody duels.** The whole habit thesis rests on the duel feed being fun enough to open unprompted. If it is not, calibration never completes, twins never form, and the product is a preference survey nobody finishes. Test the feed alone, with no recommendations attached, before believing it.

---

## Sources

- [Comparing Recommendations Made by Online Systems and Friends, Sinha and Swearingen 2001](https://www.ercim.eu/publication/ws-proceedings/DelNoe02/RashmiSinha.pdf)
- [Trust Related Effects of Expertise and Similarity Cues in Human Generated Recommendations, Kunkel et al.](https://ceur-ws.org/Vol-2068/humanize5.pdf)
- [Beli, Snapshots teardown](https://www.readsnapshots.com/p/beli-food-for-thought) and [Beli company profile, Tracxn](https://tracxn.com/d/companies/beli/__dGog-htkIGO9dxx0slXqdOmKWXD_C9Gm8V6ij9YUamA)
- [How the Beli App Is Gamifying Our Restaurant Experiences, TODAY](https://www.today.com/food/trends/what-is-beli-app-rcna217748)
- [Ness Gets Social With Personalized Restaurant App, Forbes](https://www.forbes.com/sites/tomiogeron/2011/12/08/ness-gets-social-with-personalized-restaurant-app/)
- [Nara brings restaurant recommendations to 25 cities, TechCrunch](https://techcrunch.com/2012/11/14/nara-brings-its-restaurant-recommendation-service-to-ios-and-android-expands-to-25-cities/)
- [Google Maps "Your Match" personalized recommendations, TechCrunch](https://techcrunch.com/2018/06/26/the-new-google-maps-with-personalized-recommendations-is-now-live/)
- [Yelp Trust and Safety Report 2025](https://blog.yelp.com/news/2025-trust-and-safety-report/)
- [AI system spots fake reviews with 93% accuracy on Amazon, 91% on Yelp](https://techxplore.com/news/2026-05-ai-fake-accuracy-amazon-yelp.html)
- [Fake Review Detection: Classification and Analysis of Real and Pseudo Reviews (UIC)](https://www2.cs.uh.edu/~arjun/tr/UIC-CS-TR-yelp-spam.pdf)
- [Meta Platforms v Bright Data, Farella Braun + Martel](https://www.fbm.com/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data/) and [hiQ v LinkedIn analysis](https://www.fbm.com/publications/what-recent-rulings-in-hiq-v-linkedin-and-other-cases-say-about-the-legality-of-data-scraping/)
- [Why Yik Yak failed, Failory](https://www.failory.com/cemetery/yik-yak) and [Yik Yak shuts down, Rappler](https://www.rappler.com/technology/168547-yik-yak-app-shutdown/)
- [RELINE: POI recommendations and matrix sparsity](https://arxiv.org/pdf/1902.00773)
- [Merge alternatives and connector categories, Nango](https://nango.dev/blog/4-most-popular-merge-dev-alternatives/)
