const safePublishModes = new Set(["all", "youtube_only", "social_only", "none"]);
const publishPlatforms = ["youtube", "facebook", "instagram", "tiktok", "threads"];
const socialPlatforms = new Set(["facebook", "instagram", "tiktok", "threads"]);

export function parseSafePublishMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (!mode) return "all";
  return safePublishModes.has(mode) ? mode : "all";
}

export function platformAllowedBySafeMode(platform, modeValue) {
  const mode = parseSafePublishMode(modeValue);
  if (mode === "none") return false;
  if (mode === "youtube_only") return platform === "youtube";
  if (mode === "social_only") return socialPlatforms.has(platform);
  return true;
}

export function selectPublishPlatforms(enabled = {}, modeValue = "all") {
  const mode = parseSafePublishMode(modeValue);
  const platforms = {};
  const skippedBySafeMode = {};

  for (const platform of publishPlatforms) {
    const isEnabled = Boolean(enabled[platform]);
    const allowed = platformAllowedBySafeMode(platform, mode);
    platforms[platform] = isEnabled && allowed;
    if (isEnabled && !allowed) {
      skippedBySafeMode[platform] = mode;
    }
  }

  return {
    mode,
    platforms,
    skippedBySafeMode,
    hasSelectedPlatform: Object.values(platforms).some(Boolean)
  };
}

export function enabledPublishPlatformsFromConfig(config) {
  return {
    youtube: config.youtube?.enabled,
    facebook: config.facebook?.enabled,
    instagram: config.instagram?.enabled,
    tiktok: config.tiktok?.enabled,
    threads: config.threads?.enabled
  };
}
