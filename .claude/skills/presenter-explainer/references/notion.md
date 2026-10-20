# The Video Publishing workspace in Notion

Created 2026-10-19 through the Notion MCP connector. One workspace for every
channel: a channel is a row, never a new set of databases.

| What | ID |
| --- | --- |
| Video Publishing (page) | `3fe0755fb998812285f2f7106b036363` |
| Channels (data source) | `collection://c02607e6-acc6-44c0-ab31-136d0a230bf4` |
| Videos (data source) | `collection://71c96e02-b850-4140-9b36-9d8b34e87cc4` |
| Performance (data source) | `collection://65b2111b-de4a-42b7-ba07-12ef4bd0e784` |
| Now It Clicks (Channels row) | `3fe0755fb99881a2aa8ecd330055718e` |

Fetch a data source before writing to it: its schema is the source of truth for
property names and options.

- **Channels:** `Status`, `Handle`, `Presenter`, `Platforms` (active only),
  `Topics`, one URL per platform. The page body holds the bios and the style
  guide.
- **Videos:** `Channel` (relation), `Status` (Idea → In production → Ready to
  post → Partly posted → Live), `Topic`, `Length (s)`, `File`, `Cover`,
  `Third-party images`, `Posted on`, `Next check`, a `… posted` checkbox and a
  `… link` per platform, `Performance` (relation).
- **Performance:** `Video` (relation), `Platform`, `Checkpoint` (24 h, 7 d,
  30 d), `Recorded`, `Views`, `Likes`, `Comments`, `Shares`, `Saves`,
  `Avg watch (s)`, `Watched %`, `Followers gained`, `Engagement %` (formula),
  `Notes`, `Screenshots`.

Views: Videos has a `Pipeline` board by status; Performance has a
`24 h views by video` chart and a `By checkpoint` table.
