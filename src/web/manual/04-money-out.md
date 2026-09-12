# Money going out

Purchasing, from asking for something to paying for it — and getting the cost
of the goods right, which is the part that quietly matters most.

## Suppliers

A supplier record holds the identity, the commercial terms, the payment
details and the tax position.

- **Currency** — every bill for this supplier is raised in it.
- **Tax code** — the rate they charge you. This is what makes input tax reach
  your tax return; a supplier with no tax code means every purchase from them
  looks tax-free.
- **Payment method, bank reference, remittance email** — used by the payment
  run and printed on the remittance advice.
- **Payment hold** — holds them out of every payment run. Their bills still
  appear on the run, listed and unticked, so a hold nobody remembers setting
  cannot quietly persist for a year.
- **1099 vendor, form and box** — see [Tax](#/help/09-tax).

## The purchase cycle

```
Requisition  →  Purchase Order  →  Item Receipt  →  Vendor Bill  →  Payment
                                ↘  (stock arrives)            ↘ Vendor Return
```

**Requisition.** An internal ask. No supplier, no commitment, no posting. It
becomes a purchase order once approved.

**Purchase order.** A commitment to a supplier. Stock is *on order* — counted
in availability, not yet on hand. Nothing posts.

**Item receipt.** The goods arrive. Stock goes up at the purchase price;
the ledger debits Inventory and credits Accrued Inventory Receipts, because
you have the goods but not the invoice.

**Vendor bill.** The invoice arrives. It clears the accrual and puts the
liability on Payables. A bill entered directly against a supplier, with no
purchase order and no receipt, *is* the receiving event — Meridian moves the
stock as well, because otherwise the inventory account and the stock behind it
part company on the first bill.

**Payment.** Debit Payables, credit Bank. Applied to specific bills.

**Vendor return.** Goods go back: stock leaves at what it is carried at, the
supplier owes you the price that was billed, and the difference between the two
is a purchase price variance rather than a silent tweak to inventory.

## Landed cost

A container of stock costs the invoice price *plus* the freight, the duty and
the insurance. Booking those to an expense account leaves the stock understated
on the balance sheet and the margin on every sale of it overstated — and nobody
notices, because both errors are invisible on their own and only meet at the
year end.

Open the receipt or the bill that brought the goods in, and add a landed cost:
choose a category, enter the amount, and choose how it is spread.

| Spread by | Suits |
|---|---|
| Value | Duty and insurance — they scale with what the goods are worth |
| Quantity | Handling — it scales with how many boxes there are |
| Weight | Freight — where you know the item weights |

Meridian divides the cost across the stocked lines, adds it to the value of the
goods in the stock ledger, and posts the matching entry so the inventory
account and the stock agree. The **landed summary** for the document then shows
what each unit actually cost and by how much the invoice price was uplifted.

Categories are editable under **Landed Cost Categories**; four come with a new
company.

## Paying the suppliers

Paying bills one at a time works until there are two hundred of them. **Pay
Bills** is the run.

1. **Build a proposal.** Choose the bank account, the payment date and a
   cut-off — every unpaid bill falling due on or before it, in that account's
   currency, goes on the list.
2. **Argue with it.** The list is grouped by supplier with their bills
   underneath, everything ticked. Untick what you are not paying, or type a
   smaller figure to part-pay. The total in the header moves as you go.
3. **Pay it.** One payment per supplier, covering whatever of theirs is still
   ticked, applied to those bills.

Amounts are re-read from the bills at the moment you press the button, not
trusted from the proposal. A bill that was paid or voided while the run sat in
the drawer is dropped from it and reported, rather than being paid twice.

Afterwards, each supplier gets a **remittance advice** PDF listing exactly
which invoices the payment settled, and the whole run exports as a **payment
file** — one row per supplier, in the columns a treasury upload screen asks
for, ready to map once and use every week.

## Prepayments

Paying before the goods arrive is the mirror of a customer deposit. It is an
**asset**, not a cost and not a payable: debit Supplier Prepayments, credit
Bank.

When the bill arrives, apply the prepayment to it. The asset is released and
that much of the bill is settled, on one entry. If the supplier never delivers,
recover it — the money comes back the way it went out.

## Expenses

Employee expense reports run through Projects & Expenses: an employee enters
lines with a category, a date and whether they are billable to a project.
Approval routes it, and posting it puts the cost in the ledger and the
reimbursement on the employee's payable.
