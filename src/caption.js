import fs from "node:fs/promises";
import path from "node:path";
import { generateAiText } from "./ai.js";

async function readClipContext(clipperRoot, output) {
  const parts = [output.title, output.hook, output.caption, output.reason].filter(Boolean);
  const reviewPath = output.transcriptReviewPath ? path.join(clipperRoot, output.transcriptReviewPath) : "";
  if (reviewPath) {
    try {
      const raw = await fs.readFile(reviewPath, "utf8");
      const data = JSON.parse(raw);
      const texts = [];
      collectText(data, texts);
      if (texts.length) parts.push(texts.slice(0, 90).join(" "));
    } catch {
      // Caption fallback can still use clip metadata.
    }
  }
  return parts.join("\n").slice(0, 9000);
}

function collectText(value, texts) {
  if (!value || texts.length > 120) return;
  if (typeof value === "string") {
    const cleaned = value.trim();
    if (cleaned && cleaned.split(/\s+/).length > 2) texts.push(cleaned);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, texts);
    return;
  }
  if (typeof value === "object") {
    for (const key of ["text", "caption", "corrected_text", "original_text"]) {
      collectText(value[key], texts);
    }
    for (const child of Object.values(value)) {
      if (typeof child === "object") collectText(child, texts);
    }
  }
}

export async function generateCaption({ job, output, promptTemplate, clipperRoot, aiProvider = "" }) {
  const context = await readClipContext(clipperRoot, output);
  const dynamicHashtags = buildDynamicHashtags({ job, output, promptTemplate, context });
  const fallback = fallbackCaption(output, promptTemplate, dynamicHashtags);
  const prompt = [
    "Buat caption Reels/TikTok berbahasa Indonesia yang terasa seperti ngobrol langsung dengan pemirsa.",
    "Aturan:",
    "- Format wajib 4 blok, dipisah 1 baris kosong: hook, isi singkat, CTA, hashtag.",
    "- Baris pertama hook kuat dan conversational, maksimal 90 karakter. Boleh pakai 1 emoji yang natural.",
    "- Blok isi maksimal 2 kalimat pendek dan spesifik membahas topik utama video.",
    "- CTA berupa 1 pertanyaan ringan, maksimal 80 karakter.",
    "- Total caption ideal 280-480 karakter, jangan terlalu panjang.",
    "- Tulis seperti kreator yang mengajak pemirsa ikut mikir/menanggapi, bukan laporan formal.",
    "- Gunakan kata sapaan seperti kamu/kita secukupnya.",
    "- Hindari kalimat template kaku seperti 'Dalam video ini', 'Potongan ini', atau 'Video ini membahas'.",
    "- Ringkas, natural, emosional, dan tetap sesuai transkrip. Boleh pakai emoji, tapi jangan berlebihan.",
    "- Kalau ada nama tokoh/artis/narasumber, sebutkan namanya secara natural di hook atau isi caption.",
    "- Hindari kata/hashtag yang rawan dibatasi platform: judi, slot, togel, taruhan, pinjol, paylater, riba, SARA, ujaran kebencian, pornografi, narkoba, atau kekerasan ekstrem.",
    "- Jangan pakai hashtag generik seperti #PodcastIndonesia, #ReelsIndonesia, #Shorts, #FYP, #Viral.",
    "- Jangan mengarang fakta di luar konteks.",
    "- Caption harus selesai utuh. Jangan akhiri dengan kalimat terpotong, koma, titik dua, kata sambung, atau ellipsis.",
    "- Jangan menyalin mentah transkrip yang terpotong; rangkum jadi kalimat lengkap.",
    "- Akhiri dengan tepat 3 hashtag relevan. Prioritaskan 1 hashtag konteks/tokoh/topik jika ada.",
    "",
    `Tema: ${job.theme}`,
    `Gaya: ${promptTemplate?.caption_style || promptTemplate?.hook_style || "natural, conversational, audience-first"}`,
    `CTA: ${promptTemplate?.cta || "Menurut kamu bagaimana?"}`,
    `Arah hashtag aman jika konteks minim: ${BASE_HASHTAGS.join(" ")}`,
    `Arah hashtag dari konteks: ${dynamicHashtags.join(" ") || "-"}`,
    "",
    "Konteks clip:",
    context || fallback,
    "",
    "Tulis caption final saja tanpa markdown."
  ].join("\n");

  const text = await generateAiText(prompt, { maxOutputTokens: 360, provider: aiProvider });
  return ensureCaptionHashtags(text || fallback, output, promptTemplate, dynamicHashtags, fallback);
}

