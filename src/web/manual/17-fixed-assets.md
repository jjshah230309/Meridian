# Fixed assets

What the business owns and is wearing out: vehicles, machines, fit-outs,
laptops. The register holds them, depreciation spreads their cost over the
years they are useful for, and three other things can happen to them along the
way.

## The register

An asset carries what it cost, when it went into service, how long it is
expected to last, and the three accounts it posts to:

- **Asset account** — where the cost sits on the balance sheet
- **Accumulated depreciation** — what it has been written down by, so far
- **Expense account** — where the charge goes each month

An **asset class** supplies defaults for all of that, so a new laptop inherits
the laptop rules rather than having them retyped.

An asset starts as a **draft** and bills nothing. **Placing it in service**
builds its depreciation schedule — one row per period for the whole of its
life — and sets it active. Nothing is charged until a depreciation run posts
it.

## Depreciation

**Fixed Assets → Depreciate**. Every period due up to the date you give is
charged: debit the expense account, credit accumulated depreciation.

A period already charged is **never charged again**. Running the same period
twice costs nothing and posts nothing, which means a run that is late, re-run,
or started by two people cannot double-charge.

Four methods are supported — straight line, declining balance, sum of years'
digits, and units of production. Rounding is absorbed by the final period, so
the schedule always sums to exactly cost less salvage value.

## When an asset stops being worth what the books say

Depreciation is a **plan**: spread what a thing cost over the years it is
useful for. Reality interferes. A building is worth more than it cost. A
machine is damaged, or the product it made is discontinued and it will never
earn back what is still on the balance sheet.

Neither is a depreciation question, and neither is fixed by editing the
schedule.

### Impairment

**Impair** writes the asset down to what it is really worth — the amount it
will actually earn or fetch. It is a **loss**, it goes through profit and loss,
and it is recognised now. That is what the word means.

### Revaluation

**Revalue** restates the asset at a new carrying amount, up or down. The
accounting is not symmetrical, and this is the part people get wrong:

**Upwards** goes to the **revaluation reserve in equity**, not to profit.
Nothing has been sold, so nothing has been earned. The gain sits in equity
until the asset is disposed of.

**Except** to the extent it reverses a loss this same asset was charged with
earlier. That loss went through profit, so undoing it goes back through profit
— up to the amount charged, and never more.

**Downwards** first cancels any reserve this asset built up by being written up
before. That reserve was never profit and cannot survive the value it
represented going away. Only what is left over is a loss.

Meridian works the split out and shows it before you commit:

| | To equity | To profit |
| --- | --- | --- |
| Up, never impaired | all of it | nothing |
| Up, previously impaired | the excess | up to what was charged |
| Down, no reserve | nothing | all of it |
| Down, with a reserve | up to the reserve | the remainder |

Both operations **rebuild what is left of the schedule**, spreading the new
carrying amount over the remaining life from the effective date. Depreciation
**already charged is never touched** — it was right when it was charged.

The remaining life is then depreciated straight line whatever the original
method was. Once a value has been restated by judgement rather than by formula,
carrying on with a declining balance computed from the original cost would be
arithmetic pretending to be meaning.

Either can be **reversed**, which puts the asset and the ledger back. A
revaluation that has been superseded by a later one has to wait its turn: undo
the later one first, or the asset ends up carried at a figure neither of them
intended.

## Moving an asset

**Transfer** moves an asset between locations, departments or companies.

Between **locations or departments** nothing posts. The asset is worth exactly
what it was; all that changes is whose depreciation charge it is from that date.

Between **companies** it is a real transaction. One balance sheet loses an
asset and another gains one, through the affiliate control accounts — see
[Intercompany](#/help/15-intercompany). The asset arrives at **its own age**,
carrying its accumulated depreciation with it, not as if it were new.

Two companies on different currencies cannot transfer an asset directly,
because the move would have to be priced. Dispose of it in one and acquire it
in the other.

## Disposal

**Dispose** takes the asset off the books. The cost and its accumulated
depreciation both come out; anything received goes to the bank; the difference
is a gain or loss on disposal.

Any revaluation reserve the asset is carrying has done its job at that point —
the gain it represented has finally been realised.

## What it looks like in the ledger

| Event | Debit | Credit |
| --- | --- | --- |
| Depreciation | Depreciation expense | Accumulated depreciation |
| Impairment | Impairment loss | Asset |
| Revaluation up | Asset | Revaluation reserve (and/or reversing the loss) |
| Revaluation down | Revaluation reserve, then loss | Asset |
| Transfer out | Accumulated depreciation, Due from affiliates | Asset |

Every one of them is an ordinary journal entry that says what it was for, and
can be read, questioned and reversed like any other.
