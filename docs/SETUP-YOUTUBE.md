# YouTube setup (Google Cloud)

One Google Cloud project serves every channel. Each channel signs in on its own.

## 1. Project and API

1. <https://console.cloud.google.com> → **New project**.
2. APIs & Services → **Library** → enable **YouTube Data API v3**. For watch time and
   "% watched" in `social analytics`, also enable **YouTube Analytics API** (no new sign-in is
   needed; the `youtube` scope covers it).

## 2. Consent screen

Google Auth Platform (or "OAuth consent screen"):

1. **Branding**: an app name, support email, developer email.
2. **Audience**: user type **External**, then **Publish app** so the status is **In production**.
   In "Testing" mode the sign-in expires every 7 days.
   You don't need Google's verification for your own channels. You will see an "unverified app"
   screen at sign-in: click **Advanced → Go to <your app>**.
3. **Data access**: add the scopes `…/auth/youtube.upload` and `…/auth/youtube`.

## 3. Client

**Clients** → **Create client** → type **Desktop app**. Copy the **Client ID** and
**Client secret** into `~/.config/social-publisher/apps.json` under `"google"`.

## 4. Sign in each channel

```sh
social auth youtube --brand example                    # the brand's default channel
social auth youtube --brand example --account second   # a brand with two channels
```

Brand Accounts show up as a separate choice after you pick the Google account. Pick the
channel, not the person. The command prints the channel id; put it in the brand file
(`youtube.channelId`). `loginHint` in the brand file pre-fills the Google account.

## 5. Ask Google for public uploads (do this on day one)

New API projects can only upload **private** videos until they pass Google's audit. The tool
still uploads; it warns you, and you make the video public in YouTube Studio until then.

Fill in the **YouTube API Services audit and quota extension form**:
<https://support.google.com/youtube/contact/yt_api_form>. Google usually wants a privacy
policy, terms, a short description of how the tool works, and screenshots of the sign-in and
upload. It can take a few weeks.

## Limits

- The daily quota is 10,000 units per project, shared by all channels. An upload costs a large
  share of it, so expect only a handful of uploads a day. The same form can ask for more.
- Custom thumbnails need a phone-verified channel.
- `madeForKids` (true or false) is required in every brand file that uses YouTube.
- A post with `"ai": true` is flagged with YouTube's `containsSyntheticMedia` setting.
- YouTube scheduling is native: the video is uploaded private with a `publishAt` time.