export async function generateThumbnailText({ job, output, promptTemplate, aiProvider = "" }) {
  const existing = output.thumbnailText ? normalizeThumbnailText(output.thumbnailText, "") : "";
  const fallback = fallbackThumbnailText(output);
  const prompt = buildThumbnailTitlePrompt({ job, output, promptTemplate, existing });
  const text = await generateAiText(prompt, { maxOutputTokens: 110, temperature: 0.65, provider: aiProvider });
  const generated = text ? normalizeThumbnailText(text, "") : "";
  return isStrongThumbnailText(generated) ? generated : fallback;
}

export function buildThumbnailTitlePrompt({ job = {}, output = {}, promptTemplate = {}, existing = "" } = {}) {
  return [
    "Kamu adalah AI Title Skill untuk Shorts/Reels Indonesia.",
    "Tugasmu memilih SATU judul/hook cover video yang paling natural, spesifik, dan membuat orang ingin menonton.",
    "",
    "Aturan wajib:",
    "- Buat judul baru dari konteks, jangan mengikuti template tetap.",
    "- Panjang 6 sampai 16 kata, utuh, mudah dibaca di HP, dan cocok untuk cover video.",
    "- Pilih sudut viral yang paling cocok secara alami: konflik, dilema, pertanyaan, momen tegang, pengakuan, konsekuensi, emosi, reaksi, perubahan sikap, atau quote tajam.",
    "- Hindari pola yang terlalu sering dipakai: RAHASIA, DI BALIK, TERBONGKAR, TAK TERDUGA, BIKIN PENASARAN.",
    "- Jangan memaksa kata rahasia jika konteksnya tidak benar-benar tentang rahasia.",
    "- Pakai nama orang hanya kalau jelas disebut sebagai orang di transkrip/metadata. Jangan jadikan nama acara, channel, hashtag, atau topik sebagai nama orang.",
    "- Jangan mengarang fakta, konflik, nama, atau hubungan yang tidak ada di konteks.",
    "- Jangan ambil potongan transkrip mentah yang tidak jelas.",
    "- Jangan buat kalimat menggantung yang berakhir koma, titik dua, atau kata sambung.",
    "- Jangan pakai hashtag, emoji, markdown, tanda kutip, atau label seperti Judul:.",
    "",
    `Tema: ${job.theme || "-"}`,
    `Gaya: ${promptTemplate?.thumbnail_style || promptTemplate?.hook_style || "spesifik, manusiawi, kuat tanpa clickbait"}`,
    `Teks clipper jika ada: ${existing || "-"}`,
    `Judul/hook clip: ${output.hook || output.title || ""}`,
    `Alasan/angle clip: ${output.reason || output.selectedAngle || ""}`,
    `Caption jika ada: ${String(output.caption || "").slice(0, 500)}`,
    `Transkrip singkat: ${String(output.clipTranscript || "").slice(0, 1200)}`,
    "",
    "Balas hanya judul final."
  ].join("\n");
}

