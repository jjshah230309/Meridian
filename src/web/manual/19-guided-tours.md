# Guided tours

Being shown around, by the application itself.

An ERP is usually taught by another person, once, at the wrong speed. What
gets remembered is the three screens that came up that morning; what gets
missed is the part that would have saved a fortnight — that the documents are
a chain, that the palette exists, that the report you are about to build by
hand is a saved view.

The **Learning centre** is the alternative. It is in the sidebar, at the
bottom, under the same heading it will still be under in a year.

## What a tour actually is

Not a video and not a slideshow. A tour drives the real application: it
navigates to each screen it talks about, puts a ring around the actual control,
and explains what that control is for — on your own company's data, with your
own permissions.

Two rules follow from that, and both are deliberate.

**A tour never changes anything.** Every step is navigation and explanation.
Nothing posts, saves, deletes or emails. You can be walked through the whole
of month-end on live books, during month-end, and nothing will have happened.

**A tour never gets stuck.** If a step's target is not on the screen — a
permission your role does not have, a screen that looks different on an empty
company — the step becomes a plain card in the middle and the tour carries on.
A teaching aid that can strand somebody is worse than no teaching aid.

## Moving through one

| Key | What it does |
| --- | --- |
| `→` or `Enter` | Next step |
| `←` | Previous step |
| `Esc` | Leave the tour |

The dots along the bottom are clickable, so a step worth reading twice is one
click away. Leaving early is normal and loses nothing: the tour starts from the
beginning next time, and the Learning centre records which ones you have
finished.

## The tours

**Finding your way around** — the four ways to get anywhere, which is most of
what makes a system with fifty screens feel small. Worth the four minutes even
if you have used an ERP before, because the pinning and the palette are not
where you will expect them.

**A sale, from quote to cash** — one order through quote, sales order,
fulfilment, invoice and payment, saying at each step what it does to the
ledger and what it deliberately does not.

**A purchase, from order to payment** — the same shape in reverse, including
the three-way match and what goods-received-not-invoiced is for.

**Closing a month** — the close as a sequence: recurring entries, revenue and
amortisation, allocations, revaluation, bank reconciliation, trial balance,
integrity check, lock. This one is the closest thing in Meridian to a
procedure document.

**Getting answers out** — statements, drill-down, saved views, and the three
routes out of the building: CSV, the REST API, and the OData feed that Excel
and Power BI read directly.

**Making it fit your business** — custom fields, your own record types,
workflow rules, roles, and second sets of books. Most of what a consultant
would have quoted for is a screen in Setup.

## The welcome screen

The first time somebody signs in, Meridian offers the first tour once. Once is
the whole design: an application that asks a second time has not listened to
the first answer. "I'll explore on my own" is a real answer.

To see it again — showing a new colleague, say — use **Learning centre → Show
the welcome screen again**, or type `welcome` into the command palette.

## Starting over

**Learning centre → Your progress → Clear** forgets which tours you have
finished, so they are all offered again. It changes nothing else.

The **Getting started** panel on the dashboard tracks the same progress and
removes itself when every tour is done. If it is in the way before then, the
✕ on it is permanent — it will not come back, and everything it offered stays
in the Learning centre.

## When a tour is not the answer

A tour teaches a shape. For the detail — what a particular field means, what
a setting does to posting, which report answers which question — the
[manual](#/help/01-getting-started) is the better place, and it is
searchable. `⌘/` opens it, `?` lists every keyboard shortcut, and `⌘K` finds
any screen or action by name.
