# The ledger

Meridian is a double-entry accounting system with a business wrapped around
it. Everything that happens anywhere in the application ends up here, and this
is the part that has to be right.

## The chart of accounts

Five types — Asset, Liability, Equity, Income, Expense — each with subtypes
that decide where an account appears on a statement and in the cash flow.

- **Summary accounts** group children and cannot be posted to.
- **Statistical accounts** hold a quantity rather than money: headcount, floor
  area, machine hours. They post like any other account and are excluded from
  every financial statement, because forty-two employees is not forty-two
  dollars. They exist so that [allocations](#allocating-shared-cost) have
  something to divide by.

**Posting accounts** (Setup) are the map from an event to an account:
receivables, payables, inventory, tax, retained earnings, bad debt and about
thirty others. Change one and every future posting follows it; past postings
are untouched.

An account with posted lines cannot change its type — that would silently
restate periods already reported. Create a new account and reclassify.

## Journal entries

Manual entries post straight to the ledger and cannot be edited afterwards.
They must balance in both the transaction currency and the base currency;
per-line rounding of a few cents is absorbed into the exchange difference
account rather than refusing an otherwise valid entry.

To undo one, **reverse** it. Both the original and the reversal stay on the
record, which is what an audit expects to find.

## Periods

Meridian creates twelve periods a year, for the previous, current and next
fiscal year. A period is **open**, **closed** or **locked**.

Closing a period refuses new postings into it. It will not close over unposted
drafts or an out-of-balance ledger unless you force it. Reopening is possible;
locking is not reversible from the interface.

**Period close** shows what is outstanding: unposted drafts, unreconciled bank
lines, schedules due to run, allocations due, revaluation not yet done.

## Recurring journals and accruals

Every month a controller posts the same handful of entries — rent, a
management charge, depreciation of something outside the register. And every
month end they accrue for invoices that have not arrived, then reverse the
accrual on the first of the next month so the real invoice does not
double-count.

Both are the same object: a template, a calendar, and a switch for whether the
entry unwinds itself.

- **Frequency** — weekly, monthly, quarterly, annually.
- **Posts on** — the last day of the period (suits accruals) or a fixed day of
  the month (suits rent).
- **Auto-reverse** — posts the reversal on the following day. This is what
  makes it an accrual.

A run catches up **one occurrence at a time**: a template three months behind
posts three dated entries in their own periods, not one lump on today's date.
A closed period stops that template where it stands and says so, rather than
letting April jump ahead of March.

## Allocating shared cost

Rent, IT, insurance and the finance department itself arrive as one invoice and
belong to five departments. Splitting them by hand every month is the job
nobody wants; splitting them by a percentage somebody typed from memory is the
one nobody can audit.

An **allocation schedule** says: take what landed on these accounts, move it to
these ones, in these proportions.

- **Fixed** — the weights you give.
- **Statistical** — whatever the statistical accounts say this period, so the
  split follows the business rather than a number that was right in 2019.

**Takes** decides the pool: the period being allocated, or everything on the
source accounts not yet allocated. A **clearing account**, if you name one,
leaves the original cost visible where it was booked instead of crediting the
source account directly — which is what a departmental manager wants to see
when they query their charge.

Every run is preview-first: the working is on screen before the entry exists,
the amount is split to the penny, and the run records the weights it actually
used so the split can be explained a year later.

To feed a statistical account, post the month's figures to it — a quantity per
department. The balancing credit carries no department, so each department's
own balance is the number entered for it.

## Revenue recognition and amortisation

A year of support billed up front is one invoice and twelve months of revenue.
A year of insurance paid in January is one bill and twelve months of expense.

Give an item a **revenue template** or an **expense template** and the
document defers instead of earning: revenue goes to Deferred Revenue, cost to
Prepaid Expenses, and a schedule releases it.

| Method | Behaviour |
|---|---|
| Straight monthly | Equal slices |
| Straight daily | Pro-rated by day, so a mid-month start lands exactly |
| On completion | Held until somebody releases it |

The **waterfall** shows how much of the next twelve months is already
contracted. A run is dry-run first, and a slice whose period is closed is held
back and listed rather than failing the whole run.

An invoice with revenue already recognised cannot be voided — raise a credit
memo instead.

## Foreign currency

A sterling invoice raised in January at 1.25 is still carried at 1.25 in March
when the rate is 1.40. You are owed the same £2,000, but it is now worth
$2,800 rather than $2,500, and until somebody says so the balance sheet is
understated.

**Currency Revaluation** measures three exposures — what customers owe, what
you owe suppliers, and cash in a foreign account — values each at the closing
rate, and compares it with what the ledger carries.

The adjustment is *unrealised*: no money has moved and the rate may go back. So
it posts on the closing date and **reverses on the first day of the next
period**. The documents themselves keep the rate they were booked at, which is
exactly what settlement needs in order to work out the realised difference when
the cash finally arrives.

Because a revaluation restates the ledger and not the documents, the same gap
is still on screen after it posts. Meridian names the run that covered the date
so the page does not read as though nothing had been done.

## Banking

Import a statement — CSV, OFX, QFX, BAI2 or CAMT.053 — and Meridian matches
lines against payments and receipts by amount, date and reference. What matches
is proposed; what does not is left for you. A reconciliation locks the matched
set against a closing balance.

A CSV has no fixed way of writing a date, so each bank account has a
**statement date format** — auto, DMY, MDY or YMD — set on it; the other
import formats spell the date out unambiguously and need no setting. Leave it
on **auto** and
Meridian works it out from the file itself where the day and month values make
that possible (`13/02/2026` can only be DMY); it asks you to choose when a
file is genuinely ambiguous, such as every date falling in the first twelve
days of the month.

## Closing the books

At the year end, **retained earnings roll-forward** closes income and expense
into retained earnings. **Consolidation** translates subsidiaries into the
parent's currency at the rates you set and eliminates intercompany balances
against elimination subsidiaries.

**Integrity checks** are available at any time: every entry balances, every
posted transaction has an entry, and the control accounts agree with the
subledgers behind them — receivables against open invoices, payables against
open bills, inventory against the stock ledger. If one of those is out, it is
telling you something real.