export async function generateFrameQuoteText({ job, output, promptTemplate, aiProvider = "" }) {
  const fallback = fallbackFrameQuote(output);
  const prompt = [
    "Buat quote pendek untuk lower-third video Reels dalam Bahasa Indonesia.",
    "Aturan: 5 sampai 11 kata, terasa seperti kalimat paling kuat dari clip, natural, rapi, dan mudah dibaca.",
    "- Jangan pakai hashtag.",
    "- Jangan pakai emoji.",
    "- Jangan pakai markdown.",
    "- Jangan menambah fakta di luar konteks.",
    "- Jangan terlalu clickbait.",
    `Tema: ${job.theme}`,
    `Style: ${promptTemplate?.thumbnail_style || "singkat dan kuat"}`,
    `Judul/hook clip: ${output.hook || output.title || ""}`,
    `Alasan clip: ${output.reason || ""}`,
    `Transkrip singkat: ${String(output.clipTranscript || output.caption || "").slice(0, 900)}`,
    "Balas hanya quote tanpa tanda kutip."
  ].join("\n");
  const text = await generateAiText(prompt, { maxOutputTokens: 60, temperature: 0.45, provider: aiProvider });
  const generated = normalizeFrameQuoteText(text);
  return isStrongFrameQuote(generated) ? generated : fallback;
}

function fallbackCaption(output, promptTemplate, dynamicHashtags = []) {
  const hookSource = output.hook || output.selectedAngle || output.title || "Sikap ini bikin banyak orang ikut mikir";
  const hook = asQuestionOrSentence(hookSource);
  const body = completeSentence(
    output.reason
    || output.selectedAngle
    || output.caption
    || "Ada pilihan, tekanan, dan sudut pandang yang terasa dekat dengan keseharian kita."
  );
  const cta = completeSentence(promptTemplate?.cta || "Menurut kamu, bagian paling relate yang mana?");
  const tags = captionHashtags({ dynamicHashtags, output, promptTemplate }).join(" ");
  return `${hook}\n\n${body}\n\n${cta}\n\n${tags}`;
}

function asQuestionOrSentence(value) {
  const cleaned = normalizeCaptionBody(value);
  if (!cleaned) return "Kamu juga kepikiran hal yang sama?";
  if (/[?!]$/.test(cleaned)) return cleaned;
  const conversationalHook = cleaned.replace(/[.!]+$/g, "").trim();
  if (conversationalHook.length <= 110) return `${conversationalHook} menurut kamu gimana?`;
  return completeSentence(cleaned);
}

function fallbackFrameQuote(output) {
  const candidates = [
    output?.clipTranscript,
    output?.caption,
    output?.hook,
    output?.reason,
    output?.title
  ].filter(Boolean);

  for (const value of candidates) {
    const sentence = String(value)
      .split(/[.!?\n]+/)
      .map((item) => normalizeFrameQuoteText(item))
      .find(isStrongFrameQuote);
    if (sentence) return sentence;
  }
  return "Gue baru sadar setelah kehilangan";
}

