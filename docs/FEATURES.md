# Round 6: the agent, the enterprise lane, and the part that is actually AI

**Addendum to HARDENING.md. The core is unchanged: find food through people who taste like you.**

---

## The gap this round closes

Everything in Rounds 1 through 5 is defensible and almost none of it is *personalized AI*. Bradley-Terry regression over a 24 axis space is machine learning from 1952. A judge watching that demo sees a recommender. The sponsor brief is explicit:

> "Don't just wire up a workflow, use AI to make something that expresses, not just executes."

So the split has to be stated plainly and then built:

- **The ML is the substrate.** `θ` and `φ` are how the system *knows* you. Nobody wants to look at them.
- **The LLM is the expression.** It reads a menu you photographed, reasons over your palate, writes the recommendation in your own terms, remembers what you said about last week's dish, and speaks to you in the app you already have open.

The demo should show almost none of the first thing and all of the second.

---

# Part A: Photon, and the reframe that comes with it

Photon is an iMessage agent. Treating it as a notification channel wastes it. **Photon is the primary interface, and the app is the secondary one.**

This is not a cosmetic decision. It fixes three of the hardest attacks in the document at once:

| Prior attack | How the agent answers it |
|---|---|
| **2.3** users will not log dishes | Logging becomes replying to a text. "how was the mapo" / "too oily" is the entire interaction |
| **2.4** onboarding is a wall | There is no install, no account, and no first run. The first duel arrives as a message |
| **1.10** frequency | The decision moment happens at the table with the menu in your hand, not at home in an app. That is where the agent lives |

## A1. Menu photo to order (the flagship)

You are sitting down. You photograph the menu. You send it.

> **You:** *[photo of a Sichuan menu]*
>
> **Agent:** Mapo tofu. It is the only thing here with the numbing heat you keep picking, and the rest of this menu skews sweet, which you have passed on eleven times running. If you are getting a second dish, dry fried green beans, not the honey walnut shrimp.

What is happening underneath: vision extraction of dish names and descriptions, on the fly `φ` estimation for a menu that is not in the corpus, ranking against `θ_u`, twin signal if the venue is known and the k floor is met, and an LLM writing the reason in the language of the axes that actually drove it.

This is the whole product in one message. It works at a venue you have never been to, in a city you have never visited, with no corpus coverage at all, because the model is attribute based rather than item based. It is also the single most demoable thing in the design.

## A2. The two hour follow up

> **Agent (2h later):** how was the mapo
>
> **You:** good but way too oily
>
> **Agent:** noted, pulling your fat tolerance down a notch. that also drops three places I was about to send you.

One reply, and it is a rated log, a `θ` update, and a visible consequence. The user sees the model change in response to something they said, which is the moment personalization stops being a claim and becomes an experience.

## A3. Duels as texts

Calibration does not need a feed at all. The agent sends two dishes, you reply with a number or a photo tap. Ten of these over a few days and `θ` is stable, with zero install and zero session.

## A4. "I'm here" and "find me something"

> **You:** at the place on Grand, what do I get
>
> **You:** find me lunch, 15 min walk, under $20

Location is passed per message, never in the background. This is the source doc's original discovery use case, delivered on the surface where it actually occurs to people.

## A5. The group thread, without building the group app

You add the agent to a friend group thread and tag it.

> **You:** @agent where are we eating
>
> **Agent:** Three of you have palates on file. Kalyan and I disagree about coriander but everyone here overlaps on heat and acid. Sichuan on Mott, or the Thai place if Priya is coming, her constraint rules out two of my other picks.

Note what it does not do: it never says whose constraint, it never routes a message from one person to another, and it only responds when tagged. It reads nothing ambiently. This gets the group use case as a feature of the taste graph rather than as a second product.

## A6. Travel palate passport

> **Agent:** you land in Lisbon tomorrow. your palate transfers cleanly, but almost nothing you normally order exists there. here are four dishes worth building a day around, and one I think you will hate that everyone recommends.

