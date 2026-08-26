---
name: Somni Nocturnal Mission Control
colors:
  surface: '#131315'
  surface-dim: '#131315'
  surface-bright: '#39393b'
  surface-container-lowest: '#0e0e10'
  surface-container-low: '#1b1b1d'
  surface-container: '#201f21'
  surface-container-high: '#2a2a2c'
  surface-container-highest: '#353437'
  on-surface: '#e5e1e4'
  on-surface-variant: '#c9c4d6'
  inverse-surface: '#e5e1e4'
  inverse-on-surface: '#313032'
  outline: '#928e9f'
  outline-variant: '#474554'
  surface-tint: '#c8bfff'
  primary: '#c8bfff'
  on-primary: '#2c009e'
  primary-container: '#6d5ae0'
  on-primary-container: '#f7f2ff'
  inverse-primary: '#5c47ce'
  secondary: '#c8c5cb'
  on-secondary: '#303034'
  secondary-container: '#47464b'
  on-secondary-container: '#b6b4b9'
  tertiary: '#ffb875'
  on-tertiary: '#4b2800'
  tertiary-container: '#a55e00'
  on-tertiary-container: '#fff2e9'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e5deff'
  primary-fixed-dim: '#c8bfff'
  on-primary-fixed: '#190064'
  on-primary-fixed-variant: '#432bb5'
  secondary-fixed: '#e4e1e7'
  secondary-fixed-dim: '#c8c5cb'
  on-secondary-fixed: '#1b1b1f'
  on-secondary-fixed-variant: '#47464b'
  tertiary-fixed: '#ffdcc0'
  tertiary-fixed-dim: '#ffb875'
  on-tertiary-fixed: '#2d1600'
  on-tertiary-fixed-variant: '#6b3b00'
  background: '#131315'
  on-background: '#e5e1e4'
  surface-variant: '#353437'
  border-subtle: '#252529'
  surface-elevated: '#161618'
  status-queued: '#3F3F46'
  status-running: '#6d5ae0'
  status-completed: '#10B981'
  status-failed: '#EF4444'
  status-skipped: '#71717A'
  status-cancelled: '#F59E0B'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  mono-label:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.05em
  mono-code:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  sidebar-width: 240px
  editor-panel-width: 340px
  gutter: 1rem
  margin-page: 2rem
  stack-gap: 0.75rem
  card-padding: 1rem
---

## Brand & Style

The design system embodies a "Nocturnal Mission Control" aesthetic—a calm, dark-first environment optimized for solo developers managing complex asynchronous tasks. The emotional goal is to evoke a sense of quiet productivity and restful automation. While the developer sleeps, the system works.

The visual style is a blend of **Minimalism** and **High-Contrast Dark Mode**. It uses a "low-chrome" approach where structural elements like borders and backgrounds are near-black to reduce eye strain and visual noise. The single vibrant purple accent acts as a beacon for intentional human action, ensuring that in a dense information environment, the "what next" is always clear.

Key principles:
- **Restful Density:** High information density achieved through clean typography and tight spacing, without feeling cluttered.
- **Intentionality:** Human-triggered actions (Ticks, Promotes, Drains) are visually prioritized over automated states.
- **Asynchronous Trust:** Real-time feedback (pulsing animations, streaming logs) provides confidence in the "background" nature of the app.

## Colors

The palette is strictly dark-first to maintain the "Nocturnal" narrative. Backgrounds use a deep charcoal/near-black base to make the content feel like it's floating in a void. 

- **Primary Purple (#6d5ae0):** Reserved for active intent—"Run", "Apply", and "Drain". It is also used as a pulsing indicator for the "Running" state.
- **Semantic Scale:** Statuses use a clear, universally understood color language. 
    - **Queued** is muted gray, representing potential energy.
    - **Running** adopts the brand purple, often with a subtle glow or pulse.
    - **Completed/Failed/Error** use high-contrast success and danger colors.
- **Borders:** Subtle grays (#252529) define the layout without adding "chrome" weight.

## Typography

This design system utilizes a dual-font approach. **Inter** provides high legibility for UI controls, outcome statements, and navigation. **JetBrains Mono** is introduced for technical metadata, agent roles, and streaming logs to reinforce the "Engineer" mode and the developer-centric nature of the tool.

- **Scale:** Keep sizes small to maintain density. 14px is the standard body size.
- **Hierarchy:** Use font weight and color (white vs. zinc-400) rather than large size increases to differentiate information levels.
- **Labels:** Mono-spaced labels should be in uppercase with slight letter spacing for a technical "Mission Control" feel.

## Layout & Spacing

The layout uses a structured, fixed-sidebar model typical of macOS desktop applications but with a refined, low-profile sidebar (no background color, just a subtle right border).

- **Grid:** Content follows a single-column stack within the main area, maximizing readability for lists and logs.
- **Reflow:** When the "Draft with AI" or "Workflow Editor" chat is active, the main content area compresses to accommodate a fixed 340px side panel.
- **Density:** Components are tightly packed (12px gap) to allow the user to see the entire status of their "Nightly Drain" without excessive scrolling.

## Elevation & Depth

Depth is conveyed through **Tonal Layering** rather than heavy shadows. In a dark-first mission control, light is used sparingly.

- **Level 0 (Base):** The #0D0D0F background.
- **Level 1 (Cards/Sidebar):** A slightly lighter #161618 surface with a 1px #252529 border.
- **Interaction:** Hovering over a card or row should brighten the border color or provide a very subtle background tint rather than an offset shadow.
- **Active States:** The "Running" task card may use a subtle outer glow of the purple accent color to denote activity.

## Shapes

The design system uses a consistent **Rounded (0.5rem)** logic for cards and containers, balanced with **Pill-shaped (Full radius)** elements for status chips and primary action buttons.

- **Cards:** 8px (0.5rem) corner radius.
- **Inputs/Chips:** 9999px (Pill) for status indicators and high-level option chips in the AI interview flow.
- **Buttons:** Primary buttons are pill-shaped; secondary "utility" buttons (e.g., reorder arrows) are 4px or 6px soft squares.

## Components

### Buttons & Actions
- **Primary:** Pill-shaped, solid purple (#6d5ae0) with white text. Reserved for "Run", "Drain", "Apply".
- **Secondary/Ghost:** Subtle border with no background, used for "Cancel", "Backlog", or "Settings".
- **Reorder Controls:** Minimalist ghost icons that appear on hover within workflow task cards.

### Cards & Workflow Items
- **Status Chips:** Pill-shaped, using the semantic color scale for text and a low-opacity background of the same hue.
- **Task Cards:** Contain a mono-spaced role badge, a title, and a prompt snippet. When "Running", the card border pulses purple.
- **Outcome Preview:** Collapsible "Brief" cards use a distinctive subtle background pattern or a left-accent border to signify their read-only, source-of-truth status.

### Unified Chat Experience
- **Draft & Sidebar Editor:** Both use the same chat bubble style. User bubbles are right-aligned and ghost-bordered; AI bubbles are left-aligned with a subtle surface fill.
- **Interview Flow:** Questions are presented as a single card with a horizontal scroll or wrap of clickable pill-chips for "Recommended" options.

### Pipeline & Progress
- **Progress Bar:** High-contrast purple on a dark track. 4px height for a sleek, precise look.
- **Live Logs:** Monospaced text on a true-black background (#000000) within a rounded card, supporting ANSI color codes for terminal-like output.