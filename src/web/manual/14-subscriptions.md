# Subscriptions

Selling the same thing every month. A subscription is not an invoice that
repeats: it is a contract with a term, seats that move part way through, usage
nobody knows until afterwards, and an ending that either renews itself or does
not. The invoices fall out of it.

## What a subscription is made of

**The contract** carries the customer, the currency, the term, and how often it
bills. **Lines** carry what is being sold. **Amendments** are the record of it
changing. **Billing history** is one row per line per period ever invoiced —
which is what makes a period impossible to bill twice.

Three fields shape everything else:

- **Billing frequency** — monthly, quarterly or annually. This is how often an
  invoice goes out, not how the revenue is earned. Those are different
  questions, and Meridian answers them separately.
- **Billing day** — a fixed day of the month, so a hundred customers land on
  one date instead of a hundred anniversaries. Leave it at 0 to bill on the
  contract's own anniversary. A fixed day makes the *first* period short, and
  that short period is prorated.
- **In advance / in arrears** — almost everything bills for the period ahead.
  Metered usage cannot, and never does: you do not know what somebody used
  until they have used it.

## The three kinds of line

**Recurring.** The same charge every period — seats, a base fee, a support
plan. Prorated when the line covers only part of a period.

**One-time.** Charged once, in the period its start date falls in — setup,
migration, training. It is billed on the first invoice and never again, no
matter how many times the run is repeated.

**Usage.** Metered. You record what was used as it happens; at the end of the
period Meridian totals it, subtracts the **included quantity**, and charges for
the rest. Usage that stays inside the allowance still produces a billing
record — so it can never be charged later — but no invoice line, because a line
for nothing is a question the customer has to ring up about.

## The life of a contract

```
Draft  →  Active  →  (Suspended ⇄ Active)  →  Cancelled
                  ↘  Expired / Renewed
```

**Draft** bills nothing. It is a contract being written.

**Active** bills. Activating stamps the start and sets the first bill date.

**Suspended** is live but not billing — a dispute, a payment problem. The term
keeps running; the invoices stop. Resume it and billing picks up from where it
stopped, including any periods that passed in the meantime.

**Cancelled** ended early. Give it an effective date; it cannot be dated before
what has already been billed, because that invoice has gone out.

**Expired** reached the end of its term and did not renew.

## Billing

**Subscriptions → Bill** runs everything due. Preview first: the same function
produces the preview and the invoice, so what you are shown is what will post.

One run produces **one invoice per subscription**, carrying every period it
owes. A contract three months behind gets one invoice with three months on it,
not three invoices somebody has to reconcile.

Each invoice line carries the **service period** it covers. That is what lets
revenue recognition pick it up without knowing subscriptions exist: bill a year
up front and the cash is one event, while the earning is twelve. See
[Revenue recognition](#/help/06-ledger).

A run will skip a subscription and tell you why — it is suspended, nothing is
due yet, or the accounting period the invoice would fall in is closed. Skipped
is not failed; fix the reason and run it again.

### Why a period cannot be billed twice

Every line of every period that has ever been invoiced is written to the
billing history before the run finishes. A run that is late, re-run, or started
by two people at once checks that history first and charges nothing twice. This
is the same discipline the tax return uses, for the same reason.

## Changing a live contract

Use **Amend**. Never edit a line that has billed — Meridian will not let you,
and the reason is that the invoice pointing at it has to keep meaning what it
said.

An amendment has a date, and the date does the work:

- **Change a quantity** — the old line ends and a new one begins. Adding ten
  seats on the 12th bills ten seats for the rest of that month, not for all of
  it. Both lines stay, so every period is priced at whatever was true during it.
- **Change a price** — the same shape. The old price stands for the periods it
  covered.
- **Add a line** — an add-on bought in month four, prorated from that day.
- **Remove a line** — the line is kept, not deleted, and given an end date. It
  billed real periods and those invoices have to keep pointing at something.

An amendment cannot be dated before what has already been billed. If you need
to change something already invoiced, credit the invoice instead.

## Renewal

A contract with a term reaches its end and either renews or expires. If
**auto-renew** is on, Meridian starts a new term of the renewal length,
increments the renewal count, and carries on billing. If it is off, the
contract expires and stops.

**Coming up for renewal** on the Subscriptions screen shows everything ending
within ninety days, and which of them will renew on their own. The ones that
will not are the list somebody needs to work.

Evergreen contracts — no term, no end date — run until somebody cancels them.

## Recurring revenue

**MRR** is the monthly value of what recurs, normalised: an annual line counts
as a twelfth, a quarterly one as a third. One-time and usage lines are excluded,
because neither recurs. A line that has been superseded by an amendment stops
counting on the day it ends, so a quantity change moves MRR rather than
doubling it.

**ARR** is twelve times MRR. Both are shown on the Subscriptions screen, with
what is due to bill and what is up for renewal beside them.

## What it looks like in the ledger

Nothing about subscriptions is special once the invoice exists. It is an
ordinary invoice — debit Receivables, credit Revenue or Deferred Revenue —
that happens to know which contract produced it, and says so on the record. It
ages, chases, and pays like any other. See
[Money coming in](#/help/03-money-in).
