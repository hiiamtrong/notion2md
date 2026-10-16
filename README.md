# notion-md

Export a Notion page, or a whole tree of linked pages and databases, to Markdown. It drives headless Chrome with the login of a profile you already have, so private pages work with no integration token and no sharing step.

Built to be called by people and by AI agents: results go to stdout, progress and errors go to stderr, nothing is ever prompted, and every failure has a stable exit code.

```bash
notion-md "https://www.notion.so/team/Knowledge-Map-01234567..." --profile 70 > map.md
notion-md "https://www.notion.so/team/Knowledge-Map-01234567..." --profile 70 --depth all --out ./knowledge-map
```

## Features

- **Private pages.** Reuses the cookies of any local Chrome profile. No Notion API key, no "share with integration".
- **Full fidelity.** Reads Notion's block tree directly, so collapsed toggles, tables, code, callouts, equations, mentions and aliases are all rendered. Scraping the DOM misses the collapsed ones.
- **Whole-workspace export.** `--depth` follows nested pages, links, mentions, databases and database rows, and writes one Markdown file per page with working relative links.
- **Database rows.** Each row becomes a file that starts with its fields (Status, Owner, ...), followed by the row's body.
- **Resilient crawling.** Retries on rate limits (429) and slows down automatically. A crawl stopped by `--max-pages`, `--timeout`, Ctrl-C or an error still writes everything fetched so far.
- **Agent friendly.** Machine readable `--json`, stable exit codes, progress on stderr only, input validated before Chrome starts.
- **Safe by default.** Only `notion.so`, `notion.com` and `notion.site` URLs are opened. Your Chrome profile is copied to a temporary directory and never modified.

## Requirements

| | |
| --- | --- |
| Node.js | 22.18 or newer (runs the TypeScript sources directly, no build step) |
| Browser | Google Chrome, or Microsoft Edge / Chromium via `--channel` |
| Platform | macOS (tested). Linux and Windows profile paths are implemented but untested. |
| Notion | A Chrome profile that is already logged in to Notion |

## Installation

```bash
git clone https://github.com/hiiamtrong/notion-md.git
cd notion-md
npm install
npm link        # installs the `notion-md` command
```

Use `npm link`, not `npm install -g .`. Node refuses to run TypeScript from inside `node_modules`, so the tool works from a clone but not as a copied or published package. Publishing would need a build step.

On macOS the first run may show a Keychain prompt for "Chrome Safe Storage". Choose **Always Allow**, otherwise Chrome cannot decrypt the copied cookies.

## Quick start

```bash
# 1. Find the Chrome profile that is logged in to Notion
notion-md profiles

# 2. Export one page to stdout
notion-md "https://www.notion.so/team/My-Page-0123456789abcdef0123456789abcdef" -p "Profile 2" > page.md

# 3. Export a page and everything reachable from it into a folder
notion-md "$URL" -p "Profile 2" --depth all --out ./export
```

A bare 32 character page id works in place of the URL.

## Usage

```
notion-md <url|page-id> [options]
notion-md profiles [--json]
```

