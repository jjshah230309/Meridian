# Accounting books

Keeping more than one set of books over the same transactions.

A company filing under IFRS in one place and local GAAP in another does not
have two businesses. It has one business and two ways of measuring it: the same
invoices, the same payments, the same machines, told twice because two sets of
rules disagree about when revenue is earned and how long a thing lasts.

## How it works

The **primary** book is the ledger. Everything in Meridian posts there —
invoices, payments, depreciation, payroll, all of it. It is created with the
company, it cannot be deleted, demoted or switched off, and nothing on this
page changes it.

Any **other** book records only where it *differs* from the ledger. Its
financial statements are the ledger **plus** those differences.

That is the whole design, and it is worth saying why. The obvious alternative
is to copy every entry into every book. It means every query in the product has
to know which book it means — and there are more than fifty that add up
amounts. Miss one and the profit and loss silently doubles, which in an
accounting system is the worst kind of bug, because it still looks like an
answer.

Holding only the differences has three consequences worth knowing:

- The ledger **cannot be corrupted** by having a second book. Not "is unlikely
  to be" — the entries live in different tables and nothing that reads the
  ledger can see them.
- Every existing report, tie-out and integrity check keeps meaning exactly what
  it meant before.
- "The difference between the two bases" becomes a thing you can look at,
  line by line, which is what gets asked for at audit anyway.

## Making a book

**Accounting Books → New book.** Give it a name people will read (*IFRS*,
*Tax*, *Management*), a code, and a note on what it is for.

A new book starts out **agreeing with the ledger exactly**. It has no
adjustments, so every statement on it is identical to the primary. It begins to
differ only when you post an adjustment or give it its own rule for an asset.

The code cannot change once the book exists — it is what the book's adjustments
are filed under. Which book is primary cannot change either: every other book
is expressed as a difference from it, so swapping them would restate everything
at once.

## Adjustments

**Post adjustment** records a difference. It is an ordinary balanced entry —
the same validation, the same accounts, the same refusal to post into a closed
period — and it enters only that book.

The thing to hold on to: an adjustment is the **difference**, not the whole
transaction. The ledger has already recorded the transaction. If IFRS defers
£4,000 of revenue the ledger recognised, the adjustment is £4,000, not the
whole invoice.

An adjustment can be **reversed**, which puts the book back to agreeing with
the ledger on that point.

## Assets that last longer in one book than another

The commonest reason a company needs a second set of books at all: the same
machine is five years under one set of rules and eight under another.

**Asset rule** records how one book depreciates an asset differently — its own
method, life and residual value. **Run depreciation** then posts, for every
period the ledger has already charged, the **difference** between what this
book would have charged and what the ledger did.

Only the difference, because the ledger's own charge is already in the figures
this book builds on. Posting the whole charge would count it twice.

A period already adjusted is never adjusted again. Running it twice costs
nothing and posts nothing, which means a run that is late or repeated cannot
double-charge.

## Reading a book

The **trial balance**, **income statement** and **balance sheet** all take a
book. The picker appears on those screens as soon as a second book exists — a
control offering one choice is clutter with a label on it, so until then there
is nothing to see.

Choosing the primary book gives you the ledger, byte for byte, which is what
every screen that has never heard of a second book is already asking for.

The **Accounting Books** screen shows, for each book, how many adjustments it
carries and how much its profit differs from the ledger's. A book showing
nothing in that column agrees with the ledger exactly.

## What this does not do

This is the model NetSuite calls an **adjustment-only book**, and it is worth
being plain about the boundary.

A secondary book is the ledger plus differences. It is **not** an independent
journal you can print in isolation — its entries are the primary book's, with
this book's adjustments beside them. For the questions a second basis of
accounting actually gets asked (what is our IFRS profit, what is the difference
and why, what does the balance sheet look like on the other basis) that is the
same answer and a considerably safer one.

A book also keeps the company's own currency. Restating a whole entity into
another currency is a different job, and
[consolidation](#/help/06-ledger) already does it.