Attribute space means `θ` is city independent, so this works on day one in a market with no users, which is the exact thing that killed Nara.

## A7. Allergy question generator, not an allergy guarantee

If a user has a declared allergy constraint, a menu photo also returns **the questions to ask the server**, phrased and ready to read aloud. It never asserts that a dish is safe. Stated in the product and in the message itself. This is genuinely useful, it costs nothing, and the framing is the difference between a helpful feature and a liability.

---

# Part B: Merge, used honestly

Merge has no consumer connector and is not a scraper, so the source doc's use is not implementable. Its real categories (HRIS, file storage, CRM) support a B2B lane that is both the best monetization in the design and the most humane feature in it.

## B1. The dinner where nobody has to announce anything

A company connects its stack. HRIS already holds dietary and accommodation records. The agent plans a team dinner where every constraint is satisfied and **no one at the table had to say the word "celiac" out loud.**

That is the "make it feel human" brief answered better than any generative gimmick, and it is a real, recurring workplace indignity that software can just remove.

Guardrails, non negotiable and carried straight from Round 4.2:
- Constraints are applied as an anonymous filter on the candidate set. Never displayed, never attributed, never in `θ`.
- The organizer sees "four hard constraints applied," never which ones and never whose.
- Explicit consent per employee, revocable, and the record never leaves the filter path.

## B2. Budget policy as a live constraint

Pull the expense policy from connected file storage, let the LLM read it, and turn "per diem is $45 for team meals in NYC, $80 for client dinners" into a hard price filter the organizer never has to think about. This is literally "connect any data to any LLM" doing work rather than doing a demo.

## B3. Client dinner brief from CRM

The CRM notes say the client is vegetarian, mentioned a bad experience with a loud room, and is flying in from Osaka.

> **Agent:** Three options. All of them have a vegetarian menu that is actually cooked rather than assembled, all are quiet enough to talk, and none of them are Japanese, which after a fourteen hour flight is a kindness. Here is the one I would book and why.

This is a plausible paid product on its own, and it is the only feature in the document a company would expense without blinking.

## B4. Relocation and new hire welcome

HRIS says someone started this week, or transferred offices. The agent runs a short calibration and hands them their new neighborhood through their own palate rather than through a generic "best lunch near the office" list. Low effort, high emotional return, and it is the kind of thing an HR team will show off internally.

## B5. Menu intelligence, sold back to restaurants

Aggregate, anonymized, threshold gated: which dishes lose head to head duels against comparable dishes nearby, and along which axes the losses concentrate. Nobody has ever been able to sell a restaurant that. Firewall from Round 4.5 stands: it can never be bought into ranking, and v1 sells nothing.

---

# Part C: the generative layer (the part judges will remember)

## C1. The palate portrait

Not a radar chart. A short, specific, slightly funny piece of writing the model generates from your `θ` and your logs, and rewrites as it learns more.

> You are an acid person pretending to be a heat person. You order the spiciest thing on the menu and then reach for the vinegar. You have never once chosen the sweeter option in a duel, which puts you in the bottom four percent of people I have on file, and it means most desserts are wasted on you. You will try anything fermented.

This is the sponsor deck's "generative art from someone's real data" direction, applied to the one domain where it is not a novelty. It is shareable, which is the only growth mechanism this product has, and it is the screen that makes a judge believe the model knows something.

## C2. Profile as prose, permanently

There is no numeric profile screen anywhere in the product. Your taste is always rendered as language. This is not decoration. It is the enforcement mechanism for the rule from Round 2.6 that similarity is never displayed as a percentage, and it is only possible because the 24 axes were chosen to be interpretable.

## C3. Reasons written, never templated

Every recommendation carries one generated sentence naming the actual mechanism. Templates are banned in code review. The reason for a twin sourced card and the reason for a content sourced card should not be able to be mistaken for each other.

