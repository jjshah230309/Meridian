# Setup and administration

Everything under **Setup**, and the thinking behind it.

## Company

Name, base currency, country and fiscal year were set when the company was
created. The name is editable; the base currency is not, once anything has
posted.

**Subsidiaries** let one company file hold several legal entities, each with
its own base currency and its own books, consolidating into the parent. A
subsidiary marked **elimination** is where intercompany balances are cancelled.

## Users and roles

A **user** is somebody who can sign in. Creating one sets a password you give
them yourself — Meridian sends nothing.

A **role** grants a level on each record type:

| Level | Can |
|---|---|
| None | Not see it at all |
| View | Read |
| Create | Read and add |
| Edit | Read, add and change |
| Full | All of that, and delete |

Seven templates come with a new company — Administrator, Controller, AP Clerk,
AR Clerk, Sales Rep, Sales Manager, Warehouse — and you can add your own. A
user can hold several roles; the most generous level wins.

**Row-level restrictions** narrow what a role sees within a record type: *own
records only* for a sales rep, or a specific subsidiary. This is enforced in the
database layer rather than in each screen, so a screen that forgets to filter
still cannot leak.

The **owner** account is the one that created the company. It always has full
access and cannot be locked out.

## Numbering

Every document type has a prefix and a padded counter — `INV-00001`,
`BILL-00042`. Change the prefix or jump the counter under Setup. Numbers are
allocated inside the transaction that uses them, so a document that fails to
save does not burn a number an auditor will ask about.

## Custom fields

Add a field to any record type: text, number, money, date, checkbox, select,
reference or formula. It appears on the record, in the list column picker, in
search, in imports and in exports — everywhere a built-in field appears,
because they go through the same registry.

A **formula** field is calculated by an expression rather than typed. The
expression language is small and deliberately sealed off: it can read the
record's fields and use arithmetic, comparisons and a handful of functions, and
it cannot reach anything else, loop forever or allocate without limit.

## Workflows

A workflow watches a record type for a trigger — created, edited, a field
changing, a state being reached — checks a condition, and takes actions: set a
field, send a notification, block the save with a message.

Everything a workflow does is logged against the record it did it to.

## Approval rules

An approval rule holds a document at *pending approval* when it matches a
condition — an order over a value, a bill from a particular supplier — and
names who can release it. A held document cannot post until it is approved,
and the approval is recorded with the approver and the time.

## Server scripts

For logic a workflow cannot express. A script runs in a sandbox with no
filesystem, no network and no access to the host, on a step budget so a runaway
loop stops rather than taking the server with it.

## API tokens

For Power BI, Excel, the ODBC bridge and anything else that reads Meridian
unattended. A token is shown exactly once, at creation. Tokens can be scoped
and revoked, and every request made with one is attributed to it.
