# Meta setup (Facebook + Instagram)

One Meta app and one sign-in reach every Facebook Page you manage and the Instagram
professional account linked to each Page. It takes about 20 minutes. Meta changes its screens
often, so labels may differ a little.

**Do this yourself, in your normal browser.** Do not let a browser-automation agent click
through Facebook or Meta's developer site. Meta can flag an account for "automated behaviour",
and that can lock the account and every Page tied to it. This tool only talks to Meta through
the official Graph API, which is the allowed path.

## 1. Check each Instagram account

For each brand, in the Instagram app: profile → menu → **Account type and tools**. It must be a
**Professional** account (Business or Creator). Then on the Facebook Page: Settings →
**Linked accounts** → Instagram should show that account.

## 2. Create the app

1. Go to <https://developers.facebook.com/apps> and log in with the Facebook account that
   manages the Pages. Register as a developer if asked.
2. **Create app**. Name it something neutral (Meta rejects names with "Facebook",
   "Instagram" or "Meta" in them).
3. Use case: **Other**, then app type **Business**. Pick any business portfolio you own.
4. App settings → **Basic**: copy the **App ID** and **App secret**. Add a privacy policy URL
   and a terms URL (any page you control that describes the tool).

Leave the app in **Development** mode. You are its admin, so the permissions below work for
your own Pages without Meta's App Review.

## 3. Get a sign-in token (pick one way)

The tool needs these permissions: `pages_show_list`, `pages_read_engagement`,
`pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, `business_management`,
and for analytics `read_insights`, `instagram_manage_insights`, `pages_read_user_content`.

**Way A: Graph API Explorer (works without business verification).**

1. Open <https://developers.facebook.com/tools/explorer>, choose your app.
2. Add the permissions above, then **Generate Access Token**. Choose all current and future
   Pages and all Instagram accounts you want to post to.
3. Copy the token and run `social auth meta --token <token>`.

**Way B: Facebook Login for Business.** Some app setups need business verification for this.

1. Add the product **Facebook Login for Business**. In its settings add
   `http://localhost:8585/callback` as a redirect URI.
2. **Configurations** → create one with a **User access token** and the permissions above.
   Copy the **Configuration ID**.
3. Put it in `apps.json` as `meta.configId`, then run `social auth meta`. It prints a link: open
   it yourself, tick every Page and Instagram account, and the terminal finishes the sign-in.

## 4. Save the keys and ids

```sh
social init      # first time only, creates ~/.config/social-publisher/apps.json
```

In `apps.json`: `"meta": { "appId": "…", "appSecret": "…", "configId": "", "graphVersion": "v24.0" }`.

After `social auth meta`, the terminal prints each Page id and its Instagram id. Put them in
your brand file (`facebook.pageId`, `instagram.userId`). Then:

```sh
social check
social cloud push      # if you use the cloud scheduler
```

## Notes

- The tool exchanges the token for a long-lived one and saves a Page token for every Page.
  Page tokens made this way do not expire. They stop working if you change your Facebook
  password, remove the app, or lose admin on the Page. Then sign in again.
- The API cannot set Instagram's or Facebook's "AI info" label. If a post has `"ai": true`,
  the tool adds the brand's `aiDisclosure` line to the caption instead.
- Facebook posts can be scheduled on Facebook itself (10 minutes to 29 days ahead).
  Instagram has no scheduling in its API, so the cloud scheduler posts it at the time.
- Meta asks app owners to do a yearly "data use checkup" by email. It is a short form.