function normalizeFrameQuoteText(value) {
  const cleaned = String(value || "")
    .replace(/[`"'*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .slice(0, 11)
    .join(" ");
}

function isStrongFrameQuote(value) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  return words.length >= 5 && words.join("").length >= 16;
}

function ensureCaptionHashtags(caption, output, promptTemplate, dynamicHashtags = [], fallback = "") {
  const cleaned = sanitizeCaptionText(String(caption || "").trim());
  const hashtags = captionHashtags({ caption: cleaned, dynamicHashtags, output, promptTemplate });
  if (!hashtags.length) return cleaned;
  const body = formatSocialCaptionBody(stripHashtags(cleaned), stripHashtags(fallback), promptTemplate, output);
  return fitCaptionWithHashtags(body || cleaned, hashtags);
}

function formatSocialCaptionBody(value, fallback = "", promptTemplate = {}, output = {}) {
  const completed = completeCaptionBody(value, fallback);
  const source = sanitizeCaptionText(completed || fallback);
  const fallbackSource = sanitizeCaptionText(fallback);
  if (!source && !fallbackSource) return "Sikap ini bikin banyak orang ikut mikir.";

  const paragraphs = splitCaptionParagraphs(source || fallbackSource);
  const sentences = splitCaptionSentences(source || fallbackSource);
  const fallbackSentences = splitCaptionSentences(fallbackSource);

  const hook = tightenCaptionLine(
    paragraphs[0] || sentences[0] || "Sikap ini bikin banyak orang ikut mikir.",
    CAPTION_HOOK_MAX_CHARS
  );

  const detailCandidates = [
    ...sentences.slice(1).filter((item) => !isQuestionSentence(item)),
    ...fallbackSentences.filter((item) => !isQuestionSentence(item)),
    paragraphs.slice(1).join(" ")
  ];
  const detail = tightenCaptionLine(
    firstMeaningfulCaptionLine(detailCandidates, hook) || "Ada pilihan dan tekanan yang bikin sudut pandangnya terasa dekat.",
    CAPTION_BODY_MAX_CHARS
  );

  const cta = tightenCaptionLine(
    findCaptionQuestion(source, hook)
      || promptTemplate?.cta
      || "Menurut kamu, ini relate nggak?",
    CAPTION_CTA_MAX_CHARS
  );

  return ensurePrimaryNameInCaption(dedupeCaptionBlocks([hook, detail, cta]).join("\n\n"), output);
}

function fitCaptionWithHashtags(body, hashtags) {
  const tagLine = hashtags.join(" ");
  let blocks = splitCaptionParagraphs(body).slice(0, 3);
  let text = `${blocks.join("\n\n")}\n\n${tagLine}`.trim();
  if (captionLength(text) <= CAPTION_MAX_CHARS) return text;

  blocks = blocks.map((block, index) => {
    if (index === 0) return tightenCaptionLine(block, CAPTION_HOOK_MAX_CHARS);
    if (index === 1) return tightenCaptionLine(block, CAPTION_BODY_SHORT_MAX_CHARS);
    return tightenCaptionLine(block, CAPTION_CTA_MAX_CHARS);
  });
  text = `${dedupeCaptionBlocks(blocks).join("\n\n")}\n\n${tagLine}`.trim();
  if (captionLength(text) <= CAPTION_MAX_CHARS) return text;

  const available = Math.max(80, CAPTION_MAX_CHARS - captionLength(tagLine) - 4);
  const compactBody = tightenCaptionLine(dedupeCaptionBlocks(blocks).join(" "), available);
  return `${compactBody}\n\n${tagLine}`.trim();
}

function splitCaptionParagraphs(value) {
  return normalizeCaptionBody(value)
    .split(/\n{1,}/)
    .map((item) => normalizeCaptionBody(item))
    .filter(Boolean);
}

function splitCaptionSentences(value) {
  const text = normalizeCaptionBody(value).replace(/\n+/g, " ");
  return (text.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g) || [])
    .map((item) => normalizeCaptionBody(item))
    .filter((item) => item.split(/\s+/).filter(Boolean).length >= 3);
}

function tightenCaptionLine(value, maxChars) {
  const cleaned = normalizeCaptionBody(value).replace(/\n+/g, " ");
  if (!cleaned) return "";
  if (captionLength(cleaned) <= maxChars) return completeSentence(cleaned);

  const clipped = takeCaptionChars(cleaned, maxChars);
  const sentence = trimToLastCompleteSentence(clipped);
  if (captionLength(sentence) >= 28) return sentence;

  const words = [];
  for (const word of cleaned.split(/\s+/)) {
    const candidate = [...words, word].join(" ");
    if (captionLength(candidate) > maxChars) break;
    words.push(word);
  }
  return completeSentence(words.join(" ") || clipped);
}

function firstMeaningfulCaptionLine(candidates, hook) {
  const hookKey = captionBlockKey(hook);
  for (const item of candidates) {
    const cleaned = normalizeCaptionBody(item).replace(/\n+/g, " ");
    if (!cleaned || captionBlockKey(cleaned) === hookKey) continue;
    if (cleaned.split(/\s+/).filter(Boolean).length < 5) continue;
    return cleaned;
  }
  return "";
}

function findCaptionQuestion(value, hook = "") {
  const hookKey = captionBlockKey(hook);
  return splitCaptionSentences(value)
    .filter(isQuestionSentence)
    .find((item) => captionBlockKey(item) !== hookKey) || "";
}

function isQuestionSentence(value) {
  return /\?$/.test(normalizeCaptionBody(value));
}

function dedupeCaptionBlocks(blocks) {
  const seen = new Set();
  const result = [];
  for (const block of blocks) {
    const cleaned = normalizeCaptionBody(block);
    const key = captionBlockKey(cleaned);
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function captionBlockKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 80);
}

function captionLength(value) {
  return Array.from(String(value || "")).length;
}

function takeCaptionChars(value, maxChars) {
  return Array.from(String(value || "")).slice(0, maxChars).join("").trim();
}

function completeCaptionBody(value, fallback = "") {
  const cleaned = normalizeCaptionBody(value);
  if (isCompleteCaption(cleaned)) return cleaned;

  const trimmed = trimToLastCompleteSentence(cleaned);
  if (isCompleteCaption(trimmed)) return trimmed;

  const fallbackCleaned = normalizeCaptionBody(fallback);
  if (isCompleteCaption(fallbackCleaned)) return fallbackCleaned;

  return completeSentence(fallbackCleaned || cleaned || "Sikap ini bikin banyak orang ikut mikir.");
}

function normalizeCaptionBody(value) {
  return String(value || "")
    .replace(/\s*(?:\.{3}|…)\s*$/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function sanitizeCaptionText(value) {
  let text = normalizeCaptionBody(value)
    .replace(/^\s*(?:kenapa\s+ini\s+menarik|poin)\s*:\s*/gim, "")
    .replace(/\b(?:dalam\s+video\s+ini|potongan\s+ini|video\s+ini\s+membahas)\b/giu, "")
    .replace(/\b(?:judi\s*online|judi|slot|togel|casino|taruhan|betting)\b/giu, "jalan pintas berisiko")
    .replace(/\b(?:pinjol|pinjaman\s*online|paylater|riba)\b/giu, "risiko finansial")
    .replace(/\bSARA\b/giu, "isu perbedaan");

  for (const phrase of STIFF_CAPTION_OPENERS) {
    text = text.replace(phrase, "");
  }
  return normalizeCaptionBody(text);
}

function isCompleteCaption(value) {
  const cleaned = normalizeCaptionBody(value);
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  const lastLine = cleaned.split(/\n+/).map((line) => line.trim()).filter(Boolean).pop() || "";
  return !INCOMPLETE_CAPTION_END_RE.test(lastLine);
}

function trimToLastCompleteSentence(value) {
  const cleaned = normalizeCaptionBody(value);
  const end = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf("?"), cleaned.lastIndexOf("!"));
  if (end < 20) return "";
  return cleaned.slice(0, end + 1).trim();
}

function completeSentence(value) {
  const cleaned = normalizeCaptionBody(value)
    .replace(INCOMPLETE_CAPTION_END_RE, "")
    .trim();
  if (!cleaned) return "";
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function captionHashtags({ caption = "", dynamicHashtags = [], output, promptTemplate } = {}) {
  const outputHashtags = normalizeHashtags(output?.hashtags || []);
  const existingHashtags = normalizeHashtags(extractHashtags(caption));
  const contextHashtags = normalizeHashtags(dynamicHashtags);
  const templateHashtags = normalizeHashtags(promptTemplate?.hashtag_template || []);
  const merged = mergeHashtags(
    contextHashtags,
    outputHashtags,
    existingHashtags,
    templateHashtags,
    BASE_HASHTAGS
  ).filter((tag) => !isGenericHashtag(tag) && !isUnsafeHashtag(tag));
  return (merged.length ? merged : BASE_HASHTAGS).slice(0, HASHTAG_LIMIT);
}

function buildDynamicHashtags({ job, output, context = "" }) {
  const provided = normalizeHashtags(output?.hashtags || [])
    .filter((tag) => !isGenericHashtag(tag) && !isUnsafeHashtag(tag));
  if (provided.length >= 1) return provided.slice(0, HASHTAG_LIMIT);

  const directFields = [
    output?.selectedAngle,
    output?.hook,
    output?.title,
    output?.reason,
    output?.caption,
    output?.clipTranscript
  ].filter(Boolean);
  const source = [...directFields, context, job?.theme].join(" ");
  const candidates = [...provided];

  for (const tag of topicHashtags(source)) addHashtagCandidate(candidates, tag);
  for (const name of namedPhrases(source)) addHashtagCandidate(candidates, name);

  for (const phrase of directFields.slice(0, 5)) {
    addHashtagCandidate(candidates, phrase);
    for (const pair of keywordPairs(phrase)) addHashtagCandidate(candidates, pair);
  }

  for (const keyword of topKeywords(source, 12)) addHashtagCandidate(candidates, keyword);

  const dynamic = normalizeHashtags(candidates)
    .filter((tag) => !isGenericHashtag(tag) && !isUnsafeHashtag(tag))
    .slice(0, HASHTAG_LIMIT);
  return dynamic.length ? dynamic : BASE_HASHTAGS.slice(0, HASHTAG_LIMIT);
}

function addHashtagCandidate(candidates, value) {
  const hashtag = toHashtag(value);
  if (hashtag) candidates.push(hashtag);
}

function keywordPairs(value) {
  const tokens = meaningfulTokens(value);
  const pairs = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    pairs.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return pairs.slice(0, 4);
}

function namedPhrases(value) {
  const matches = String(value || "").match(/\b[A-Z][\p{L}\p{N}]+(?:\s+[A-Z][\p{L}\p{N}]+){1,2}/gu) || [];
  return matches
    .map((item) => item.trim())
    .filter((item) => meaningfulTokens(item).length >= 2)
    .slice(0, 8);
}

function topKeywords(value, limit) {
  const scores = new Map();
  const firstSeen = new Map();
  const tokens = meaningfulTokens(value);
  tokens.forEach((token, index) => {
    scores.set(token, (scores.get(token) || 0) + 1);
    if (!firstSeen.has(token)) firstSeen.set(token, index);
  });
  return [...scores.entries()]
    .sort((left, right) => {
      const scoreDiff = right[1] - left[1];
      if (scoreDiff) return scoreDiff;
      return (firstSeen.get(left[0]) || 0) - (firstSeen.get(right[0]) || 0);
    })
    .map(([token]) => token)
    .slice(0, limit);
}

function topicHashtags(value) {
  const source = String(value || "").toLowerCase();
  const tags = [];
  if (/\byusuf\s+hamka\b/i.test(value)) tags.push("Yusuf Hamka");
  if (/hak|adil|keadilan|nuntut|tuntut|perjuang/.test(source)) tags.push("Keadilan");
  if (/ancam|diancam|tekan|intimidasi/.test(source)) tags.push("Ancaman");
  if (/oknum|petugas|backing|orang gede|orang besar/.test(source)) tags.push("Oknum");
  if (/royalti|lagu|musik/.test(source)) tags.push("Royalti Musik");
  if (/selingkuh|spill|sosmed/.test(source)) tags.push("Drama Sosmed");
  if (/usaha|bisnis|jualan|dagang/.test(source)) tags.push("Bisnis");
  return tags;
}

function meaningfulTokens(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token) && !isUnsafeHashtagToken(token));
}

function toHashtag(value) {
  const words = meaningfulTokens(value)
    .filter((word) => !GENERIC_HASHTAGS.has(word))
    .slice(0, 3);
  if (!words.length) return "";
  const tag = words.map(capitalizeTagPart).join("");
  if (tag.length < 3 || tag.length > 36) return "";
  return sanitizeHashtag(`#${tag}`);
}

function capitalizeTagPart(value) {
  const cleaned = String(value || "").toLowerCase();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function extractHashtags(value) {
  return String(value || "").match(/#[\p{L}\p{N}_]+/gu) || [];
}

function stripHashtags(value) {
  return String(value || "")
    .replace(/(?:^|\s)#[\p{L}\p{N}_]+/gu, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

function mergeHashtags(...groups) {
  const seen = new Set();
  const merged = [];
  for (const tag of groups.flat()) {
    const normalized = normalizeHashtags([tag])[0];
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

function isGenericHashtag(value) {
  const key = String(value || "")
    .replace(/^#+/, "")
    .toLowerCase();
  return GENERIC_HASHTAGS.has(key);
}

function isUnsafeHashtag(value) {
  const key = String(value || "")
    .replace(/^#+/, "")
    .toLowerCase();
  return isUnsafeHashtagToken(key);
}

function isUnsafeHashtagToken(value) {
  const key = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  if (!key) return false;
  return UNSAFE_HASHTAG_TERMS.some((term) => key.includes(term));
}

function sanitizeHashtag(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^#+/, "")
    .replace(/[^\p{L}\p{N}_]/gu, "");
  if (!cleaned) return "";
  const tag = `#${cleaned}`;
  if (isGenericHashtag(tag) || isUnsafeHashtag(tag)) return "";
  return tag;
}

function normalizeHashtags(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "")
      .split(/[\s,]+/);

  const seen = new Set();
  const tags = [];
  for (const item of rawItems) {
    const tag = sanitizeHashtag(item);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags.slice(0, 8);
}

function primaryCaptionName(output = {}) {
  const source = [
    output?.title,
    output?.hook,
    output?.selectedAngle,
    output?.caption,
    output?.clipTranscript
  ].filter(Boolean).join(" ");
  const known = [
    "Ahmad Dhani",
    "Ariel NOAH",
    "Ayu Ting Ting",
    "Deddy Corbuzier",
    "Raditya Dika",
    "Yusuf Hamka",
    "Vidi Aldiano",
    "Vincent",
    "Desta"
  ];
  const foundKnown = known.find((name) => new RegExp(`\\b${name.replace(/\s+/g, "\\s+")}\\b`, "i").test(source));
  if (foundKnown) return foundKnown;
  return namedPhrases(source).find((name) => !isGenericHashtag(name) && !isUnsafeHashtag(name)) || "";
}

function ensurePrimaryNameInCaption(body, output = {}) {
  const name = primaryCaptionName(output);
  if (!name) return body;
  if (normalizeCaptionBody(body).toLowerCase().includes(name.toLowerCase())) return body;
  const blocks = splitCaptionParagraphs(body);
  if (!blocks.length) return body;
  blocks[0] = tightenCaptionLine(`${name} punya sudut pandang yang bikin kepikiran.`, CAPTION_HOOK_MAX_CHARS);
  return dedupeCaptionBlocks(blocks).join("\n\n");
}

const GENERIC_HASHTAGS = new Set([
  "podcast",
  "podcastindonesia",
  "podcastartis",
  "reels",
  "reelsindonesia",
  "short",
  "shorts",
  "shortsindonesia",
  "fyp",
  "foryou",
  "viral",
  "trending",
  "kontenviral",
  "clip",
  "klip",
  "video",
  "indonesia",
  "artis"
]);

const BASE_HASHTAGS = [
  "#Motivasi",
  "#MotivasiHidup",
  "#Inspirasi"
];

const STIFF_CAPTION_OPENERS = [
  /^\s*obrolan\s+ini\s*/giu,
  /^\s*caption\s*:\s*/giu,
  /^\s*hook\s*:\s*/giu,
  /^\s*isi\s*:\s*/giu
];

const UNSAFE_HASHTAG_TERMS = [
  "judi",
  "judionline",
  "slot",
  "togel",
  "casino",
  "taruhan",
  "betting",
  "pinjol",
  "pinjamanonline",
  "paylater",
  "riba",
  "utangonline",
  "kreditonline",
  "sara",
  "rasis",
  "porn",
  "porno",
  "narkoba",
  "ganja",
  "sabu",
  "bokep",
  "senjata",
  "bom",
  "teroris",
  "islam",
  "kristen",
  "katolik",
  "hindu",
  "buddha",
  "yahudi"
];

const HASHTAG_LIMIT = 3;
const CAPTION_MAX_CHARS = 480;
const CAPTION_HOOK_MAX_CHARS = 90;
const CAPTION_BODY_MAX_CHARS = 190;
const CAPTION_BODY_SHORT_MAX_CHARS = 150;
const CAPTION_CTA_MAX_CHARS = 80;

const INCOMPLETE_CAPTION_END_RE = /(?:\.{3}|…|[,;:]|\s[-–]|\b(?:dan|atau|karena|yang|untuk|dengan|ke|di|dari|agar|supaya|kalau|tapi|jadi|sehingga|lalu|terus|bahwa|seperti|saat|ketika|biar))$/i;

const STOPWORDS = new Set([
  ...GENERIC_HASHTAGS,
  "ada",
  "agar",
  "akan",
  "aku",
  "amat",
  "anda",
  "apa",
  "apakah",
  "atau",
  "bagai",
  "bagaimana",
  "bagian",
  "bagi",
  "bahwa",
  "banyak",
  "baru",
  "begini",
  "begitu",
  "belum",
  "bisa",
  "buat",
  "bukan",
  "cuma",
  "dan",
  "dari",
  "dalam",
  "dengan",
  "dia",
  "diri",
  "dong",
  "gak",
  "harus",
  "ini",
  "itu",
  "jadi",
  "jangan",
  "juga",
  "kalau",
  "kamu",
  "karena",
  "kata",
  "ke",
  "ketika",
  "kita",
  "lagi",
  "lebih",
  "mereka",
  "mungkin",
  "nggak",
  "nih",
  "nya",
  "orang",
  "pada",
  "paling",
  "para",
  "punya",
  "saat",
  "saja",
  "saling",
  "sama",
  "sampai",
  "sangat",
  "sebagai",
  "sedang",
  "seperti",
  "siapa",
  "soal",
  "sudah",
  "supaya",
  "tapi",
  "telah",
  "tentang",
  "terus",
  "tidak",
  "untuk",
  "waktu",
  "yang",
  "your",
  "with",
  "this",
  "that",
  "what",
  "when",
  "where",
  "about",
  "from",
  "into",
  "how",
  "why"
]);

export function normalizeThumbnailText(value, fallback = DEFAULT_TITLE_FALLBACK) {
  const cleaned = String(value || "")
    .replace(/^\s*(?:judul|title|hook|teks\s+thumbnail)\s*:\s*/i, "")
    .replace(/[`"'*_#]/g, "")
    .replace(/[,:;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return cleaned.split(/\s+/).slice(0, 16).join(" ") || fallback;
}

export function isStrongThumbnailText(value) {
  const cleaned = String(value || "").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 6 || words.length > 16) return false;
  if (/[,:;]$/.test(cleaned)) return false;
  if (isOverusedTitlePattern(cleaned)) return false;
  const meaningfulCount = words.filter((word) => !STOPWORDS.has(word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))).length;
  return words.join("").length >= 24 && meaningfulCount >= 4;
}

export function fallbackThumbnailText(output) {
  const candidates = [
    output?.hook,
    output?.selectedAngle,
    output?.reason,
    output?.caption,
    output?.title
  ];

  for (const candidate of candidates) {
    const normalized = candidate ? normalizeThumbnailText(candidate, "") : "";
    if (isStrongThumbnailText(normalized)) return normalized;
  }

  const transcriptTitle = buildTranscriptThumbnailText(output?.clipTranscript);
  if (isStrongThumbnailText(transcriptTitle)) return transcriptTitle;

  return DEFAULT_TITLE_FALLBACK;
}

function buildTranscriptThumbnailText(value) {
  const words = String(value || "")
    .replace(/[^\p{L}\p{N}\s?]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word.toLowerCase()))
    .slice(0, 14);
  return normalizeThumbnailText(words.join(" "), "");
}

function isOverusedTitlePattern(value) {
  const text = String(value || "").trim();
  return OVERUSED_TITLE_PATTERNS.some((pattern) => pattern.test(text));
}

const DEFAULT_TITLE_FALLBACK = "BAGIAN INI BIKIN PENONTON BERHENTI SCROLL";

const OVERUSED_TITLE_PATTERNS = [
  /^RAHASIA\b/i,
  /\bDI BALIK\b/i,
  /\bTERBONGKAR\b/i,
  /\bTAK TERDUGA\b/i,
  /\bBIKIN PENASARAN\b/i
];
