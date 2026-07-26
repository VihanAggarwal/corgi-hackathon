# Taste Twins

Dish-level food discovery. Fast taste duels build an interpretable 24-axis
preference vector. Once there is enough data, users are matched with **taste
twins**: strangers whose preferences predict theirs. Recommendations are
delivered in a word-of-mouth voice through iMessage.

**The objective is not "predict what you like." It is "expand what you like."**
We recommend at the frontier of a user's known region, and we measure palate
volume growing over time. That is the whole differentiator. A recommender that
maximizes predicted enjoyment is Google Maps with extra steps.

Full spec in `/docs`. Read `docs/BUILD-SPEC.md` first if you need context.

---

## Hard rules. These are not style preferences.

1. **Numbers about places, never numbers about people.** Never display a match
   percentage, a similarity score, a reliability score, or any metric about a
   human being. Similarity is expressed in the language of the axes that drove
   it, never as a number.

2. **The LLM renders, it never decides.** Generation happens only from an
   `EvidencePacket`. Any sentence in output that is not grounded in a packet
   field is a bug. Never let the model query the database, invent a caveat, or
   describe something it was not given.

3. **Constraints are filters, never features.** Dietary and religious
   constraints are Article 9 special category data. They are applied as set
   intersection *before* any model call. They never enter `theta`, never enter
   a prompt, never get displayed, and never leave as anything but a count.

4. **No stranger-to-stranger channel exists anywhere.** No DMs, no replies, no
   profile pages, no way to get from reading a recommendation to contacting a
   person. This is architectural. Do not build a messaging primitive.

5. **k >= 5 and lift > delta before the twin channel may be mentioned.** If
   everyone likes it, it is a billboard, not word of mouth. Below the floor,
   the UI says nothing about twins at all. Never fake a twin.

6. **No enthusiasm markers in generated copy.** No exclamation points, no
   emoji, no "you'll love". Every recommendation names a dish, names a
   downside, and is under four sentences.

7. **Calibration fits only on `verified = true` dishes.** The unverified long
   tail is fine for recommendation, never for model fitting.

---

## Ownership. Do not edit outside your track.

| Path | Owner | Others may |
|---|---|---|
| `/contracts` | **frozen** | read only, announce before changing |
| `/core`, `/scripts/corpus` | **Track A** | import from |
| `/app`, `/components`, `/public` | **Track B** | read |
| `/api`, `/integrations`, `/scripts/seed` | **Track C** | read |
| `/docs` | shared | read |

If you need something from another track's directory, **do not write it
yourself**. Stub it against the contract in `/contracts/types.ts` and post in
the group chat.

---

## Stack

TypeScript everywhere. Next.js App Router, Supabase (Postgres + pgvector +
RLS), Vercel. Anthropic API for extraction and rendering. No Python.
Bradley-Terry is ~80 lines of gradient descent, no ML library needed.

## Git

- Branch per track: `track-a`, `track-b`, `track-c`. Never commit to `main`.
- Commit and push at least every 45 minutes. Small commits.
- Pull `main` before every push. Merge to `main` via PR when a milestone lands.
- Because ownership is disjoint, merge conflicts should be near zero. If you
  hit one outside `/contracts`, someone broke the ownership rule.

## Environment

`.env.local`, never committed:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
GOOGLE_PLACES_API_KEY=
MERGE_API_KEY=
PHOTON_API_KEY=
```

---

## Next.js version note

This repo runs Next.js 16 (App Router). See `AGENTS.md`: read the relevant guide in
`node_modules/next/dist/docs/` before writing framework code. Conventions differ from
older App Router versions.
