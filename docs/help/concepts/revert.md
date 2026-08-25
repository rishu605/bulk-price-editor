# Why revert recomputes

Reverting a campaign does not restore the prices that were there before. It works out what
the price *should* be now, with that campaign removed, and writes that.

## Why not just put the old prices back?

Because the old price is often wrong by the time you revert.

Say a jacket was £100, your summer sale made it £80, and while that ran you started a
clearance campaign that made it £70. Now you end the summer sale. Restoring "what it was
before summer" gives £100 — but clearance is still running, and that product should be £70.

Recomputing gives £70. It is the only approach that survives overlapping campaigns,
recurring campaigns, and campaigns that ended in a partial state.

## What this means in practice

- **Ending a sale is safe** even if other campaigns are running.
- **Reverting a partial run** works: the ledger knows which products were actually written, so only those are touched.
- **Reverting one product** out of a campaign takes it out for good, including future scheduled runs, and recomputes its price without it.

## If someone changed a price by hand

The revert notices. A product whose live price is not what we wrote is reported as
**drifted**, and you choose: keep the manual edit, or bring it back in line. We never
silently overwrite a price a person set — but we never silently ignore it either, because
that would leave a product that no longer matches what the app believes.

## Related

- [What a baseline is](./baselines.md)
- [What drift means](./drift.md)
- [Understanding a partial run](../failures/partial-runs.md)
