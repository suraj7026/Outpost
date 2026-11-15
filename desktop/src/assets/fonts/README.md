# Bundled app fonts

The app uses **Google Sans Flex**, then **Google Sans**, then the system sans-serif for unsupported characters or unavailable font resources. Both families are bundled locally; the app makes no font/CDN requests. Original variable axes and glyph coverage are retained, including Google Sans's additional language coverage. Google Sans italic is bundled for fallback emphasis.

Sources are the Google Fonts repository (`google/fonts`). Downloaded files were checked against these upstream Git blob SHA-1 identifiers before WOFF2 compression:

| Local file | Upstream path | Git blob |
| --- | --- | --- |
| GoogleSansFlex.woff2 | `ofl/googlesansflex/GoogleSansFlex[ROND,opsz,slnt,wdth,wght].ttf` | `1d8d8ae5a7c6d0e48312d2a0a478bad92caee73a` |
| GoogleSans.woff2 | `ofl/googlesans/GoogleSans[GRAD,opsz,wght].ttf` | `a5e76cc713206f1cfe9a7fc31cc1b6f035034d81` |
| GoogleSans-Italic.woff2 | `ofl/googlesans/GoogleSans-Italic[GRAD,opsz,wght].ttf` | `251bc21aa4c958e63fa192e685396fb810625090` |

Source directories:
- https://github.com/google/fonts/tree/main/ofl/googlesansflex
- https://github.com/google/fonts/tree/main/ofl/googlesans

Only the container format was changed, using `fonttools ttLib.woff2 compress INPUT.ttf -o OUTPUT.woff2`. No glyph subsetting, name changes or axis instancing was performed. FontTools is not a build/runtime dependency; the resulting assets are included in the source tree.

The fonts are distributed under the SIL Open Font License 1.1. Copyright/license and trademark notices are in `desktop/public/font-licenses/` and copied into every frontend/app build. Their use does not imply Google sponsorship or affiliation.
