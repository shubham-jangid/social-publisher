# Media host (Cloudflare R2): only without the cloud scheduler

> With the cloud scheduler ([SETUP-CLOUD.md](SETUP-CLOUD.md)) you don't need this: Instagram and
> Pinterest get signed links to its private bucket instead. Use this only to post from your
> computer without the Worker.

Instagram can't take an image upload. It downloads images, carousels and Reel covers from a
public link. (Reel videos are uploaded directly and don't need this.) The tool puts each file
in an R2 bucket for a few minutes and deletes it after the post.

Without this, Reels still post (Instagram picks the cover frame), but Instagram photos and
carousels can't.

## Set up (once)

```sh
npx wrangler login
npx wrangler r2 bucket create social-media-temp
npx wrangler r2 bucket dev-url enable social-media-temp   # prints https://pub-….r2.dev
npx wrangler r2 bucket lifecycle add social-media-temp expire-1d --expire-days 1 --prefix social/
```

The lifecycle rule is a safety net: anything the tool failed to delete is gone in a day.

Then make an API key that can only touch this bucket: Cloudflare dashboard → **R2** →
**Manage API tokens** → **Create API token** → permission **Object Read & Write**, applied to
this bucket only. Copy the **Access Key ID** and **Secret Access Key** (shown once).

In `~/.config/social-publisher/apps.json`:

```json
"mediaHost": {
  "type": "r2",
  "accountId": "<Cloudflare account id, shown on the R2 overview page>",
  "bucket": "social-media-temp",
  "accessKeyId": "<Access Key ID>",
  "secretAccessKey": "<Secret Access Key>",
  "publicBaseUrl": "https://pub-xxxxxxxx.r2.dev"
}
```

R2's free tier covers this easily (a few MB a day).