| Option | Description |
| --- | --- |
| `-p, --profile <p>` | Chrome profile: directory name (`Profile 70`), number (`70`), display name or email. Default: the profile Chrome used last. |
| `-d, --depth <n\|all>` | How many hops to follow from the page (default `0`). See [Crawling](#crawling). A depth above 0 needs `--out <dir>`. |
| `--max-pages <n\|all>` | Stop after fetching this many pages (default `1000`). |
| `-o, --out <path>` | Depth 0: write the Markdown to this file and print its path. Depth above 0: the output folder. |
| `--json` | Print a JSON result instead of Markdown. Failures are JSON too. |
| `--timeout <sec>` | Overall time limit. Default `90`, or `1800` when depth is above 0. |
| `--progress` | Print progress to stderr. On by default when stderr is a terminal. |
| `--channel <c>` | `chrome` (default), `msedge` or `chromium`. |
| `--user-data-dir <d>` | Chrome user data directory to read profiles from, for non standard installs. |
| `--headed` | Show the browser window, for debugging. |
| `-h, --help`, `-v, --version` | |

### Choosing a profile

`-p` accepts the directory name, the bare number, the display name or the account email, case insensitive. If a name or email belongs to several profiles the command fails with `PROFILE_AMBIGUOUS` and lists the directories, it never guesses. Pass the directory name in that case.

## Crawling

With `--depth 0` only the requested page is exported and every link stays a `notion.so` URL.

With a depth above 0 the tool walks outward from the page. One hop is any of:

- a page nested inside the current page
- a page the current page links to (mention, inline link or alias)
- a database the page contains
- a database's rows

`--depth all` has no hop limit. A page is fetched and written once, even if many pages link to it.

### Output layout

```
export/
  Knowledge Map.md                  the page you asked for
  Knowledge Map/
    Repo Map.md                     a database: a list of its rows
    Repo Map/
      my-service.md                a row: its fields, then its body
  _linked/
    Code Review Criteria.md         a page reached only through a link
  _no-access.md                     pages Notion refused, and who linked to them
```

- Folders follow what a page **contains**: nested pages, databases and rows.
- A page reached **only through a link** goes flat in `_linked/`. Nesting by "who linked first" produces paths hundreds of characters long.
- Links between fetched pages are relative file links, so an agent can follow them. Everything else keeps its `notion.so` URL.
- File names come from page titles, sanitised so a title can never escape the output folder. Duplicate names in one folder get the first 8 characters of the page id appended.
- Existing files with the same names are overwritten.

### Cost and limits

Pages are fetched one at a time, roughly half a second each, and slower once Notion starts rate limiting. A real workspace of 649 pages took about 21 minutes. Parallel fetching would only trigger more 429 responses.

| Situation | Behaviour | Exit |
| --- | --- | --- |
| `--max-pages` reached | Writes what was fetched, warns, reports `skipped` | 0 |
| `--timeout` reached | Same | 0 |
| Ctrl-C once | Stops after the current page and writes what was fetched | 0 |
| Ctrl-C twice, SIGTERM | Quits at once, temporary files are still removed | 130 / 143 |
| Page Notion refuses | Skipped and listed in `_no-access.md`, crawl continues | 0 |
| Rate limited (429) | Retried with waits, then the pace slows to up to 3 s per request and recovers after 20 clean calls | 0 |
| Retries exhausted or another API error | Writes what was fetched, prints the error | 1 |

## Output for agents

stdout carries only the result. Progress and diagnostics go to stderr. Nothing is ever prompted.

### `--json`, single page

```json
{
  "ok": true,
  "id": "01234567-89ab-cdef-0123-456789abcdef",
  "title": "Knowledge Map",
  "url": "https://www.notion.so/...",
  "profile": "Profile 70",
  "truncated": null,
  "skipped": 0,
  "noAccess": [],
  "pages": [{ "id": "...", "title": "Knowledge Map" }],
  "markdown": "# Knowledge Map\n..."
}
```

### `--json`, crawl (depth above 0)

Same fields, except `markdown` is replaced by `out` (absolute folder path), each entry of `pages` carries a `path` relative to `out`, and these are added or filled in:

| Field | Meaning |
| --- | --- |
| `truncated` | `null`, `"max-pages"`, `"timeout"`, `"interrupted"` or `"error"` |
| `skipped` | Pages found but not fetched because the crawl stopped early |
| `error` | Message when `truncated` is `"error"`, else `null`. `ok` is `false` in that case, but the files are still written. |
| `noAccess` | `[{ id, title, url, from }]`, `from` is the id of the page that linked to it |

### Errors

With `--json`, a failure prints `{"ok":false,"error":{"code","message","hint"}}` on stdout. The same information is printed on stderr as `error[CODE]: message` followed by `hint: ...`.

| Exit | Meaning | Codes |
| --- | --- | --- |
| 0 | Success, including a crawl that stopped early on purpose | |
| 1 | Other failure | `ERROR`, `API_ERROR`, `RATE_LIMITED`, `TIMEOUT` |
| 2 | Bad usage or input | `BAD_INPUT` |
| 3 | Profile problem | `PROFILE_NOT_FOUND`, `PROFILE_AMBIGUOUS` |
| 4 | Not logged in, or no access to the page | `AUTH_REQUIRED`, `NO_ACCESS` |
| 5 | Browser could not start | `BROWSER_FAILED` |

Everything that can be checked up front (depth, timeout, URL host, output folder, profile) is validated before Chrome starts, so mistakes fail in milliseconds with exit 2 or 3.

## How it works

1. **Copy the login.** `Local State` and the cookie files of the chosen profile are copied to a temporary directory. Chrome refuses automation on its real data directory and locks a profile that is open, so working on a copy lets Chrome stay running. The copy is deleted when the tool exits, including on Ctrl-C and SIGTERM.
2. **Open Notion.** The page loads in headless Chrome using that copy.
3. **Call the web API from inside the page.** `loadCachedPageChunkV2`, `syncRecordValues` and `queryCollection` are called with `fetch` from the page itself. They run with the profile's cookies and Chrome's own network stack and return the full block tree, including blocks that are collapsed in the UI.
4. **Render.** Blocks are converted to Markdown. Links to pages that were fetched are rewritten to relative file links.

## Security and privacy

- The browser carries your real login, so only `notion.so`, `notion.com` and `notion.site` URLs are accepted. Any other host is rejected with `BAD_INPUT` before Chrome starts. This matters when the URL comes from an agent that may have been prompt injected.
- Only cookies and preferences are copied from your profile. The copy lives in a private temporary directory and is removed at exit. Your original profile is read, never written.
- The tool itself only talks to Notion and sends no telemetry. The Chrome it launches behaves like any other Chrome.

## Limitations

- It uses Notion's undocumented web API, so it can break when Notion changes it.
- Only the first view of a database is read, without filters, so all rows come back. A database with two views produces two index files listing the same rows. A database is cut at 5000 rows.
- Row fields are exported as text. People appear as `@user`, relations as links.
- Images hosted by Notion link to `notion.so/image/...`, which only opens with a logged in session. They are not downloaded.
- Crawling a large workspace takes minutes, see [Cost and limits](#cost-and-limits).
- Linux and Windows are untested.

## Development

```bash
npm install
npm test             # unit tests plus the CLI exit codes
npm run typecheck    # tsc, no emit
```

The tests run against a fake Notion workspace, so they need no network and no Chrome. They cover URL parsing and the host allow list, Markdown rendering, pagination, lazy toggle children, link and database crawling, no access and rate limit handling, the folder layout, and edge cases such as empty input, batches of 100 and 101 ids, page cycles and hostile titles.

```
bin/notion-md.ts   CLI entry: arguments, browser lifecycle, progress, output
src/notion.ts      parsing, API calls, crawl, rate limit pacing
src/markdown.ts    block tree to Markdown
src/tree.ts        folder layout and file writing
src/chrome.ts      profile discovery and the cookie copy
src/types.ts       shapes of the Notion API responses used here
src/errors.ts      CliError with code, hint and exit code
```

## License

MIT, see [LICENSE](LICENSE).
