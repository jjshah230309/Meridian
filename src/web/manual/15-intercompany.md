# Intercompany

Trading with yourself. A group that runs more than one company sells between
them — the parent recharges head-office cost, one entity buys support from
another, stock moves between warehouses that belong to different companies.
Each of those is a real transaction in two sets of books at once, and the
group as a whole has neither earned nor spent a penny.

## The rule everything follows

**An intercompany transaction is two entries, never one.** Both halves are
written together or neither is. A recharge that is an expense in one company
and nothing in the other is not a recharge; it is a mistake waiting for a year
end.

The link between the two halves is kept, because in six months somebody will
ask what the other side of this was, and the answer should not require
guesswork.

## Setting it up

You need two things.

**More than one subsidiary.** Obviously. Each keeps its own books in its own
currency and files its own accounts.

**An elimination subsidiary.** A subsidiary with **Elimination subsidiary**
ticked. It trades with nobody and files nothing; it exists so the cancelling
entries have somewhere to live that is not a real company's books. Meridian
will offer to create one the first time you eliminate.

Two accounts are provisioned for you and flagged as intercompany:

- **1190 Due from Affiliates** — owed to this company by another in the group
- **2190 Due to Affiliates** — owed by this company to another

You never post to either by hand. Meridian will refuse: they are derived,
because they are the half people get wrong.

## A recharge

**Intercompany → New recharge.** Pick the company recovering the cost and the
company bearing it, then enter **only what the transaction is for** — the rent,
the management charge, the shared licence. One line per side.

Meridian works out the rest. The company bearing the cost gets the expense and
a **due to**; the company recovering it gets the credit and a **due from**. Two
balanced entries, one date, linked.

The two sides must face each other. If your lines leave the group out of
balance, Meridian says by how much rather than posting something that does not
add up.

## A sale

**Intercompany → Sale between companies** raises an **invoice** in the selling
company and a **vendor bill** in the buying one, for the same lines, in the
seller's currency.

The customer on the invoice and the vendor on the bill are records that stand
for the other company. They are created once and reused, so ageing, statements
and payment runs all have something real to point at. No tax is applied: a sale
inside a group is not a supply to a third party. If yours genuinely is taxable
between entities, raise it as an ordinary sale instead.

Intercompany sales sit in ordinary **receivables and payables**, not in the
affiliate control accounts. That is deliberate, and the reconciliation counts
both.

## Do the two sides agree?

The obvious test — does due-from across the group equal due-to — is the wrong
one the moment two companies keep their books in different currencies. A dollar
recharge booked by a sterling company is *held* in sterling, and translating the
halves back at any single rate leaves a difference that is pure translation and
nobody's mistake.

So the screen asks three questions, and only two of them can fail.

**Does each pair agree, in the currency it was struck in?** Exact. A difference
here means one half was changed after it was written. Listed under *These pairs
do not agree*.

**Does each company's ledger hold what the register says it should?** Exact,
because both figures are in that company's own currency. A difference means
somebody posted at a control account by hand. Listed under *These ledgers hold
more than the register accounts for*.

**What is left over?** Translation. It is shown as its own figure and named as
such. It is real economic exposure — deal with it in
[currency revaluation](#/help/06-ledger), not by chasing somebody for a
reconciling item that does not exist.

*Both sides agree: Yes* means the first two are clean. It deliberately does not
mean the translated totals are equal.

## Elimination

The group did not sell anything to itself, so on consolidation the intercompany
balances have to come back out.

**Intercompany → Eliminate a period.** Preview first: you see every balance that
will be cancelled, by company and account, before anything is posted.

The entry is posted in the **elimination subsidiary** and nowhere else. Each
trading company's own books are untouched — it files those, and the group's
consolidation adjustments have no business in them. That is the whole reason
the elimination subsidiary exists.

Running a period again **supersedes** the last run: the previous entry is
reversed first, so a period can never be eliminated twice over. A run can also
be reversed outright, which puts its transactions back to uneliminated.

If the intercompany balances do not agree, the entry still posts — a group has
to be able to consolidate — but the difference goes to a named account where it
is visible on the face of the accounts rather than quietly absorbed, and the
preview tells you before you commit. Fix it in the reconciliation and run the
period again.

## Why real entries rather than a reporting filter

Meridian used to eliminate by hiding intercompany accounts when consolidating.
That is quick, and it is invisible: there is nothing to review, nothing to
reconcile, nothing to explain to an auditor, and no way to see what was taken
out or to disagree with it.

Posting real journal entries costs a little more and buys all of that back.
They read like any other entry, they can be questioned, and they can be
reversed. See [Closing the books](#/help/06-ledger).
