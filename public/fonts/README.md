# Fonts

The UI uses two licensed typefaces. Neither is committed (this repository is public), so each
machine supplies its own copies here. Missing files fall back gracefully.

| Role | Family | Files expected here | Fallback |
|---|---|---|---|
| Primary: headlines, Polty's voice, conversation | Tiempos (Klim), Regular weight only | `TiemposHeadline-Regular.woff2`, `TiemposText-Regular.woff2` | Georgia / system serif |
| Body: controls, labels, data | Maison Neue (Milieu Grotesque): Book, Medium, Demi | `MaisonNeue-Book.woff2`, `MaisonNeue-Medium.woff2`, `MaisonNeue-Demi.woff2` | Geist |

`.woff2`, `.woff`, `.otf` and `.ttf` all work. A copy installed on the machine is also picked up
through `local()`. The `@font-face` rules are generated in `src/app/fonts.ts`, which only
references files that exist, so a missing font never causes a 404.

The Klim *test* fonts cover only A–Z, a–z, 0–9, space, comma, hyphen and period; other characters
fall back to the next serif in the stack. Klim test fonts are licensed for testing only — buy a
licence before shipping.
