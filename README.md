# Position Drill

A static GitHub Pages app for drilling backgammon checker-play and cube-decision errors from Extreme Gammon (`.xg` / `.xgp`) files.

## Repository structure

Position Drill is self-contained in this repository. Source game files, the XG parser, generated data, board SVGs, and the web UI are all built and deployed together.

- `imports/` — source XG/XGP files
- `scripts/build.py` — builds position data and board SVGs
- `vendor/xgread/` — bundled XG reader
- `config.json` — build thresholds and display metadata
- `index.html`, `app.js`, `styles.css` — web UI
- `.github/workflows/deploy.yml` — GitHub Pages build/deploy workflow

The generated `dist/` directory is a build artifact and is not the source of truth.

## Position types

- Checker Play
- Double Action
- Take Action

The player shown on the bottom side in the source XG file is treated as the drill owner.

## Task mode and progress

Progress is stored in browser `localStorage` for each position ID. A position is included in **Task** mode when either condition is true:

- Correct count is 0
- Correct count is lower than incorrect count

Progress is local to each browser/device. Existing storage keys are intentionally kept stable so updates do not erase progress.

## Build and deployment

Pushing to `main` runs `.github/workflows/deploy.yml`:

1. Check out the repository
2. Run `python scripts/build.py`
3. Upload `dist/` as the GitHub Pages artifact
4. Deploy to GitHub Pages

The app fetches `data/positions.json` from its own Pages deployment, checks for updates every five minutes while open, and checks again when the tab becomes active.

## Local checks

Before deploying code changes, the main syntax/build checks are:

```bash
node --check app.js
python -m py_compile scripts/build.py
python scripts/build.py
```
