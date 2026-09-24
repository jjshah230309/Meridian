# Working day to day

Everything in Meridian is one of three things: a **list** of records, a
**record** you can read and edit, or a **process** that does something to
several records at once. Learn those three shapes and the whole application
becomes familiar, including the parts you have never opened.

## The keyboard

Meridian is built to be driven from the keyboard. There are two kinds of
binding.

A **chord** is held down together — ⌘K. A **sequence** is typed in order — G
then D — and works anywhere you are not typing into a field.

The complete list is on **Help → Keyboard Shortcuts**, or press `?`. It is
generated from the same list the command palette searches, so it is never out
of date. The ones worth learning first:

| Do this | Press |
|---|---|
| Command palette — search everything the app can do | ⌘K |
| Search your records | `/` |
| Go to the dashboard | G then D |
| New invoice | N then I |
| Settings | ⌘, |
| Help | ⌘/ |
| Keyboard shortcuts | ? |
| Light / dark | ⌘⇧L |
| Collapse the sidebar | ⌘B |
| Filter the menu | click the box at the top of the sidebar |
| Zoom in, out, reset | ⌘+, ⌘−, ⌘0 |

### The command palette

⌘K opens a search box over the application. Type any part of what you want —
"invoice", "revalue", "dark", "count" — and it offers the screens, actions and
settings that match, ranked so that a match at the start of a name beats one
in the middle. Arrow keys move, Enter runs, Escape closes.

The palette is the answer to "I know Meridian does this, but where is it".

### Resizing and tiling the window

These are the operating system's own shortcuts, not Meridian's — they are not
generated from the command list above, because Meridian is not what runs
them. They work because the window is a normal, resizable one, and they are
listed separately at the bottom of Help → Keyboard Shortcuts because they are
just as worth knowing.

**On macOS** (System Settings → Desktop & Dock → Windows), the Globe/fn key
tiles the window without leaving it windowed:

| Do this | Press |
|---|---|
| Fill the screen | fn ⌃F |
| Left half / right half | fn ⌃← / fn ⌃→ |
| Top half / bottom half | fn ⌃↑ / fn ⌃↓ |
| Centre | fn ⌃C |
| Undo the last tile | fn ⌃R |

A keyboard with no Globe key cannot send those. Meridian's own **Window →
Move & Resize** menu offers the same six on ⌘⌃ instead (⌘⌃↩ fills, ⌘⌃← /
⌘⌃→ / ⌘⌃↑ / ⌘⌃↓ for the halves, ⌘⌃C to centre, ⌘⌃R to undo) — pick whichever
your keyboard has.

**On Windows**, the same shapes are Snap, built into every window:

| Do this | Press |
|---|---|
| Maximise | ⊞ Win + ↑ |
| Restore / minimise | ⊞ Win + ↓ |
| Left half / right half | ⊞ Win + ← / ⊞ Win + → |
| Move to the other monitor | ⊞ Win + ⇧ + ← / ⊞ Win + ⇧ + → |

## Lists

A list shows one row per record. Every list works the same way.

- **Columns** — the button above the grid lets you choose which columns
  appear, and in what order. Your choice is remembered per list, on this
  computer.
- **Sorting** — click a column heading. Click again to reverse it.
- **Filtering** — the filter row builds conditions: field, operator, value.
  Several conditions are combined with AND.
- **Searching** — the box above the list does a full-text search across the
  fields that make sense for that record.
- **Saved searches** — once you have a filter and a set of columns you want
  again, save it. It appears in the dropdown above the list, and can be shared
  with everybody or kept to yourself.
- **Exporting** — any list, exactly as you are looking at it, as CSV or as a
  formatted Excel workbook.

Click a row to open the record.

## Records

A record page shows one thing — a customer, an item, an invoice — in
sections, with the things related to it underneath. A customer shows their
contacts, their opportunities, their open cases and their transactions. An
item shows its stock by location, its price levels and its movement history.

**Editing.** Click **Edit**, change what you need, click **Save**. Fields that
cannot be edited — a document number, a posted total — are shown but greyed.

