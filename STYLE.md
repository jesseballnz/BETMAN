# Betman Style Guide

## Brand Overview
Betman is a bold, modern betting brand with a dark blue interface and neon-lime accents. The visual style should feel sharp, high-contrast, digital, and confident.

---

## Core Brand Colors

### Primary Accent
- **Betman Neon Green:** `#C5FF00`
- **RGB:** `197, 255, 0`
- **HSL:** `74, 100%, 50%`

Use for:
- primary CTAs
- active states
- highlights
- icons
- logo accents

### Hover / Pressed Green
- **Hover Green:** `#AEE600`

Use for:
- button hover
- selected controls
- active nav indicators

### Glow Green
- **Glow Green:** `#E6FF66`

Use for:
- neon glow
- focus effects
- highlight shadows
- premium accents

### Background
- **Primary Background Blue:** `#0F2A44`

Use for:
- app background
- header/footer areas
- cards and panels where dark contrast is needed

### Border / Secondary UI
- **Border Blue:** `#6B8AA5`

Use for:
- soft dividers
- outline buttons
- muted structural elements

### Text Colors
- **Primary Text:** `#FFFFFF`
- **Secondary Text:** `#B8C4D1`
- **Muted Text:** `#8A98A8`

---

## Logo Guidance

### Logo Direction
- The Betman logo uses a **stylized horseshoe-shaped "B"**
- The rest of the wordmark is **ETMAN**
- Preferred accent color is **neon green**
- Use a **clean dark blue background** or transparent background depending on implementation

### Logo Usage
Preferred:
- Green logo on dark blue background
- Transparent export for UI overlays
- Large clear spacing around logo

Avoid:
- placing logo on busy backgrounds
- using weak contrast
- recoloring logo with unrelated hues
- stretching, squashing, or adding random effects

---

## Visual Style

### Brand Personality
- high energy
- sharp
- modern
- premium betting UI
- gaming-adjacent
- dark mode first

### Design Keywords
- neon
- sporty
- crisp
- bold
- digital
- minimal but punchy

### Shapes
- rounded corners should be subtle, not soft
- use clean panels and sharp horizontal alignment
- glow effects should be controlled, not excessive

---

## Typography

### Style
Use bold, modern sans-serif fonts with strong uppercase support.

Recommended characteristics:
- geometric or athletic sans-serif
- slightly condensed for headings
- strong readability at small sizes
- clean numerals for odds, prices, and metrics

### Hierarchy
- **Headings:** bold, uppercase or sentence case, tight spacing
- **Body text:** clean and readable
- **Buttons:** bold, high contrast
- **Data / odds:** tabular-friendly where possible

Suggested font categories:
- headings: bold display sans
- UI/body: clean modern sans

---

## UI Components

### Primary Button
- Background: `#C5FF00`
- Text: `#0F2A44`
- Hover: `#AEE600`
- Optional glow: `0 0 16px rgba(197, 255, 0, 0.35)`

### Secondary Button
- Background: transparent
- Border: `#6B8AA5`
- Text: `#FFFFFF`

### Panels / Cards
- Background: `#0F2A44`
- Border: subtle line using `#6B8AA5` at low opacity
- Keep internal spacing generous and clean

### Inputs
- Dark background
- Clear border contrast
- Green focus ring using `#C5FF00`

---

## Effects

### Glow
Use green glow sparingly for:
- active buttons
- selected tabs
- logo accents
- important status highlights

Recommended:
- `box-shadow: 0 0 20px rgba(197, 255, 0, 0.25);`

### Gradients
Use only when needed.
Preferred green gradient:
- `#E6FF66 -> #C5FF00 -> #AEE600`

Example:
```css
background: linear-gradient(90deg, #E6FF66 0%, #C5FF00 50%, #AEE600 100%);
