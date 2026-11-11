# Brand files

Each brand is one JSON file in `brands/` (or in the folder set by `SOCIAL_BRANDS_DIR`). The file
name is the brand key: `brands/example.json` is the brand `example`. Brand files hold ids and
settings only, never tokens or app secrets, so you can keep them in git.

Start from [`brands/example.json`](../brands/example.json). Its values are fake. Fill in only
the platforms the brand uses and delete the other blocks. Keys that start with `_` are ignored,
so you can use them for notes (`"_todo": "fill in after social auth meta"`).

## Top level

| Field | Required | What it does |
|---|---|---|
| `name` | yes | Display name in the CLI, the dashboard and alerts. |
| `timezone` | no | IANA time zone, e.g. `Europe/London`. Post times like `"2026-11-06 18:30"` are read in this zone. Default: `SOCIAL_DEFAULT_TZ`, else `UTC`. |
| `site` | no | The brand's own website. Links to this site get UTM tags. `null` turns tagging off. |
| `utm` | no | `{ "medium": "social", "campaign": "post" }`, or `false` for no tagging. `utm_source` is always the platform and `utm_content` the post id. A post's `campaign` overrides `utm.campaign`. Links that already carry `utm_source` are left alone. |
| `aiDisclosure` | no | A line such as `"Made with help from AI."`. When a post has `"ai": true`, platforms with no AI flag in their API get this line above the hashtags (unless the caption already has it). YouTube uses its own flag instead. |
| `approvedDirs` | for MCP | Folders that hold finished, approved media. The MCP `schedule_post` tool refuses any media or cover outside these folders. `~` is allowed. |
| `defaults.platforms` | no | Platforms used when a post file has no `platforms` block. |
| `publishing` | no | `false` switches the brand off: every post path refuses it, and the Worker blocks it. |
| `calendar` | no | With `publishing: false`, `true` keeps the brand on the dashboard as read-only. |

## `facebook`

| Field | What it does |
|---|---|
| `pageId` | The Facebook Page id. `social auth meta` prints it. |
| `pageName` | The Page name. Used to match the saved Page if `pageId` is empty. |
| `videoAs` | `reel` (default) or `video`. A post can override it with `platforms.facebook.as`. |

## `instagram`

The Instagram professional account must be linked to a Facebook Page that the Meta sign-in
can see.

| Field | What it does |
|---|---|
| `userId` | The Instagram business account id. `social auth meta` prints it. |
| `username` | The handle, without `@`. Used to match the account if `userId` is empty. |

## `youtube`

| Field | What it does |
|---|---|
| `channelId` | The channel id (`UC…`). `social auth youtube --brand <key>` prints it. |
| `madeForKids` | **Required**, `true` or `false`. |
| `categoryId` | YouTube category number as a string. Default `"22"` (People & Blogs). |
| `language` | Default language of title and audio, e.g. `"en"`. |
| `privacy` | `public` (default), `unlisted` or `private` for posts that go out now. |
| `playlistId` | Add every upload to this playlist. |
| `descriptionFooter` | A line added to every description. `{videoId}` is replaced with the new video's id (the video is uploaded private first, then updated). |
| `loginHint` | The Google account to pre-select at sign-in. Only used in the sign-in link. |
| `handle` | For your own reference. Not used by the code. |

## `pinterest`

| Field | What it does |
|---|---|
| `username` | The Pinterest business username. The sign-in is saved under it. |
| `defaultBoard` | Board used when a post names none. An alias, a board name or a board id. |
| `boards` | Short aliases: `{ "ideas": "Example Brand Ideas" }`. Values are board names or ids. |
| `defaultLink` | Link for Pins when the post has none. |
| `loginHint` | Shown as a reminder at sign-in. |

## `linkedin`

| Field | What it does |
|---|---|
| `author` | `urn:li:organization:<id>` for a company Page, or `me` for your own profile. |
| `app` | Which app in `apps.json` → `linkedin` to use. Default `default`. |

## Several accounts on one platform

Any platform block can hold several accounts. Shared fields sit next to `accounts`; each
account can override them. Posts pick one with `platforms.<platform>.account`, and
`social auth youtube --brand <key> --account <name>` signs one in.

```json
"youtube": {
  "default": "main",
  "madeForKids": false,
  "accounts": {
    "main":   { "channelId": "UC_MAIN_CHANNEL_ID" },
    "second": { "channelId": "UC_SECOND_CHANNEL_ID" }
  }
}
```

## `blog` (optional: scheduled Sanity publishing)

`social blog schedule` asks the Worker to publish a Sanity draft at a set time. This assumes
a particular Sanity setup, so check it fits yours:

- one document per language, with ids `<docType>.<lang>.<slug>` (drafts: `drafts.<docType>.<lang>.<slug>`);
- the first language uses the plain slug; the others add `-<lang>` (`my-post-de`).

| Field | What it does |
|---|---|
| `projectId` | Sanity project id. |
| `dataset` | Default `production`. |
| `docType` | Default `blogPost`. |
| `languages` | Default `["en"]`. All are published in one transaction. |
| `site`, `path` | Used for the post link shown in the calendar: `site + path + slug`. `path` defaults to `/blog/`. |
| `tokenRef` | Which Worker secret holds the Sanity token. Default `sanity:<projectId>`. |

Put a Sanity token with write access in `apps.json` → `"sanity": { "<projectId>": { "token": "…" } }`
and run `social cloud push`.
