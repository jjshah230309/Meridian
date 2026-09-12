# When something goes wrong

## Meridian will not open

**macOS says it cannot check the app.** Open **System Settings → Privacy &
Security**, find the message about Meridian, and click **Open Anyway**. Once
only.

**The window opens and stays on "Starting the database".** Something is
stopping the server. The window will usually tell you what after a few seconds.
The full log is `meridian.log` in the data folder — the last few lines are the
useful ones.

**Windows: nothing happens.** `Meridian ERP.vbs` starts it without a console
window, so there is nothing to see if it fails immediately. Run
`node src\server.mjs` from a Command Prompt in the same folder to see the
error.

## Signing in

**"That email and password do not match."** Case matters in the password, not
in the email.

**"Too many failed attempts."** Five wrong passwords locks the account for a
few minutes. Wait, or have the owner reset it under Setup → Users.

**Everybody is locked out.** The owner account cannot be locked out of its own
company by permissions, but it can be locked out by a forgotten password. There
is no back door. This is what backups are for.

## Numbers that look wrong

**The trial balance does not balance.** It cannot, arithmetically — every entry
is checked at the moment it posts. If the report says otherwise, run the
integrity check from the ledger screen; it will name the entry.

**A control account does not agree with its subledger.** Receivables against
open invoices, payables against open bills, inventory against the stock ledger.
The tie-out on the ledger screen shows all three with the difference. A
difference is real and worth chasing — most often a manual journal posted
straight to a control account, which the tax and deposit screens also call out
by name.

**A figure includes something from another period.** Check the tax return's
late items and the allocation's basis. Both deliberately sweep up what has not
been dealt with yet, and both say so.

**Stock has gone negative.** Something shipped more than was on hand. It is
visible on Stock & Reorder and corrects itself on the next receipt; a physical
count is the honest fix.

## Performance

Meridian is fast on a few hundred thousand transactions. If a list has become
slow, it is usually a filter with no index behind it — narrow the date range.
If the whole application is slow on a server, check that the data folder is on
a local disk rather than a network share; SQLite over SMB is unhappy.

## Getting more detail

Run the server with `--dev` to log slow requests and return stack traces on
errors. Do not leave it on in production.

The **audit trail** on any record shows every change, who made it and what the
value was before. It cannot be edited or switched off, which is the point.

## Starting again

To wipe a company and start over — this destroys everything:

```
npm run reset
```

Take a backup first, unless you are certain.
