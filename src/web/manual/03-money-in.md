# Money coming in

The sales side, from a name in the pipeline to cash in the bank — and to
admitting some of it is never arriving.

## Customers

A customer record holds the identity (name, addresses, contacts), the
commercial terms (currency, payment terms, credit limit, price level, discount)
and the collections state (who chases them, what they promised, whether they
are on hold).

Two fields do more than they look like they do:

- **Currency** — every document for this customer is raised in it. It cannot be
  changed once they have open transactions, because doing so would restate them.
- **Credit limit** — a sales order that would take a customer past their limit
  is blocked. Somebody with the right permission can override it on the order,
  and the override is recorded.

## The sales cycle

```
Quote  →  Sales Order  →  Fulfilment  →  Invoice  →  Payment
                       ↘  (stock leaves)      ↘ Credit Memo
```

**Quote.** A price, with no commitment. Posts nothing, reserves nothing.

**Sales order.** The customer has agreed. Stock is *committed* — still on hand,
but no longer available to promise to somebody else. Nothing has posted yet.

**Fulfilment.** The goods leave. Stock comes off at moving-average cost, and
the ledger takes the cost of sale: debit COGS, credit Inventory. No revenue
yet — you have shipped it, not billed it.

**Invoice.** The customer owes you. Debit Receivables, credit Revenue, credit
Sales Tax. If the item carries a revenue recognition template, the revenue is
credited to Deferred Revenue instead and released over its term — see
[Revenue recognition](#/help/06-ledger).

**Payment.** Debit Bank, credit Receivables. Apply it to specific invoices, or
leave it unapplied on account. Meridian applies oldest-first if you do not
choose. A foreign-currency payment books the realised exchange difference to
its own account by name.

**Credit memo.** The reverse of an invoice: reduces what the customer owes,
and can be raised directly from the invoice it relates to.

## Deposits

Money taken before there is anything to invoice — a deposit on a big order, a
retainer.

A deposit is **not** revenue and **not** a receivable. It is cash and a
liability: debit Bank, credit Customer Deposits. It sits there, visibly owed
back, until the goods go out.

When you invoice the work, open the deposit and **apply** it to the invoice.
Meridian releases the liability and settles that much of the invoice, on one
dated entry. No cash moves, because the cash arrived when the deposit did.

If the order falls through, **refund** it: the liability goes back out to the
bank the way it came in, never through revenue.

**Deposits → Held** shows what you are sitting on, by customer, with the
account balance beside it so the two can be checked against each other.

## Collections

The aging report tells you who is late. The collections desk tells you what to
do about it.

**The worklist** is every customer with something outstanding, ordered by how
far gone they are — with one exception: a customer who has promised to pay by
a date that has not yet passed drops down the list rather than off it. Each row
shows the aging buckets, the oldest item in days, how far up the dunning ladder
they have been chased, who owns the account, and whether they are on hold.

Click a customer to see their open items, record a promise, assign a collector,
put them on hold, mark them "do not chase", or write something off.

**Statements** come in two shapes, both as PDFs:

- **Open items** — everything still outstanding, aged.
- **Activity** — every movement over a period with a running balance.

A statement is written in the customer's own currency. Where a customer has
documents in more than one, the totals are stated in your reporting currency
with each document's own amount beside it.

**Dunning** is a ladder, not a single letter. The default has three rungs:

| Rung | Fires when | Effect |
|---|---|---|
| Reminder | 7 days overdue | A polite note |
| Second request | 30 days overdue | Firmer, references the first |
| Final notice | 60 days overdue | Puts the account on credit hold |

An account climbs **one rung at a time**, however far behind it is — a customer
who simply mislaid an invoice should not get a final notice first. A run also
skips anybody who has promised to pay, anybody chased inside the cooldown
period, anybody below the minimum balance, and anybody marked do-not-chase, and
it tells you which and why before it sends anything.

Each letter is produced as a PDF in the customer's own currency, listing the
overdue items so the total in the sentence matches the total in the table.
Nothing is emailed — the letters are produced and recorded for you to send.

Policies are editable: **Dunning Policies** under Financial. Change the days,
the wording, the minimum balance, or add rungs. The letter templates take
placeholders like `{{overdue}}`, `{{oldest_days}}` and `{{account}}`.

## Writing debt off

When money is not coming, say so. On the customer's open items, choose
**Write off**.

The invoice is settled without any cash: the receivable comes off the ledger
and the loss is taken, either straight to **Bad Debt Expense** or against the
**Allowance for Doubtful Accounts** if it was already provided for. Nothing is
deleted — a settlement document records it, and the invoice keeps its history.
Part write-offs are allowed; the balance stays outstanding.

## The provision

**Collections → Provision** applies an expected-credit-loss rate to each aging
bucket — 0% on current, rising to 50% on 90-days-plus by default, all editable
— works out what the allowance should be, compares it to what is standing on
the account, and posts only the difference.

It is a standing provision, not a period entry: each run adjusts it to the new
target. Writing an invoice off against the allowance draws it down, and the
next run tops it back up.
