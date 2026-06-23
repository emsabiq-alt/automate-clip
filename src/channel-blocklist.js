function listEnvMany(names) {
  return names
    .flatMap((name) => String(process.env[name] || "")
      .split(/[\n,|;]+/)
      .map((item) => item.trim())
      .filter(Boolean));
}

function normalizeChannelValue(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i, "")
    .replace(/^channel\:/i, "")
    .replace(/^@+/, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

export function blockedChannelTerms() {
  return [...new Set(listEnvMany([
    "AUTO_DISCOVER_BLOCKED_CHANNELS",
    "AUTO_DISCOVER_BLOCKED_CHANNEL_HANDLES",
    "AUTO_DISCOVER_BLOCKED_CHANNEL_IDS",
    "YOUTUBE_BLOCKED_CHANNELS"
  ]).map(normalizeChannelValue).filter(Boolean))];
}

function candidateChannelValues(item = {}) {
  return [
    item.channel,
    item.uploader,
    item.channelTitle,
    item.channel_title,
    item.playlist_channel,
    item.playlist_uploader,
    item.channelId,
    item.channel_id,
    item.uploader_id,
    item.discovery_query,
    item.notes
  ].map(normalizeChannelValue).filter(Boolean);
}

export function blockedChannelMatch(item = {}) {
  const terms = blockedChannelTerms();
  if (!terms.length) return "";

  const values = candidateChannelValues(item);
  for (const term of terms) {
    const match = values.find((value) => value === term || value.includes(term) || term.includes(value));
    if (match) return term;
  }
  return "";
}

export function isBlockedChannelItem(item = {}) {
  return Boolean(blockedChannelMatch(item));
}
