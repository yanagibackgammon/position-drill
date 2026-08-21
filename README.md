# Position Quiz

A static GitHub Pages quiz that uses analyzed backgammon position data published by `yanagibackgammon/positions`.

## Data source

The quiz loads the following resources directly from the `positions` site:

- `https://yanagibackgammon.github.io/positions/data/positions.json`
- The no-PIP board SVG specified by `quizBoardImage` in `positions.json`

When a game file is added or updated in `positions` and its deployment completes successfully, the new or updated position becomes available in `quiz` without rebuilding or redeploying the quiz repository.

## Position types

- Checker Play
- Double Action
- Take Action

Positions are classified using `decisionKind` (`checker` / `double` / `take`) in `positions.json`.

## Progress tracking

The browser stores the following counts for each position ID in `localStorage`:

- Correct answers
- Incorrect answers

A position is treated as a **Task** when either of the following is true:

- Correct count is 0
- Correct count is lower than incorrect count

Progress is stored separately for each device and browser.

## Deployment

Pushing to the `main` branch runs `.github/workflows/deploy.yml`. In the GitHub repository settings, set Pages Source to **GitHub Actions**.

## Automatic synchronization with positions

The quiz directly references `https://yanagibackgammon.github.io/positions/data/positions.json`.
When files are added or updated on the `main` branch of `positions`, its existing GitHub Actions workflow rebuilds all positions and updates GitHub Pages. No redeployment of `quiz` is required.

The quiz also:

- Fetches the latest position data whenever the page opens
- Checks for updates every 5 minutes while the page remains open
- Checks again when the browser tab becomes active
- Uses `generatedAt` as a board SVG version parameter so an updated board with the same position ID bypasses stale browser cache
