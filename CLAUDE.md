# porta-git-manager

Ekstensi Porta, vanilla JS (tanpa bundler, tanpa dependency). Package manager: npm.

## Validasi
`.claude/validate.sh` (FORCE=1 untuk paksa) = `npm test` (node --test). Tidak ada lint/typecheck/build.

## Gotcha
- `app.js` (UI) berjalan di WebView Porta dan tidak punya test headless; logika murni ada di `*-util.js` dan dites di `test/`.
- Rilis/CHANGELOG hanya atas permintaan eksplisit user.
