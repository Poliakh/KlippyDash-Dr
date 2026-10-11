# print-watchdog

Print monitoring: every few seconds it pulls a frame from each printer's camera, runs it
through a failure detector and sends a Telegram message when it sees spaghetti.

Two parts:

- `watchdog.py` — the service itself. It takes the printer list and thresholds from the
  dashboard's `/api/settings` rather than from a config of its own, so settings live in one
  place. It serves `/status` and `/events` on port 3334, which the eye indicator on the
  dashboard reads.
- `ml_api/` — the detector. This is a **vendored copy** of `ml_api` from the
  [Obico (TheSpaghettiDetective)](https://github.com/TheSpaghettiDetective/obico-server)
  project, distributed under **AGPL-3.0**. The code is theirs; the copy lives here only to
  keep deployment to a single script. Model weights are not included — `ml_api/model/` holds
  nothing but `.url` pointers to them.
- `run_ml_api.py` — our launcher for `ml_api`: it redirects output to `logs/ml_api.log` and
  starts `server.py` without a console window. `server.py` itself is left untouched so the
  copy stays diffable against upstream.

## What is missing here

`telegram_config.json` (bot token and chat id), `events.json` and `logs/` are excluded via
`.gitignore`. A token must not reach git history even for a single commit — deleting it in
the next commit does not remove it, it stays in the repository objects and has to be revoked.
Create the file locally:

```json
{ "bot_token": "...", "chat_id": "..." }
```

## Running

Nothing to start separately: `start-klippydash.bat` in the project root brings up the
dashboard, `ml_api` and `watchdog.py` together, all three without console windows.
`stop-klippydash.bat` shuts them down.
