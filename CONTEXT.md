# Taste Twins: context

The short version, for when you do not want to read all of `/docs`.

---

## What it is

Dish-level food discovery. You play fast taste duels (two dishes, pick one),
which fit an interpretable 24-axis preference vector across things like heat,
acid, fat, funk, and texture. Once there is enough data, the system matches you
with **taste twins**: strangers whose preferences reliably predict yours. It
then recommends specific dishes with plain-language explanations, delivered in
a word-of-mouth voice through iMessage.

## What makes it not another recommender

**The objective is expansion, not prediction.** Every recommender since Netflix
maximizes predicted enjoyment. We maximize growth of the region of flavor space
a person enjoys, and we measure it. Recommendations score at the **boundary** of
your known region, not the centroid, so your palate grows one axis at a time
instead of getting handed something alien and called adventurous.

This also gives twins a job the content model provably cannot do. A content
model can only extrapolate inside what you already like. Expanding that region
requires evidence from outside your own history, which is precisely and only
what a taste twin provides.

## Why the sparsity problem does not apply

Every previous attempt at this (Ness, Nara, Foursquare) computed similarity
from co-visitation, which is hopeless: two random NYC users overlap on ~0.14
restaurants. We never build that matrix. Both users project into the same 24
interpretable axes, so **two people who have never eaten in the same city can be
twins**. Dimensionality is 24, not 25,000, and it is dense by construction.

## Why the unit is the dish

You pick a restaurant one to three times a month, which is below the retention
floor for an app. You pick a **dish** every single time you eat out, including
at places you already know. It also puts us where Beli and Google structurally
cannot follow: neither has dish-level ground truth, and neither has a mechanism
to collect it.

## Word of mouth, technically

A friend's recommendation beats a review because of provenance, specificity,
and calibration, none of which come from tone. So the anti-blast work happens
before the LLM sees anything:

- **Lift gate.** An item enters the twin channel only if twin support exceeds
  population support by a margin. If everyone likes it, it is a billboard.
- **Consensus ceiling / noise floor.** Items with >85% or <55% population
  agreement teach nothing about anyone and are excluded.
- **k >= 5 independent supporters.** Not five accounts from one restaurant.
- **Reliability weighting.** Similar but noisy contributes nothing.
- **Astroturf economics.** Influence is per taste cluster, not global. There is
  no broadcast, so manipulation costs are per person reached.

## The evidence packet

The LLM never queries the database and never decides anything. It receives a
structured `EvidencePacket` and renders it as speech. Any sentence in output
not grounded in a packet field is a bug, not a style issue. **The
personalization lives in the packet. The AI is what makes it sound like a
person told you.**

Target voice:

> Hunan Slurp, get the liang pi. Six people who share your thing about
> sweetness in savory food picked it over the noodles, which is not what the
> room does here, the room orders noodles. Two of them said it's colder than
> they expected, so probably not tonight if you're cold.

Dish first. Population named by what defines them. The contrarian move called
out. A real caveat. No enthusiasm markers, ever, because enthusiasm is the tell
of a blast recommendation.

## The stance on the agent

**It is not your friend and must never pretend to be.** It is the person who
knows a lot of people and pays attention. Credibility comes from citing real
judgments, not from performing warmth. Faking intimacy is the fastest way to
feel creepy and the fastest way to sound like an ad.

## Friends vs twins

Friends are the **acquisition channel**. Strangers are the **recommendation
source**. Inviting a friend does not make them a twin; it runs you both through
calibration and reports the truth, which is usually that you are not twins. The
disagreement is the shareable moment, and it is more interesting than agreement
would be.

This matters because your friends already eat what you eat, so they can barely
expand anything. Both supporting papers agree: similarity drives trust,
familiarity does not.

## What was deliberately cut, and why

| Cut | Reason |
|---|---|
| Anonymous stranger chat, meetups | Secret and Yik Yak. Grooming vector, moderation cost, App Store risk. No reply channel exists anywhere in this product |
| Yelp scraping | ToS exposure survives hiQ and Bright Data. Killable by one WAF rule |
| Bot review detection | Worse than Yelp's own filter on a subset of Yelp's data. Moot once you never ingest review scores |
| "87% taste match" | Google shipped it in 2018, free, better backed. We use axis language instead |
| Reputation scores about users | A machine-generated score about a human, shown to strangers. Computed internally, never rendered |

## Review data, in the only surviving form

Review **text** feeds attribute extraction (what a dish *is*). Review **scores**
never touch ranking (whether you should order it). "Much spicier than the menu
suggests" corrects a vector. This sidesteps bot detection entirely, because the
filter is "does this contain a checkable sensory claim", not "is this a real
person".

## The one rule that governs everything

**Numbers about places, never numbers about people.**

## The metric that can kill the idea

Twin-sourced expansion rate minus content-sourced expansion rate. The content
model cannot expand the region by construction, so if it ties with twins there,
either twins are decorative or the region is measured wrong. Testable in a
weekend with 30 people and a spreadsheet.
