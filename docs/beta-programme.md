# Beta programme

Ten to twenty stores, recruited from a **specific named list** rather than by generic
outreach. The materials are here; building the list and sending the messages needs somebody
with the competitor review pages open.

---

## Where the cohort is

Merchants who left 1–3 star reviews on competing price editors, about:

- **Compounding discounts.** "I ran the sale twice and everything is 36% off." The single most common complaint in the category, and the thing baselines make impossible.
- **Frozen jobs.** "It said applying for six hours and I have no idea which products changed." The failure the ledger exists to prevent.
- **Missing Markets support.** "Works fine until you have more than one currency."
- **Reverts that did not restore.** "Ending the sale put the wrong prices back."

And the Shopify community threads about per-market compare-at and bulk-editing B2B
catalogues — where people are asking for something the platform does support and the
ecosystem believes it does not.

**Why this cohort and not a wider one.** They are public, motivated, and articulate about
precisely the gaps this product closes. A merchant who has been burned by compounding
discounts does not need the baseline concept explained; they will explain it back to you.
That is worth more in the first ten conversations than a hundred sign-ups who are merely
curious.

---

## Outreach

**Reference their specific complaint.** A generic pitch to somebody who wrote three
paragraphs about a specific failure reads as not having been read, and the whole reason to
pick this cohort is that they were specific.

### Template — compounding discounts

> Hi [name],
>
> I read your review of [competitor] — the part about running the sale twice and ending up
> at 36% off rather than 20%.
>
> I've built a price editor where that is structurally impossible: every campaign computes
> from a baseline price recorded before anything changes, never from whatever the storefront
> currently shows. Running the same campaign twice does nothing the second time.
>
> I'm looking for ten or so stores to use it properly before it launches, and I'd rather have
> people who have been burned by this than people who haven't. Free while you're in the beta,
> and free afterwards on any plan for the safety features — preview, history, one-click
> rollback.
>
> Worth twenty minutes?

### Template — frozen jobs

> Hi [name],
>
> Your review of [competitor] mentioned a job that sat at "applying" for hours with no way to
> tell which products had actually changed.
>
> The app I've built writes a ledger row before every price change and reads the price back
> afterwards, so there is always a page that says exactly which products are at which price
> and why. A run that dies mid-way shows as visibly partial and resumes from where it stopped.
>
> Looking for a few stores to use it before launch. Interested?

### Template — Markets

> Hi [name],
>
> You mentioned [competitor] falling over once you had more than one currency.
>
> Mine prices into each market from that market's own normal price, in its own currency, with
> its own strike-through — including yen, which has no decimal places and which most tools
> round into nonsense.
>
> I need a handful of multi-market stores in the beta specifically, because that is the part
> hardest to get right and easiest to get wrong quietly. Would yours be one?

**Target: ≥10 active installs, ≥3 multi-market.** The second number matters more than the
first. Multi-market is the differentiator and it is the part where a bug is least visible
to us and most expensive to them.

---

## Interview script

Twenty minutes. Recorded with permission. The aim is what they *do*, not what they think of
the app — an interview that turns into a demo produces compliments and no information.

### Current workflow (5 min)

1. Walk me through the last price change you made. What did you actually do, step by step?
2. How long did it take? How much of that was waiting?
3. Who else had to know, or approve?
4. What do you do about markets — same prices, or different?

### Failure history (7 min)

The most valuable section. Ask for specifics and resist filling silences.

5. Tell me about a time a price change went wrong. What happened?
6. How did you find out? *(Listen for: a customer told them. It usually is.)*
7. How long between it going wrong and you knowing?
8. What did you do to fix it? How long did that take?
9. Has that changed how you do things since?

### Baselines and reverting (4 min)

10. When you run a sale, what do you think of as the "normal" price? Where does that number live?
11. When a sale ends, how do the prices go back?
12. Has an ending ever put back the wrong price?

### Willingness to pay (4 min)

13. What do you pay for pricing tools now?
14. If this saved you [the thing they described in section 2], what would that be worth monthly?
15. Which would you actually pay for: more products, more markets, or wholesale? *(This is the D3 tiering question. Ask it as a choice, not as a rating.)*

### D8 signal

**The open decision: should B2B move ahead of the calendar into P5?**

16. Do you sell wholesale through Shopify B2B?
17. If yes: how do you price it today, and what breaks?
18. If you had to choose between a promo calendar and B2B catalogue pricing landing first, which?

**Record the answer to 18 as a count, not an impression.** The gate is ≥30% asking for B2B,
and a decision made on "several people mentioned it" is a decision made on whoever was
loudest.

---

## Synthesis

Every interview gets a theme, filed the same way in-app feedback is — `npm run feedback`
already has the triage and theme queries, and running the beta through the same pipeline
means the synthesis is one command rather than a document somebody maintains.

One merchant asking for something is an anecdote. Eight asking for the same thing in
different words is the next ticket, and the only way to see that is to have put a theme on
each one all along.

**Tell people when their feedback ships.** `npm run feedback owed` lists who is waiting.
That single habit is the difference between a cohort that keeps talking to you and one that
installed the app once.