## C4. The twin dispatch, k anonymized

> **Agent:** six people who share your specific dislike of sweet braises have all ordered the same thing at a place four blocks from you. I would not have picked it for you. That is why I am sending it.

The last two sentences are the product's entire thesis in the agent's voice. No identity, no handle, no reply path, k = 5 floor enforced before the message can be composed.

## C5. Your month in food

A short generated recap, delivered as a message. Sends monthly, becomes the retention loop, and doubles as the Photon showcase.

## C6. Cook it

Take a dish you rated highly and generate a recipe tuned to your axes rather than to the original: more acid, less sugar, the heat where you actually want it. Cheap to build on top of `φ`, and it extends the product to the nights nobody goes out. Act two.

---

# Round 6 attack, and responses

**6.1 An iMessage agent that reads group threads is a surveillance product.**
Conceded as a design constraint. The agent reads **only messages that tag it**, holds no thread history beyond the active request, and is never ambient. Stated in the product, enforced at the integration, and the first thing said when it joins a thread.

**6.2 Photon just became a single point of failure for the whole product.**
Correct. Build the agent behind a transport interface so the surface is swappable, and keep the web duel feed as a functional standalone path. Photon is the best surface, not the only one. Also: confirm the actual Photon API before the build starts. It remains unverified from public sources.

**6.3 Menu photo extraction on an unknown venue is the hardest thing in the build and you put it first.**
Conceded, and it is worth it, because it is also the only feature that works with zero corpus coverage. Mitigation: confidence gating from Round 2.7 applies unchanged. If extraction confidence is low on the axes that matter for this user, the agent says so rather than guessing. "I can only half read this menu, here are two I am confident about" is a better message than a wrong one.

**6.4 The palate portrait will flatter people, and flattery is not insight.**
Real risk, and it is the failure mode of every AI generated personality product. The fix is a hard rule in the generation prompt: the portrait must include at least one thing the person will not enjoy reading, and it must be sourced from actual data rather than invented. A portrait that only compliments is a horoscope.

**6.5 HRIS dietary data is Article 9 special category data and you are now routing it through an LLM.**
The sharpest new criticism. Constraints are applied as **set intersection before any model call**, and the constraint values are never placed in a prompt. The LLM sees a pre-filtered candidate list and a count. It never sees whose constraint, what kind, or the raw record. This is an architectural boundary, not a policy.

**6.6 That is now fourteen features on a 72 hour clock.**
Conceded. Scope below.

---

# Revised hackathon scope

**Build (72 hours):**
1. Dish corpus, one neighborhood (unchanged from HARDENING)
2. `θ` fitting from duels (unchanged)
3. **Photon agent: menu photo to order, the two hour follow up, text duels**
4. **The palate portrait**
5. Twin computation with the k floor, and the twin dispatch message
6. One Merge surface, live: **the team dinner with anonymous HRIS constraints**

**Cut to act two:** travel passport, cook it, month in food, client brief, budget policy, menu intelligence, group threads, allergy questions.

## The three minute demo, revised

1. A judge texts a photo of a menu from their own phone, cold, with no profile. Agent replies with a general read and asks two duel questions in the thread.
2. They answer. The agent re-answers the menu question, differently, and says what changed.
3. Their palate portrait appears on screen. This is the moment.
4. Two judges in the room turn out to be taste twins. The agent tells each of them what the other ordered, without naming them.
5. One Merge connected company account plans a dinner for the room, satisfying four dietary constraints, without displaying a single one.

Step 2 is the whole pitch. A judge watches the model change its mind about their dinner because of something they told it thirty seconds earlier. That is personalized AI, demonstrated rather than claimed.

## Sequencing note

If time runs short, cut in this order: Merge surface, twin dispatch, palate portrait, text duels. **Never cut the menu photo flow or the follow up message.** Those two are the product.
