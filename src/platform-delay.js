const DEFAULT_META_INTER_CLIP_DELAY_SECONDS = 75;
const MAX_META_INTER_CLIP_DELAY_SECONDS = 300;

export function metaInterClipDelayMs({
  clipIndex,
  platforms = {},
  configuredSeconds = process.env.META_INTER_CLIP_DELAY_SECONDS
}) {
  if (Number(clipIndex || 0) <= 1) return 0;
  if (!(platforms.facebook || platforms.instagram || platforms.threads)) return 0;

  const parsed = Number(configuredSeconds);
  const seconds = Number.isFinite(parsed) && parsed >= 0
    ? Math.min(parsed, MAX_META_INTER_CLIP_DELAY_SECONDS)
    : DEFAULT_META_INTER_CLIP_DELAY_SECONDS;

  return Math.round(seconds * 1000);
}

export async function waitForMetaInterClipDelay(options) {
  const delayMs = metaInterClipDelayMs(options);
  if (!delayMs) return 0;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return delayMs;
}
