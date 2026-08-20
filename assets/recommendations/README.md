# Testimonial & promo videos

Drop the customer testimonial videos and the investment promo video here. On
startup the bot scans this directory, uploads each video to Meta, and caches the
returned `media_id` (see `src/whatsapp/mediaCache.ts`). Unchanged files reuse
their cached id; changed or expired ones are re-uploaded automatically. This runs
in the background and never delays a customer conversation.

## Sidecar metadata

Each video needs a sidecar JSON file with the same base name — e.g.
`neve-zeev-story.mp4` → `neve-zeev-story.json`:

```json
{
  "type": "testimonial",
  "neighborhoods": ["שכונה ט׳"],
  "audience": "seller"
}
```

- **type**: `testimonial` (a customer recommendation) or `promo_investment`
  (the investment promo).
- **neighborhoods**: canonical Be'er Sheva neighborhood names this video targets.
  Leave empty (`[]`) for a general testimonial. Neighborhood-specific videos are
  preferred over general ones when a lead's neighborhood matches.
- **audience**: `seller`, `buyer`, or `investor`.

Supported video formats: `.mp4`, `.webm`, `.mov`, `.3gp`. A video without a valid
sidecar is skipped (and logged).

Video files themselves are intentionally not committed to the repository.
