import { loadApps } from './config.mjs'

/** The cloud scheduler's address and key from apps.json, or null when it is not set up. */
export function cloudCfg(required = false) {
  const c = loadApps().cloud
  if (c?.url && c?.apiToken) return c
  if (required) throw new Error('The cloud scheduler is not set up yet. Run: social cloud setup (docs/SETUP-CLOUD.md)')
  return null
}

/** Instagram, Pinterest and LinkedIn go through the cloud scheduler once it is set up. SOCIAL_NO_CLOUD=1 turns that off. */
export const cloudEnabled = () => process.env.SOCIAL_NO_CLOUD !== '1' && !!cloudCfg()
