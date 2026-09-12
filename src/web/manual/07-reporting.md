# Reporting

## The financial statements

Four, all as at a date or over a period, all drillable down to the entry.

- **Trial balance** — every account with a balance, debits and credits, proving
  they agree.
- **Income statement** — revenue less cost, by section, with an optional
  comparison period beside it.
- **Balance sheet** — what you own, what you owe and what is left, balancing.
- **Cash flow** — operating, investing and financing, driven by the cash-flow
  category on each account.

All four exclude statistical accounts, and all four can be produced for one
subsidiary or consolidated.

## Operational reports

**Aging** — receivables and payables in buckets (current, 1–30, 31–60, 61–90,
90+), by customer or supplier, with the documents behind each figure.

**Sales analysis** — revenue by month, by customer, by item.

**Inventory valuation** — what stock is worth, by location, as at a date,
rebuilt from the ledger rather than from a stored total.

**Budget vs actual** — a budget by account and period against what happened,
with the variance in money and in percent.

## Saved searches

Any list, filtered and arranged the way you want it, saved by name. A saved
search can be private or shared with everybody, and appears in the dropdown
above its list. This is how most people build their own reports: filter the
list, choose the columns, save it, export it.

## Dashboards

The dashboard is a grid of widgets you arrange. Drag them; use **Add widget**
to put on the figures you watch. Each person's arrangement is their own.

## Exporting

| Format | Good for |
|---|---|
| CSV | Anything, anywhere |
| XLSX | A formatted workbook with the numbers as numbers |
| PDF | The financial statements pack, statements, remittances, letters |
| JSON | Feeding another system |

**Power BI, Excel and ODBC** connect to a live feed rather than a file. Meridian
exposes an OData v4 endpoint at `/odata/v1` covering every record type your
role can see. Create an API token under Setup, then connect with the URL and
the token as the password. There is a `.pbids` file on the export screen that
sets Power BI up in one click.

A SOAP endpoint with a generated WSDL is at `/soap/v1` for systems that need
it.
