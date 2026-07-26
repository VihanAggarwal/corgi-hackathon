# Merge integration brief for Track C

**Written by Track A. Track C owns the implementation; this exists so the
architecture decision is not rediscovered at hour 60.**

Status: we have **Merge Agent Handler** and **Merge Gateway**. We do **not** have
the Merge Unified API. That changes the shape of E1 but not its guarantee.

---

## The one thing that must not go wrong

**Our server is the MCP client. The LLM is never in that loop.**

Agent Handler's documented happy path is to hand its MCP server to an agent and
let the agent decide which tools to call. **Do not do that for E1.** It is the
obvious integration, it is what the docs demonstrate, and it breaks hard rule 3
the moment it runs, because dietary and religious records land directly in a
model's context window.

MCP is a client/server protocol with typed tool definitions. Nothing in it
requires an LLM to be the caller. An MCP client is ordinary code. So:

```
Agent Handler (MCP server)
        │  deterministic tool call from a server route, no model involved
        ▼
our MCP client  ──►  constraint filter (set intersection)
                              │
                              ▼
                     { candidates, count }
                              │
                              ▼
                     EvidencePacket  ──►  LLM
                     (constraintsAppliedCount only)
```

Hard rule 3 governs **what reaches a prompt**, not which vendor fetched the
data. Fetching Article 9 data over MCP is fine. Letting a model choose to fetch
it, or see it, is not.

---

## What we confirmed about Agent Handler

| Property | Finding |
|---|---|
| Access | **MCP only.** No plain REST for tool execution. Admin functions have REST |
| Auth | OAuth, API keys, custom auth. Per-end-user or shared across a Group |
| Connectors named in docs | Salesforce, Slack, Jira, GitHub, HubSpot, NetSuite, **Workday** |
| Safety features | DLP scanning on tool inputs and outputs, full audit trail, tool scoping per agent surface |

**Workday is the HRIS path for E1.** Confirm what is actually enabled on our
account before building against it; connector coverage is thinner here than the
Unified API's would have been.

### Scoping

Scope the tool surface to a **read-only HRIS employee tool and nothing else**.
Agent Handler is pitched around write actions. We want zero write capability
anywhere near this integration.

---

## Guarantees E1 must still deliver, unchanged

These come from `CLAUDE.md` hard rule 3 and the Track C prompt. None of them
relax because the vendor product changed.

1. Constraint values are applied as **set intersection on the candidate list
   before any model or LLM call**.
2. The renderer receives an **integer count and nothing else**.
3. It must be **structurally impossible** for a constraint value, kind, or owner
   to reach a prompt, a response body, or a log line. Make the filter helper
   return a type that has no channel for values, rather than a type that has one
   and is carefully not used. A reviewer should not have to trace call sites to
   verify this.
4. Constraints never enter `theta`. Two people are not taste twins because they
   are both kosher.
5. **Consent gate:** no employee record is usable without `org_members.consented_at`.
   No exceptions, including for the demo.
6. The organizer sees `4 constraints applied`. Never which. Never whose.

The whole feature is one sentence: **a dinner where nobody has to announce their
celiac diagnosis at the table.** If a judge asks "could the model ever see who
is kosher", the answer has to be "there is no code path", not "there is a
scanner".

---

## Merge Gateway: put every model call behind it

Gateway is an LLM router sitting between our app and model providers. It never
touches HRIS data, so it carries **no Article 9 exposure at all**.

Worth doing because:
- Failover when a provider degrades, and the resilience pass already assumes
  conference wifi will fail mid-demo
- Cost and latency observability across the corpus run, which is by far our
  largest token spend
- A clean second sponsor integration for almost no work

Track A's `scripts/corpus/extract.ts` and `core/render.ts` both isolate the
Anthropic client behind a single accessor function, so pointing them at Gateway
is a base URL change in one place per file. Track A will wire its own side.

---

## Fallback if the HRIS connector is not available

E1 degrades cleanly rather than dying. `contracts/schema.sql` already types:

```sql
source text default 'self',   -- 'self' | 'merge_hris'
```

So the same filter path works with self-declared constraints, and the demo line
is identical: the organizer still sees "4 constraints applied" and never which
or whose. Only the provenance changes.

Have this path working regardless. It is also the honest answer when a judge
asks what happens at a company without an HRIS connector.

---

## Audit trail, worth knowing

Agent Handler logs every tool call, so employee dietary records will exist in
Merge's audit log. This would also have been true of the Unified API. It is not
a blocker, but the consent copy should cover it and `consented_at` is the gate
that makes it defensible.
