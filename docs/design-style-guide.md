# Design Style Guide

This app uses an Organic / Natural visual language. Future UI work should preserve this style unless the product direction changes.

## Design Philosophy

This style embraces wabi-sabi: warmth, softness, natural connection, and a sense of tactile imperfection. It should feel grounded, calming, handcrafted, and human.

Core signature:

- Soft, amorphous blob shapes with varied organic border radii, such as `60% 40% 30% 70% / 60% 30% 70% 40%`.
- Subtle grain/noise texture at low opacity with multiply blend mode to create a paper-like surface.
- Earth-drawn colors inspired by forest floors, clay pottery, unbleached paper, dried grass, and river stones.
- Soft, diffused shadows with natural color tints instead of pure black.
- Warm serif headings paired with a rounded sans-serif body font.

Principles:

- Avoid sharp 90-degree visual language where possible. Elements should feel softened by hand, wind, or water.
- Use generous whitespace, staggered grids, varied radii, and intentional asymmetry.
- Interactions should be gentle and natural: subtle lift, scale, and softened easing.
- Build atmospheric depth with blurred blobs, translucent overlays, and soft shadows.

## Tokens

### Colors

- `background`: `#FDFCF8` (Rice Paper)
- `foreground`: `#2C2C24` (Deep Loam / Charcoal)
- `primary`: `#5D7052` (Moss Green)
- `primary-foreground`: `#F3F4F1` (Pale Mist)
- `secondary`: `#C18C5D` (Terracotta / Clay)
- `secondary-foreground`: `#FFFFFF`
- `accent`: `#E6DCCD` (Sand / Beige)
- `accent-foreground`: `#4A4A40` (Bark)
- `muted`: `#F0EBE5` (Stone)
- `muted-foreground`: `#78786C` (Dried Grass)
- `border`: `#DED8CF` (Raw Timber)
- `destructive`: `#A85448` (Burnt Sienna)
- `surface`: `#FEFEFA`

### Typography

- Headings: `Fraunces`, with weights 600-800.
- Body: `Nunito`, with rounded terminals.
- Scale: moderate, approximately 1.25.

### Radius And Shape

- Standard radius: 16px to 32px.
- Use organic blob radii for hero media, decorative shapes, and key cards.
- Prefer soft, slightly imperfect borders over hard geometry.

### Shadows

- Moss shadow: `0 4px 20px -2px rgba(93, 112, 82, 0.15)`.
- Clay float shadow: `0 10px 40px -10px rgba(193, 140, 93, 0.2)`.
- Avoid pure black shadows.

## Component Direction

### Buttons

- Use pill shapes.
- Primary buttons use moss green with pale mist text.
- Outline buttons use terracotta borders and text.
- Hover states gently scale and deepen the soft shadow.
- Active states compress slightly for tactile feedback.
- Keep touch targets at least 44px high.

### Cards And Containers

- Use very light warm surfaces over the rice paper page background.
- Use soft timber borders at partial opacity.
- Use asymmetric corner radii for featured cards.
- Cards may lift slightly on hover.

### Inputs

- Use pill shapes, warm translucent backgrounds, and timber borders.
- Focus states should be visible but soft, using a moss-tinted ring.

### Navigation

- Prefer sticky, floating pill navigation with translucent background, backdrop blur, soft border, and subtle shadow.

## Layout And Spacing

- Use responsive, mobile-first layouts.
- Common section padding: large vertical rhythm with compact horizontal padding.
- Favor generous gaps: 32px, 48px, and 64px.
- Container widths should vary by purpose:
  - Primary content: `max-width: 80rem`.
  - Focused content: `max-width: 72rem`.
  - Intimate content: `max-width: 64rem`.
  - Text-heavy content: `max-width: 48rem`.

## Distinctive Details

- Use large blurred blob backgrounds as ambient color washes.
- Use rotated media frames and organic image masks where appropriate.
- Vary card radii across repeated cards.
- Use curved or hand-drawn-feeling connectors instead of mechanical straight lines where useful.
- Consider subtle hover rotations for testimonial or note-like cards.
- Alternate section backgrounds between off-white, stone tint, sand tint, moss, and terracotta.

## Motion

- Transitions should be gentle: 300-700ms.
- Avoid harsh snaps.
- Respect `prefers-reduced-motion`.

## Accessibility

- Preserve strong contrast:
  - Foreground on background should remain AAA-level.
  - Moss on background should remain AA-level.
  - Muted text on background should remain AA-level.
- Use visible focus states.
- Keep semantic HTML and proper heading hierarchy.
- Ensure all controls are keyboard accessible.
