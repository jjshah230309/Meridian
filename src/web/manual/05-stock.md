# Stock

What you have, where it is, what it cost, and how to prove it.

## Items

An item is anything you sell, buy or make. Its **type** decides how it behaves:

| Type | Holds stock | Typical use |
|---|---|---|
| Inventory | Yes | Something on a shelf |
| Assembly | Yes | Something you make from other items |
| Service | No | Labour, support, a licence |
| Non-inventory | No | Something you buy and consume without tracking |

The fields that change behaviour: **taxable** and **tax code** decide the rate
on a line; **income, COGS and asset accounts** override where the item posts;
**preferred vendor** and **lead time** feed reordering; **weight** feeds landed
cost by weight; **serialised** turns on lot and serial tracking.

## Costing

Meridian values stock at **moving average**. Every receipt averages its cost
into what is already there; every issue leaves at the current average. When a
quantity lands exactly on zero the whole remaining value is flushed out, so no
rounding residue is stranded in the asset account.

Stock bought in another currency is carried in yours, converted at the rate on
the document, because that is the only way the inventory account and the stock
behind it can agree.

Shipping more than is on hand drives both quantity and value negative rather
than silently costing the issue at zero. Negative stock is visible and
corrects itself on the next receipt; a zero-cost shipment quietly overstates
margin, which is far worse. You will see it on the reorder screen as a
stockout.

## Locations and availability

Stock is held per item per location. Three numbers matter:

- **On hand** — physically there.
- **Committed** — on hand but promised to a sales order.
- **On order** — on a purchase order, not yet arrived.

**Available** is on hand less committed. **Projected** adds what is on order.

**Stock & Reorder** shows every item against its reorder point, works out a
suggested order quantity that brings it back up to its preferred level, and
marks each line stockout, critical or low. **Demand planning** and **supply
suggestions** take the same idea further with forecasts.

## Moving stock

- **Inventory transfer** — between locations. No ledger effect unless the two
  locations belong to different subsidiaries.
- **Inventory adjustment** — a correction. The offset account defaults to
  Inventory Shrinkage; name a different one when the reason is different.
- **Bins** — a location can be divided into bins. Creating the first bin at a
  location switches bin tracking on for it.
- **Lots and serials** — items marked serialised carry a lot number through
  receipt, storage and issue.

## Counting it

Once a quarter somebody walks the racks. What they find is rarely what the
system says, and the difference has to arrive as one reviewed adjustment, not
forty ad-hoc corrections.

**Open a count** at a location. Choose the scope:

- **Full** — everything stocked there.
- **Category** — one category.
- **Cycle** — a rolling slice, taking the shelves nobody has looked at
  longest. Counting twenty-five lines a week gets round a warehouse without
  ever shutting it.

Meridian issues a sheet listing every item with the quantity it *believes* is
there. That figure is frozen: the variance is measured against what the counter
was working from, not against a number that moved while they were walking.

Enter what was found. Meridian works out the variance in units and in value as
you go. When you post the count, every variance goes into **one inventory
adjustment** — so the ledger shows a stock count, with the count itself as the
supporting paper — and each line records when it was last counted, which is what
the cycle scope orders by.

A count where everything agrees posts with no adjustment at all. A posted count
is closed; to change it, reverse the adjustment.

## The warehouse

For businesses picking and packing at volume:

- **Pick waves** gather orders into a run, generate pick tasks in bin sequence,
  and move through picked → packed → shipped.
- **Packages** record what went in which box, with weights and tracking.
- **Putaway** suggests where to put an arriving receipt.
- **Quality inspections** hold received or produced stock until checked.

## Making things

- **Bills of material** define what an assembly is made from, with scrap
  percentages and versions.
- **Work centres and routings** define where the work happens and how long it
  takes.
- **Work orders** issue components at cost, absorb labour and overhead through
  Work in Progress, and receive the finished item at what it actually cost.
  The difference between that and standard cost lands in Manufacturing
  Variance, by name.
