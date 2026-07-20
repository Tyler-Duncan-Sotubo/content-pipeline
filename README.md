# content-pipeline

NestJS pipeline: pulls new song posts from a source site (djmwanga.com), generates
original review articles with OpenAI, and publishes them to your WordPress site.

## Setup

```bash
npm install
cp .env.example .env   # fill in OpenAI key + WordPress credentials
```

WordPress credentials: wp-admin → Users → Profile → **Application Passwords** (needs HTTPS).

## Artist triggers

Edit `artists.json` in the project root — the pipeline searches the source site for each
name. If the array is empty, it falls back to the latest posts.

## Running

One-shot run (CLI, no server):

```bash
npm run pipeline
```

Or run as a server:

```bash
npm run start:dev
# preview what would be processed
curl http://localhost:3000/pipeline/preview
# trigger a run (optional per-run overrides)
curl -X POST http://localhost:3000/pipeline/run -H 'Content-Type: application/json' \
  -d '{"artists":["Diamond Platnumz"],"limit":2}'
```

## Notes

- Posts are created as **drafts** by default (`WP_POST_STATUS=draft`); flip to `publish`
  once you trust the output.
- `state.json` tracks already-processed source posts so nothing is generated twice.
  Delete it to reprocess everything. Swap `StateService` for a DB later if needed.
- Articles are original AI-written reviews based on the song title/description — the
  prompt forbids copying source text. Still review drafts before publishing.
