# Tax

## Tax codes

A tax code is a name, a rate and the account the tax lands on. A new company
gets Standard, Exempt, VAT 20%, GST 5% and CA Sales Tax; add your own under
Setup.

Where the rate on a line comes from, in order:

1. Whatever is typed on the line.
2. The **entity's** tax code — the customer's on a sale, the supplier's on a
   purchase. Both sides have a tax position, and reading it only from the
   customer is how input tax silently never reaches a return.
3. The item's own tax code.
4. Nothing, if the item is not taxable.

Tax charged on sales and tax suffered on purchases both land on one control
account, which nets to what is owed.

## The return

That net figure is the easy part. The hard part is which transactions it came
from, whether the bill somebody entered a fortnight after the quarter closed
has been claimed yet, and being able to answer both two years later.

So a return is a snapshot with its workings attached. Choose a period; Meridian
shows tax on sales, tax on purchases, the net, and a breakdown by tax code with
every transaction one click away.

**Inclusion is not "dated in the period".** It is "dated on or before the
period end, and never returned". A bill entered late against a quarter already
filed lands in *this* return instead of falling down the gap between them, and
is called out by name as a late item — because a figure that includes a bill
from two quarters ago is otherwise inexplicable.

**Filing** freezes the figures and stamps every transaction behind them. Each
one is therefore counted once and exactly once, and two returns can never cover
the same days. If a return was never actually submitted, **unfile** it: every
transaction it claimed goes back on the table.

The return also breaks the control account into parts that add up: what is
accruing in this return, what has been filed and not yet paid over, and
everything else. That last figure should be the money actually paid to the
authority — one you do not recognise belongs somewhere else, and finding it
before the return goes in is the point.

## 1099

Flag a supplier as a **1099 vendor** and choose the form and box.

At the year end, **Tax → 1099** totals what was actually **paid** to each of
them during the calendar year. Cash basis, deliberately: a 1099 reports money
that moved, not bills that were entered. A supplier billed in December and paid
in January is on next year's form, and totalling the bills instead is the
classic way to file a figure the supplier disagrees with.

Suppliers paid less than the threshold ($600 by default) are listed but need no
form. Suppliers missing a tax number or a postal address are flagged, because a
form cannot be filed without both — and finding that out in January is worse
than finding it out now.

Export as CSV in the columns filing software expects, or as a PDF summary.
