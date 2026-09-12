# Custom records

Every business keeps something an ERP has never heard of: a register of
calibration certificates, a list of approved subcontractors, the safety
inspections a site has to pass before work starts, the assets lent to staff.
Without somewhere to put them they end up in a spreadsheet on somebody's
desktop — unbacked up, unpermissioned, and impossible to report against
alongside everything else.

A **custom record type** gives them a home that behaves like the rest of
Meridian.

## What you get

Define a type and it immediately has:

- its own **list screen**, with filters, sorting, chosen columns and saved views
- its own **record screen**, with a form built from the fields you defined
- a place in the **sidebar**, under whichever group you put it in
- **search** — global search and free-text search on the list, including on the
  fields you invented
- **CSV import and export**, through the ordinary Data screen
- **permissions**, through the ordinary role screen
- a full **audit trail**, the same one every other record gets

None of that is written specially. A custom type is described to the rest of
Meridian in exactly the same terms a customer or an invoice is, and from that
point the system cannot tell the difference.

## Defining a type

**Settings → Company → Define record types**, or go to **Custom Records**.

| Field | What it does |
| --- | --- |
| **Name** / **Plural** | What people call one, and many. Used as headings and in the sidebar. |
| **Machine name** | Lowercase letters, digits and underscores. It is the address the type is filed under. |
| **Appears under** | Which navigation group it sits in — put it with the work it belongs to. |
| **Numbered** | Give records a document number, like an invoice has. Off by default: most registers are known by their own name. |
| **Number prefix** | `CAL-` gives `CAL-00001`. |
| **Show in the sidebar** | Off for a type only reached from somewhere else. |

The machine name **cannot change** once the type exists. Every record of the
type, every field on it and every saved search over it is filed under it.

Types are addressed as `c_<machine name>` — `c_calibration_cert`. The prefix
means a custom type can never collide with a built-in one, whatever you call
it. You will see it in the URL, in CSV imports and in the API.

## Adding fields

Every record has a **name**. Fields are what it carries besides.

Field types are the same ones custom fields on built-in records use: text,
long text, number, money, date, yes/no, a choice from a list, a link to another
record, or a value worked out by formula from the others.

Three settings are worth knowing:

- **Required** — the record will not save without it.
- **Show as a list column** — puts it on the list screen, and makes it
  searchable if it holds text.
- **Order** — the order fields appear on the form.

A field's machine name is also fixed once created, for the same reason a type's
is.

## Using them

Once defined, a custom record is just a record. **New**, fill in the form,
save. It appears in lists, in search, in exports, in the audit trail. A role
that can see custom records can see it; one that cannot, cannot.

One permission — **Custom Records** — covers every custom type. Giving each its
own would mean a role screen that grows without limit and an administrator who
stops reading it.

## Deleting and deactivating

A type with **no records** can be deleted; its field definitions go with it.

A type that **holds records** can only be **deactivated**. It stops appearing
in the navigation and in the list of types, and its data stays exactly where it
is — because it is somebody's data, and deleting the type would take it all
with it.

## Where the data actually lives

All custom records share one table, with the values held in a JSON column, and
each query confined to the type that asked.

The alternative — a table per type, created when somebody defines one — reads
better and lives considerably worse. It means running schema changes at
runtime, on a tenant's behalf, inside a database shared with every other
tenant. That is how one customer's mistake becomes everybody's outage. Nothing
about the way you use a custom record depends on this choice, but it is why
there is no limit on how many types you define.
