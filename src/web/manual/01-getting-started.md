# Getting started

Meridian is a complete business system — accounting, sales, purchasing, stock,
manufacturing, projects, people and reporting — that runs on hardware you own.
There is no cloud account, no subscription and no outbound connection. Your
company file is a single database file on a disk you control.

This chapter gets you from a fresh copy to a working company.

## Installing it

**macOS.** Open `Meridian ERP.zip` and drag `Meridian ERP.app` to your
Applications folder. The first time you open it, macOS will say it cannot
check the app for malicious software, because it is signed by us rather than
notarised by Apple. Open **System Settings → Privacy & Security**, scroll to
the message about Meridian, and click **Open Anyway**. You only do this once.

**Windows.** Unzip `Meridian ERP (Windows).zip` somewhere permanent — your
Documents folder is fine, a USB stick is not. Double-click
`Meridian ERP.vbs`. To get a Start menu and desktop shortcut, right-click
`Create Shortcut.ps1` and choose **Run with PowerShell**, once.

Nothing is installed into the system, no services are registered and no
registry keys are written. Deleting the folder removes the application.

## The first run

The first time Meridian opens it has no company in it, so it shows the setup
wizard rather than a sign-in screen. It asks for five things:

- **Company name** — what appears on every invoice, statement and remittance.
- **Country** — sets the default currency and tax codes.
- **Base currency** — what your accounts are kept in. Choose carefully: it
  cannot be changed once anything has been posted.
- **Fiscal year** — the first year Meridian will create accounting periods for.
  It creates the previous, current and next year.
- **Your name, email and password** — this becomes the owner account, the one
  account that can never be locked out of its own company.

When you press **Create**, Meridian builds a chart of accounts appropriate to
the country you chose, three fiscal years of accounting periods, a set of tax
codes, a base price level, seven role templates, a bank account, a warehouse,
a collections ladder and a set of landed-cost categories. It takes a second or
two, and then you are signed in.

> If you would rather look around a company that already has data in it, run
> Meridian from a terminal with `npm run reset`. That builds a demo company
> called Northwind Trading with a year of transactions, and prints the sign-in
> details. It replaces whatever was there, so do not do it to a real company.

## Signing in

After the first run, Meridian shows a sign-in form. Enter the email and
password you chose. If more than one company exists in the same data folder, a
company selector appears above them.

Sessions last twelve hours and are held in an HttpOnly cookie. Signing out, or
closing the application, ends the session on the server as well as in the
window.

## The shape of the screen

Meridian has three permanent regions.

**The top bar** holds your company name, the search box, the subsidiary
selector, the **New** button, and buttons for the command palette, help,
light/dark and notifications. Your initials on the right open your account
menu. The company name is a button too: it opens setup, periods, books and
import/export.

**The sidebar** is the navigation. It is grouped the way the business is —
Financial, Sales, Purchasing, Inventory, Manufacturing, Projects, CRM,
Commerce, Service, People, Platform — and each group can be collapsed. You
only see the groups your role gives you access to, so a warehouse supervisor
does not see a sidebar full of screens they cannot open. Press ⌘B to collapse
it to icons.

Two things make a menu of fifty-odd screens workable:

- **Filter it.** The box at the top narrows the whole menu as you type. Two or
  three letters is usually enough — `dep`, `rev`, `tax` — and groups open
  themselves to show what matched.
- **Pin what you use.** Hover any entry and a star appears on the right.
  Pinned screens collect in a **Pinned** group above everything else. Pins are
  yours alone and live on this computer.

**The main area** is the screen you are on. Most screens follow the same
shape: a title and a one-line description, the actions for that screen on the
right, then a row of headline figures, then the detail.

## Finding things

There are four ways, and they are for different jobs.

- **Search** (press `/`) looks inside your data — customers, invoices, items,
  suppliers, journal entries. Type a name or a number.
- **The command palette** (press ⌘K) looks at what the *application* can do —
  every screen, every action, every setting, by name. If you know what you
  want to do but not where it lives, this is the one.
- **New** creates a document from wherever you are, without losing the screen
  you were on. Each entry has a two-key sequence of its own: `N` then `I` for
  an invoice.
- **The sidebar** is for browsing when you are not sure what you are looking
  for.

If you would rather be shown than told, the
[guided tours](#/help/19-guided-tours) walk these screens with you — the
**Learning centre** is at the bottom of the sidebar.

## What happens to your data

Everything lives in one SQLite database file, in one folder:

- **macOS** — `~/Library/Application Support/Meridian`
- **Windows** — `%APPDATA%\Meridian`

You can see the exact path under **Settings → Connection**, or on macOS from
the **Meridian ERP → Show Data Folder** menu.

That folder holds the database, a write-ahead log, a server secret used to
sign session cookies, and any backups you take. Copy the folder and you have
copied the company — but only when nothing is running, because a database that
is being written to cannot be copied safely. Use
[Data & backups](#/help/11-data) instead.

## Where to go next

- Everyday use — navigation, keyboard, lists, records: [Working day to day](#/help/02-everyday)
- If you are setting up a real company: [Setup and administration](#/help/10-setup-admin)
- If several people will use it: [Running Meridian on a server](#/help/12-server)
