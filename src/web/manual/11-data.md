# Data, import, export and backups

## Where your data is

One SQLite database file, in one folder, shown under **Settings → Connection**.
Alongside it sit a write-ahead log, a server secret used to sign session
cookies, and any backups you have taken.

The write-ahead log means the database is safe if the machine loses power
mid-write, but it also means **copying the `.db` file on its own is not a
backup**. Use the backup command.

## Importing

**Import & Export → Import** takes CSV, TSV or Excel (`.xlsx`) for any record
type — a spreadsheet is read on the server, not in the browser, so nothing
about the file format changes what happens next.

1. Choose the file. For a workbook with more than one tab, pick which sheet —
   Meridian shows the first rows either way.
2. It proposes a **column mapping** by matching your headings against field
   names, labels and the aliases accounting exports actually use — so
   `Customer ID`, `Account Number` and `Code` all find `entity_no`, and
   `Item Name` finds `name` on an item.
3. **Validate.** Every row is checked against the same rules the interface
   uses: required fields, references that must exist, numbers that must parse.
   You get a list of problems by row and column.
4. **Commit.** Only then is anything written, and it is written through the
   same code path as typing it in — so an imported customer is numbered,
   validated and audited exactly like one entered by hand.

Every import is recorded as a job. If it turns out to be wrong, **reverse** it
and everything it created goes away.

### Bringing everything over at once

Moving off an old system rarely means one file. It means a workbook per year,
or one workbook with a tab per list — customers, items, the chart of accounts,
every invoice since the company started. **Import & Export → Import → Bring
everything over at once** is built for that.

Add every file, or one workbook with several tabs — each tab counts as its own
entry here, the same as a separate file would. For each one Meridian guesses
what it is from its columns and, where the sheet or file name helps, from that
too: a tab called *Vendor Bills* is a stronger hint than any column ever is,
but a plain "Customers.csv" with a Name and Email column is recognisable on
its own. The guess is a starting point, shown with the columns it matched —
change it if it is wrong, or open **Review columns** to fix one mapping by
hand without losing your place in the rest of the batch.

**Check** validates every included sheet at once and shows, per sheet, how
many rows are ready and how many need attention — the same report the
one-file screen shows, just one per sheet rather than one per screen.
**Import everything that is ready** then commits each sheet that checked out.
Reference data goes in before the things that point at it — accounts before
customers before invoices — so a sheet of invoices finds the customers a
sheet earlier in the same batch just created. You do not choose that order;
it is worked out from what each record type actually depends on.

A sheet with a mix of good and bad rows still imports its good rows and
reports the rest as skipped, exactly like the one-file screen's own commit
button. A sheet that fails outright — the wrong record type chosen, say —
does not touch any other sheet in the batch: each one lands as its own job in
**History**, reversible on its own, whether the batch around it succeeded or
not.

**What this does not read.** The older Excel format (`.xls`, from Excel
97–2003) is not a spreadsheet Meridian can open directly — it is a different,
much older binary format under the hood, not the zip-based one `.xlsx` is.
Open it in Excel, Numbers or LibreOffice and use *Save As → Excel Workbook
(.xlsx)* first. Everything from Excel 2007 onward is already in the format
this reads.

### Bank statements

Bank files get their own importer, understanding CSV, OFX, QFX, BAI2 and
CAMT.053. Meridian detects the format, parses the lines, and matches them
against payments and receipts by amount, date and reference.

## Exporting

Any list exports exactly as you are looking at it — same columns, same filter,
same sort — as CSV or a formatted XLSX workbook. The financial statements
export as a PDF pack or a workbook. Statements, remittance advices, dunning
letters and tax returns are PDFs.

For a live connection rather than a file, use the OData feed — see
[Reporting](#/help/07-reporting).

## Backups

Run this on the machine that holds the data:

```
node scripts/backup.mjs create
```

It uses SQLite's `VACUUM INTO`, which takes a consistent, compacted snapshot of
a **live** database — safe to run against a server with people using it. The
result is a single `.db` file under `backups/`, and the fourteen most recent
are kept.

```
node scripts/backup.mjs list
node scripts/backup.mjs create --to /Volumes/Backups --keep 30
```

To run it nightly, add it to cron or Task Scheduler on the server.

### Restoring

Restoring is deliberately awkward, because it is how a bad afternoon becomes a
bad quarter.

```
node scripts/backup.mjs restore --from backups/meridian-2026-03-31T02-00-00.db --yes
```

Stop the server first. Meridian checks the backup's integrity before touching
anything, and moves the database that was there aside rather than deleting it,
so a restore from the wrong file is itself recoverable.

## Moving a company to another machine

1. Stop Meridian on the old machine.
2. Take a backup.
3. Copy the resulting `.db` file to the new machine's data folder, named
   `meridian.db`.
4. Start Meridian there.

Sessions do not travel — everybody signs in again — and the server secret is
regenerated, which is what you want.