**Documents are different.** An invoice, a bill, a payment or a journal entry
that has been posted to the ledger cannot be edited, because editing it would
silently restate a period that has already been reported. Instead:

- To cancel it — **void** it. Meridian posts an exact reversal, and both the
  original and the reversal stay on the record.
- To change it — void it and enter it again, or raise the document that
  corrects it: a credit memo against an invoice, a vendor return against a
  bill.

**The audit trail.** Every record has one. It shows who changed what, when,
and what the value was before. It cannot be edited or switched off.

## Transactions

Sales and purchase documents flow into one another rather than being typed
twice. A quote becomes a sales order; an order becomes a fulfilment and an
invoice; a purchase order becomes an item receipt and then a bill. Open the
source document and use **Create from this** — the new document arrives with
the lines, quantities and prices already on it, and the source remembers how
much of it has been used.

Every posted document links to the journal entry it produced. Open any
transaction and click through to the entry to see exactly what it did to the
ledger.

## Notifications and approvals

The bell in the top bar collects things waiting for you: documents pending
your approval, workflow messages, and anything a scheduled process wants you
to know. Approval rules are set up under Setup; a document that matches one is
held at *pending approval* and cannot post until somebody with the right role
approves it.

## Personalising it

**Settings → Appearance** is where Meridian is made to look like something you
want to spend eight hours in. Everything here is stored per person on this
computer, so two people sharing a machine get their own, and none of it
touches your company's data.

**Look** comes first: **Glass**, a softer, translucent shape with springy
motion (the default), or **Dock**, a flatter, darker instrument-panel style
with pill controls. Colour and typeface below apply to either.

**Colour scheme** — six of them, and they are complete palettes rather than
tints:

| | |
| --- | --- |
| **Obsidian & Indigo** | Midnight chrome, electric indigo accent. The default. |
| **Carbon & Cobalt** | Cool graphite chrome, vivid cobalt accent. |
| **Ink & Brass** | Warm paper, near-black chrome, brass. |
| **Graphite & Green** | Warm stone with a forest green. |
| **Slate & Teal** | Cool slate with a deep teal. |
| **Midnight & Indigo** | Drawn for dark, with a light cut derived from it. |

Each has its own light and dark version, so the colour scheme and the
**theme** below it are separate choices — the green palette in dark mode is a
thing you can have.

In all six, the sidebar and top bar are dark and the page is not. That is
deliberate: it stops the navigation competing with the numbers for your
attention, and it is most of why the application reads as an instrument
rather than a web page.

**Typeface** — seven pairings:

| | |
| --- | --- |
| **Styrene & Tiempos** | Styrene for the interface, Tiempos for titles. The default. Meridian has no licence to bundle either, so this names them and falls back to Manrope and Plex Serif on a machine that does not have them installed, which in practice is most machines. |
| **Manrope** | Geometric and modern, paired with Fira Code for account codes and SKUs. |
| **IBM Plex** | Engineered and slightly technical, with Plex Mono for account codes and SKUs. |
| **Source Sans** | Humanist and warmer, paired with JetBrains Mono. |
| **Inter** | Neutral, drawn for screens, very steady at small sizes. |
| **Plex Serif titles** | Serif page titles and headline figures over the same sans body. |
| **SF Pro** | macOS's own system font — not a font Meridian ships, but the copy already on the Mac, so it always matches whatever build of it the OS itself is running. On anything else it quietly becomes that platform's own interface font instead. |

All but Styrene & Tiempos and SF Pro ship inside the application, so they work with no
network and tell nobody outside this machine that you opened the books.
Each brings its own type scale — the same pixel size reads differently in
different families, so picking a typeface adjusts the sizes with it rather
than leaving the others slightly wrong.

**Density** is worth trying: compact fits about a third more rows on a screen
without hiding anything.

If you would rather try them than read about them, the command palette has
**Next colour scheme** and **Next typeface**, which cycle through without
leaving the screen you are on.

**Settings → Behaviour** sets which screen Meridian opens on, how many rows a
list loads, and whether it warns you before you leave a form with unsaved
changes.

The dashboard itself is arrangeable: drag the cards, and use **Add widget** to
put on the figures you actually watch.
