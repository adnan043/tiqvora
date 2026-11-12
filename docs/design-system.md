# Design system

The help desk is ONE product: the public help center, the chat widget and the dashboard
share the same tokens, the same classes and the same components. This file is the
reference every change follows. It sits on top of the template's rules in
`docs/agent/ui.md` (kit, CSP, no second UI library), which still apply.

**Rule above all:** consistency beats effects. A missing piece is added ONCE (a component
in `src/portal/ui/`, or one shared class in `src/styles/global.css`) from these tokens, then
reused. Never a slightly different copy inside a screen.

| Layer | File |
| --- | --- |
| Tokens (light + dark) | `src/styles/global.css` `:root` |
| Public + widget classes | `src/styles/global.css` |
| Dashboard classes | `src/styles/app.css` (a screen's own CSS at the end, scoped under its root class) |
| Home page | `src/styles/home.css` |
| Components | `src/portal/ui/*.tsx`, imported from `'../ui'`, shown at `/dashboard/components` |
| Status → tone map | `src/lib/helpdesk-tones.ts` |

## Tokens

Use nothing else. Every colour token has a dark value (`:root[data-theme='dark']` and the
`prefers-color-scheme: dark` block); non-colour tokens are the same in both themes.

### Colour
| Group | Tokens | Use |
| --- | --- | --- |
| Primary (brand) | `--accent`, `--accent-hover`, `--accent-soft`, `--accent-text`, `--accent-ink` | primary buttons, links, focus ring, active nav, the widget launcher. Rebrand by changing only these, in both themes. |
| Secondary | `--secondary-bg`, `--secondary-border`, `--secondary-ink` | secondary buttons, neutral chips. Never a second brand colour. |
| Neutral | `--bg`, `--surface`, `--card`, `--ink`, `--muted`, `--subtle`, `--line`, `--line-strong`, `--hover` | page, panels, text levels (ink > muted > subtle), borders |
| Status | `--success`, `--warning`, `--danger`, `--info` + `-soft` fills, `--danger-hover` | state only, never decoration |
| On-colour | `--on-danger` (text on a solid danger fill), `--scrim` / `--on-scrim` (veil over a cover image and its text) | |
| Depth | `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--overlay` | cards / menus / dialogs; `--overlay` behind drawers and modals |

### Control heights
`--control-sm: 32px`, `--control: 40px`, `--control-lg: 48px`.
EVERY button, input, select, search box, segmented control, tab, nav item, menu item and
chat composer uses one of the three (as `min-height`). Default is `--control`.
`--control-lg` only for the help-center hero search and the widget's main buttons on a phone.
`--control-sm` for compact buttons, segments and the public header nav.
Textareas: `min-height: calc(var(--control) * 2.5)`.

### Radius
| Token | For |
| --- | --- |
| `--radius-sm` 8px | controls: buttons, inputs, selects, form chips, nav items, menu items |
| `--radius` 12px | cards, drawers, the widget panel, chat bubbles |
| `--radius-lg` 16px | modals, the hero search card |
| `--radius-pill` 999px | badges and quick-reply chips only |

`50%` is fine for circles (avatars, dots).

### Spacing (4px base)
`--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 20 ·
`--space-6` 24 · `--space-8` 32 · `--space-10` 40 · `--space-12` 48 · `--space-16` 64.
The only values for `margin`, `padding` and `gap` (negative: `calc(-1 * var(--space-x))`).

`--space-0-5` (2px) is one extra hairline step, added because the template had 1–3px
optical values (inline code padding, link-button padding, icon nudges) that 0 or 4px would
visibly break. Use it only for those; never for layout.

Fluid section spacing stays on tokens: `clamp(var(--space-10), 8vw, var(--space-16))`.

### Type
| Size | Leading | Value |
| --- | --- | --- |
| `--text-xs` | `--leading-xs` | 12 / 16 |
| `--text-sm` | `--leading-sm` | 13 / 20 |
| `--text-md` | `--leading-md` | 15 / 24 |
| `--text-lg` | `--leading-lg` | 17 / 28 |
| `--text-xl` | `--leading-xl` | 20 / 28 |
| `--text-2xl` | `--leading-2xl` | 24 / 32 |
| `--text-3xl` | `--leading-3xl` | 30 / 38 |
| `--text-4xl` | `--leading-4xl` | clamp(32px, 4vw, 44px) / 1.15 |

Set a size with its leading (`font-size: var(--text-md); line-height: var(--leading-md);`)
unless the rule needs a tighter line (e.g. `line-height: 1` in a control).

Weights: `--weight-regular` 400 (body), `--weight-medium` 500 (labels, nav, table
headers), `--weight-semibold` 600 (headings, buttons), `--weight-bold` 700 (only the public H1).

Fonts: `--font-sans` (Inter) for everything; `--font-mono` only for ticket numbers and code.
`--font-display` is an alias of `--font-sans`.

### Layout and breakpoints
`--container: 1160px` (public pages, `.wrap`), `--container-narrow: 720px` (article bodies, the
help-center search column, `.wrap.narrow`), `--gutter` (24px; 16px at ≤ 640px).

Breakpoints: **640px** (phone), **1024px** (tablet), **1280px** (wide). Media queries can't read
custom properties, so write the numbers: `@media (max-width: 640px)`, `(max-width: 1024px)`,
`(max-width: 1280px)`; the matching `min-width` is 641 / 1025 / 1281. No other breakpoints.

## Type roles
| Role | Size | Weight |
| --- | --- | --- |
| Public H1 (help-center home, article title) | `--text-4xl` | bold |
| Public H2 / section title | `--text-3xl` | semibold |
| Dashboard screen title (top bar `<h1>`) | `--text-xl` | semibold |
| Dashboard `PageHeader` `<h2>` | `--text-2xl` | semibold |
| Card title, drawer title, widget header | `--text-lg` | semibold |
| Body: UI text, table cells, chat messages | `--text-md` | regular |
| Article reading text | `--text-lg` | regular |
| Buttons, field labels | `--text-md` | semibold / medium |
| Nav, table headers | `--text-sm` | medium |
| Hints, timestamps, captions, badges | `--text-sm` / `--text-xs` | regular / medium |

## Spacing roles
- Card padding `--space-5` (phone `--space-4`); gap between cards `--space-6` (phone `--space-4`).
- Form: label → input `--space-2`; field → field `--space-4`; form → its buttons `--space-6`;
  buttons in a row `--space-3`.
- Dashboard: `PageHeader` → first card `--space-6`; table cells `--space-3` × `--space-4`.
- Public sections: `--space-16` apart on desktop, `--space-10` on phones.
- Chat: bubble padding `--space-3` × `--space-4`; between messages `--space-3`; between turns
  of different senders `--space-5`.

## Components
Import from `'../ui'`. Usage examples live in `src/portal/screens/components.tsx`.

### The kit (use as they are)
| Need | Component |
| --- | --- |
| Screen head, one primary action | `PageHeader` |
| Panel / settings | `Card` (`flush` for edge-to-edge tables), `SettingRow` |
| Numbers, charts | `Stat`, `Sparkline`, `BarChart`, `ProgressBar` (no chart library) |
| Lists | `DataTable` + `LoadMore` (cards on a phone; loading / empty / error built in) |
| People | `Avatar`, `Person` (a name, never an email unless `site:user:read`) |
| Labels | `Badge`, `StatusBadge` with a tone from `helpdesk-tones.ts` |
| Actions | `Button` (primary / secondary / ghost / link / danger, `pending`), `IconButton` (`label` required), `Menu` for row actions |
| Fields | `Field`, `useForm`, `Select`, `Checkbox`, `Switch`, `RadioCards`, `PasswordInput` |
| Filters | `SearchInput`, `SegmentedControl`, `Select` in one `.toolbar` row |
| Views | `Tabs` |
| Dialogs | `Modal` (short task), `Drawer` (create / edit / details), `useConfirm` (destructive) |
| Feedback | `useToast`, `Notice`, `ErrorNote`, `EmptyState`, `Skeleton`, `LoadingBlock` |
| Icons | `<Icon name>` from `ICON_NAMES` (add paths from lucide.dev to `ui/icon.tsx`) |

### Help desk pieces (added once, reused everywhere)
| Component | File | Use it for |
| --- | --- | --- |
| `ChatMessage` | `ui/chat.tsx` | one message in a thread: `customer` (soft bubble), `ai` (plain text, no bubble), `agent`, `note` (internal, `--warning-soft`) |
| `TimelineEvent` | `ui/chat.tsx` | small grey status lines in a thread ("Assigned to Sam", "Marked solved") |
| `CitationList` | `ui/chat.tsx` | the "Sources" under an AI answer: short list of article links |
| `ConfidenceBadge` | `ui/chat.tsx` | the AI's confidence (high / medium / low / none), tone from `CONFIDENCE_TONES` |
| `Composer` | `ui/composer.tsx` | the reply box: textarea + send, `--control` tall when empty, grows to 6 lines; Reply / Note toggle in the inbox |
| `ConversationListItem` | `ui/composer.tsx` | a row in the inbox's ticket list or "My support": customer, subject, status, priority, age |
| `TicketMeta` | `ui/helpdesk.tsx` | the details pane: status, priority, assignee rows |
| `ArticleEditor` | `ui/helpdesk.tsx` | Markdown textarea with Write / Preview tabs; the preview is HTML that went through `sanitizeHtml` (no rich-text library) |

### Status tones (`src/lib/helpdesk-tones.ts`)
Mapped once; every screen and the widget import these, never their own map.

| Kind | Mapping |
| --- | --- |
| Ticket status | waiting → info, open → brand (accent), pending → warning, solved → success |
| Priority | urgent → danger, high → warning, normal / low → neutral |
| AI confidence | high → success, medium → warning, low / none → danger |
| Article status | published → success, draft → neutral, archived → neutral |

Each map has a `*_LABELS` partner: colour is never the only signal.

### Public pages and the widget
They are not React, so they use the SAME classes from `global.css` with the same tokens:
`.button` (+ `.button-secondary`, `.button-ghost`, `.button-link`, `.button-danger`,
`.button-sm`, `.button-lg`), `.field` inputs, `.form`, `.card`, `.badge`. A public button and a
dashboard button look identical, height included. The widget builds its DOM with
`textContent` and classes only (no inline styles: the CSP blocks them).

## Allowed exceptions
- White (`#ffffff`) for the switch knob and behind QR codes, both themes (`docs/agent/ui.md`).
- Inline `code` sized in `em` (`0.85em`, `0.9em`) so it scales with the paragraph around it.
- `1px` borders, dividers and visually-hidden boxes; `2–3px` focus rings and progress bars.
- Fixed box sizes of icons, avatars, dots and icon tiles (they are not spacing or controls).
- Dashboard content max width (`.app-content`) and readable text widths in `ch` / `rem`.

Anything else raw is a bug.

## Layout patterns
- **Help-center home:** one centred title (`--text-4xl`), one large search box
  (`--control-lg`, `--radius-lg`), categories as a card grid (3 columns desktop, 2 tablet,
  1 phone), then popular articles as a plain list with chevrons. No hero image, no gradients.
- **Article page with the assistant:** left category nav (desktop only), reading column at
  `--container-narrow`, breadcrumb above the title, "Ask the assistant" in the header opens
  the chat as a right side sheet on desktop, full screen on phones.
- **AI answer:** the answer as plain text (no bubble for the AI, a soft bubble for the
  customer), then `CitationList`, then thumbs up / down and "Talk to a person", the line
  "Answers come from our help center and can be wrong", and up to 3 follow-up chips
  (`--radius-pill`).
- **Agent inbox:** three panes on desktop (list 320px · thread · details 300px), two on
  tablet (details in a `Drawer`), one at a time on phones with a back button. Reply / Note
  toggle on the `Composer`; notes on `--warning-soft`; status changes as `TimelineEvent`s.
- **Ticket list:** filters in ONE `.toolbar` row (`SearchInput` + `SegmentedControl` +
  `Select`s), all `--control` tall.

## Responsive and accessible
- Check every page and screen at 390, 768, 1024 and 1440px, light and dark: no sideways
  scroll, no overlapping text, tap targets ≥ 40px, tables become cards on phones.
- Contrast WCAG AA: 4.5:1 body text, 3:1 large text and controls, both themes.
- Visible focus ring (`--accent`) on everything focusable; dialogs trap and return focus;
  Esc closes; `Tabs`, `SegmentedControl` and `Menu` move with arrow keys.
- Motion 150–200ms ease for hover, open and close only; respect `prefers-reduced-motion`.

## Checking a change
`npm test` enforces the tokens: `tests/design-tokens.test.ts` fails on any raw spacing, font size,
radius or weight, any hex outside the `:root` token blocks (bar the documented exceptions), any
breakpoint other than 640 / 1024 / 1280, and any light colour token with no dark value. Its
failure lists `file:line` for each one. Two checks it can't make, run from the repository root:

```bash
# control heights that are not one of the three tokens
grep -nE '^\s*min-height:\s*(3[0-9]|4[0-9])px' src/styles/*.css

# inline styles in the dashboard (the CSP blocks them)
grep -rn 'style={' src/portal
```

Then compare the sign-in page, a dashboard screen and `/dashboard/components` side by side at
390 and 1440px: inputs and buttons must be the same height, radius and font everywhere.
