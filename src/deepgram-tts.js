import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const DEFAULT_TTS_PROVIDER = "openai";
const DEFAULT_DEEPGRAM_TTS_MODEL = "aura-2-amalthea-en";
const DEFAULT_DEEPGRAM_TTS_SPEED = 1.5;
const DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_OPENAI_TTS_VOICE = "nova";
const DEFAULT_OPENAI_TTS_SPEED = 1.35;
const DEFAULT_TTS_VOLUME = 1.85;
const DEFAULT_TTS_TIMEOUT_MS = 45000;
const MAX_DEEPGRAM_TTS_CHARS = 2000;
const MAX_OPENAI_TTS_CHARS = 4096;
const DEFAULT_OPENAI_TTS_INSTRUCTIONS = [
  "Bicara sepenuhnya dalam Bahasa Indonesia.",
  "Gunakan pelafalan Indonesia natural seperti wanita dewasa Indonesia, jelas, tegas, percaya diri, dan cepat.",
  "Jangan memakai aksen Inggris atau intonasi bule.",
  "Baca tanpa jeda dramatis, tanpa menyuarakan tanda baca, dan cocok untuk pembuka video pendek."
].join(" ");
const INDONESIAN_NUMBER_WORDS = [
  "nol",
  "satu",
  "dua",
  "tiga",
  "empat",
  "lima",
  "enam",
  "tujuh",
  "delapan",
  "sembilan",
  "sepuluh"
];
const INDONESIAN_IPA = new Map(Object.entries({
  aku: "ˈaku",
  alasan: "aˈlasan",
  apa: "ˈapa",
  artis: "ˈartis",
  banget: "ˈbaŋət",
  baru: "ˈbaru",
  bagian: "baˈɡian",
  benar: "bəˈnar",
  bikin: "ˈbikin",
  bisa: "ˈbisa",
  cerita: "tʃəˈrita",
  cinta: "ˈtʃinta",
  coba: "ˈtʃoba",
  dari: "ˈdari",
  dia: "ˈdia",
  dulu: "ˈdulu",
  enggak: "ˈəŋɡak",
  gimana: "ɡiˈmana",
  hidup: "ˈhidup",
  hembus: "\u02c8h\u0259mbus",
  ini: "ˈini",
  ikut: "ˈikut",
  indonesia: "indoˈnesia",
  jangan: "ˈdʒaŋan",
  jatuh: "ˈdʒatuh",
  kamu: "ˈkamu",
  komunikasi: "komunika\u02c8si",
  kok: "ˈkok",
  lihat: "ˈlihat",
  mikir: "ˈmikir",
  orang: "ˈoraŋ",
  paling: "ˈpaliŋ",
  penasaran: "pənaˈsaran",
  perbaiki: "p\u0259rba\u02c8iki",
  rahasia: "raˈhasia",
  sampai: "ˈsampai",
  semua: "səˈmua",
  ternyata: "tərˈɲata",
  viral: "ˈviral",
  yang: "\u02c8ja\u014b"
}));

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function firstEnv(names, fallback = "") {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return fallback;
}

function listEnv(...names) {
  const values = [];
  for (const name of names) {
    const raw = process.env[name] || "";
    values.push(...raw.split(/[\n,;]+/).map(cleanText).filter(Boolean));
  }
  return [...new Set(values)];
}

export function deepgramTtsConfig() {
  const apiKeys = cleanText(process.env.DEEPGRAM_TTS_API_KEYS)
    ? listEnv("DEEPGRAM_TTS_API_KEYS")
    : listEnv("DEEPGRAM_TTS_API_KEY", "DEEPGRAM_API_KEYS", "DEEPGRAM_API_KEY");
  const provider = cleanText(process.env.THUMBNAIL_TTS_PROVIDER || process.env.TTS_PROVIDER || DEFAULT_TTS_PROVIDER).toLowerCase();
  const openaiModel = cleanText(process.env.OPENAI_TTS_MODEL || DEFAULT_OPENAI_TTS_MODEL);
  const openaiSpeed = clampNumber(numberEnv("OPENAI_TTS_SPEED", numberEnv("THUMBNAIL_TTS_SPEED", DEFAULT_OPENAI_TTS_SPEED)), 0.25, 4);
  const deepgramModel = cleanText(process.env.DEEPGRAM_TTS_MODEL || DEFAULT_DEEPGRAM_TTS_MODEL);
  const deepgramSpeed = clampNumber(numberEnv("DEEPGRAM_TTS_SPEED", DEFAULT_DEEPGRAM_TTS_SPEED), 0.7, 1.5);
  const fallbackProvider = cleanText(process.env.THUMBNAIL_TTS_FALLBACK_PROVIDER || "").toLowerCase();
  return {
    enabled: boolEnv("THUMBNAIL_TTS_ENABLED", true),
    provider,
    fallbackProvider,
    apiKey: apiKeys[0] || config.deepgram.apiKey || "",
    apiKeys,
    model: provider === "openai" ? openaiModel : deepgramModel,
    speed: provider === "openai" ? openaiSpeed : deepgramSpeed,
    timeoutMs: Math.max(5000, numberEnv("DEEPGRAM_TTS_TIMEOUT_SECONDS", DEFAULT_TTS_TIMEOUT_MS / 1000) * 1000),
    encoding: cleanText(process.env.DEEPGRAM_TTS_ENCODING || ""),
    container: cleanText(process.env.DEEPGRAM_TTS_CONTAINER || ""),
    sampleRate: cleanText(process.env.DEEPGRAM_TTS_SAMPLE_RATE || ""),
    bitRate: cleanText(process.env.DEEPGRAM_TTS_BIT_RATE || ""),
    mipOptOut: boolEnv("DEEPGRAM_TTS_MIP_OPT_OUT", false),
    textPrefix: cleanText(firstEnv(["THUMBNAIL_TTS_TEXT_PREFIX"], "")),
    stripPunctuation: boolEnv("THUMBNAIL_TTS_STRIP_PUNCTUATION", provider === "openai"),
    accentProfile: cleanText(process.env.DEEPGRAM_TTS_ACCENT_PROFILE || "id").toLowerCase(),
    pronunciationEnabled: boolEnv("DEEPGRAM_TTS_PRONUNCIATION_ENABLED", true),
    volume: clampNumber(numberEnv("THUMBNAIL_TTS_VOLUME", numberEnv("DEEPGRAM_TTS_VOLUME", DEFAULT_TTS_VOLUME)), 0.5, 2.2),
    openaiApiKey: cleanText(process.env.OPENAI_TTS_API_KEY || config.openai.apiKey || process.env.OPENAI_API_KEY || ""),
    openaiModel,
    openaiVoice: cleanText(process.env.OPENAI_TTS_VOICE || DEFAULT_OPENAI_TTS_VOICE),
    openaiSpeed,
    openaiInstructions: cleanText(process.env.OPENAI_TTS_INSTRUCTIONS || DEFAULT_OPENAI_TTS_INSTRUCTIONS),
    openaiResponseFormat: cleanText(process.env.OPENAI_TTS_RESPONSE_FORMAT || "mp3"),
    openaiTimeoutMs: Math.max(5000, numberEnv("OPENAI_TTS_TIMEOUT_SECONDS", DEFAULT_TTS_TIMEOUT_MS / 1000) * 1000),
    deepgramModel,
    deepgramSpeed,
    maxChars: Math.min(MAX_DEEPGRAM_TTS_CHARS, Math.max(20, numberEnv("THUMBNAIL_TTS_MAX_CHARS", 90)))
  };
}

export function buildThumbnailSpeechText(value, options = {}) {
  const settings = deepgramTtsConfig();
  const maxChars = Number(options.maxChars || settings.maxChars || 220);
  let text = cleanText(value)
    .replace(/[`*_#"'“”‘’]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[|/\\]+/g, ", ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();

  if (!text) text = "Bagian ini bikin penasaran.";

  const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, "");
  const upperLetters = letters.replace(/[^A-ZÀ-Þ]/g, "");
  if (letters.length >= 6 && upperLetters.length / letters.length > 0.82) {
    text = text.toLocaleLowerCase("id-ID");
    text = text.charAt(0).toLocaleUpperCase("id-ID") + text.slice(1);
  }

  text = truncateSpeechText(text, maxChars);
  if ((options.accentProfile || settings.accentProfile) === "id") {
    text = applyIndonesianAccentHints(text);
  }
  if (settings.stripPunctuation) {
    text = stripSpeechPunctuation(text);
  } else {
    text = text.replace(/\?{2,}/g, "?").replace(/!{2,}/g, "!");
    if (!/[.!?]$/.test(text)) text += ".";
  }
  if (settings.provider === "deepgram" && settings.pronunciationEnabled && (options.accentProfile || settings.accentProfile) === "id") {
    text = applyIndonesianPronunciationControls(text);
  }

  const prefix = cleanText(options.prefix ?? settings.textPrefix);
  return prefix ? `${prefix} ${text}` : text;
}

function applyIndonesianAccentHints(value) {
  let text = cleanText(value)
    .replace(/&/g, " dan ")
    .replace(/\bdr\b/gi, "dari")
    .replace(/\byg\b/gi, "yang")
    .replace(/\bdgn\b/gi, "dengan")
    .replace(/\bbgt\b/gi, "banget")
    .replace(/\bgue coba\b/gi, "coba")
    .replace(/\bgua coba\b/gi, "coba")
    .replace(/\bgk\b/gi, "nggak")
    .replace(/\bga\b/gi, "nggak")
    .replace(/\bgak\b/gi, "nggak")
    .replace(/\bngga\b/gi, "nggak")
    .replace(/\bnggak\b/gi, "enggak")
    .replace(/\bgue\b/gi, "aku")
    .replace(/\bgua\b/gi, "aku")
    .replace(/\blo\b/gi, "kamu")
    .replace(/\bloe\b/gi, "kamu");

  text = text.replace(/\b([0-9]|10)\b/g, (match) => INDONESIAN_NUMBER_WORDS[Number(match)] || match);
  return cleanText(text);
}

function truncateSpeechText(value, maxChars) {
  const text = cleanText(value);
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  return sliced.replace(/\s+\S*$/, "").trim() || sliced.trim();
}

function stripSpeechPunctuation(value) {
  return cleanText(String(value || "")
    .replace(/[.,!?;:]+/g, " ")
    .replace(/[()[\]{}<>]+/g, " ")
    .replace(/\s+/g, " "));
}

function applyIndonesianPronunciationControls(value) {
  return String(value || "").replace(/\b[A-Za-zÀ-ÿ]+\b/g, (word) => {
    const ipa = INDONESIAN_IPA.get(word.toLocaleLowerCase("id-ID"));
    if (!ipa) return word;
    return `\\{"word":"${word}","pronounce":"${ipa}"\\}`;
  });
}

export function stripPronunciationControls(value) {
  return String(value || "").replace(/\\\{"word":"([^"]+)","pronounce":"[^"]+"\\\}/g, "$1");
}

export async function synthesizeDeepgramSpeech(options = {}) {
  const settings = deepgramTtsConfig();
  const text = cleanText(options.text);
  const apiKeys = deepgramApiKeyCandidates(options, settings);
  if (!apiKeys.length) throw new Error("DEEPGRAM_TTS_API_KEY / DEEPGRAM_API_KEYS belum diisi.");
  if (!text) throw new Error("Teks TTS kosong.");

  const failures = [];
  for (let index = 0; index < apiKeys.length; index += 1) {
    try {
      const speech = await synthesizeDeepgramSpeechWithKey({
        apiKey: apiKeys[index],
        options,
        settings,
        text
      });
      return {
        ...speech,
        keyIndex: index + 1,
        keyCount: apiKeys.length
      };
    } catch (error) {
      const message = compactError(error);
      failures.push(`key ${index + 1}: ${message}`);
      if (index < apiKeys.length - 1) {
        console.warn(`Deepgram TTS key ${index + 1} gagal, coba key berikutnya: ${message}`);
      }
    }
  }

  throw new Error(`Semua Deepgram TTS key gagal: ${failures.join("; ")}`);
}

function deepgramApiKeyCandidates(options, settings) {
  const explicitKey = cleanText(options.apiKey);
  if (explicitKey) return [explicitKey];

  const keys = [
    ...(Array.isArray(settings.apiKeys) ? settings.apiKeys : []),
    settings.apiKey
  ].map(cleanText).filter(Boolean);

  return [...new Set(keys)];
}

async function synthesizeDeepgramSpeechWithKey({ apiKey, options, settings, text }) {
  const url = new URL("https://api.deepgram.com/v1/speak");
  url.searchParams.set("model", cleanText(options.model || settings.deepgramModel || DEFAULT_DEEPGRAM_TTS_MODEL));
  url.searchParams.set("speed", String(clampNumber(Number(options.speed || settings.deepgramSpeed), 0.7, 1.5)));
  if (settings.encoding) url.searchParams.set("encoding", settings.encoding);
  if (settings.container) url.searchParams.set("container", settings.container);
  if (settings.sampleRate) url.searchParams.set("sample_rate", settings.sampleRate);
  if (settings.bitRate) url.searchParams.set("bit_rate", settings.bitRate);
  if (settings.mipOptOut) url.searchParams.set("mip_opt_out", "true");
  if (options.tag || process.env.DEEPGRAM_TTS_TAG) {
    url.searchParams.set("tag", cleanText(options.tag || process.env.DEEPGRAM_TTS_TAG));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || settings.timeoutMs));
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "audio/mpeg, audio/*, application/json"
      },
      body: JSON.stringify({ text: text.slice(0, MAX_DEEPGRAM_TTS_CHARS) }),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Deepgram TTS gagal (${response.status}): ${detail.slice(0, 400)}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer.length) throw new Error("Deepgram TTS mengembalikan audio kosong.");

    return {
      buffer,
      provider: "deepgram",
      mimeType: response.headers.get("content-type") || "audio/mpeg",
      model: response.headers.get("dg-model-name") || url.searchParams.get("model"),
      speed: response.headers.get("dg-speed-used") || url.searchParams.get("speed"),
      requestId: response.headers.get("dg-request-id") || "",
      charCount: Number(response.headers.get("dg-char-count") || text.length)
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Deepgram TTS timeout.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function synthesizeOpenAiSpeech(options = {}) {
  const settings = deepgramTtsConfig();
  const input = cleanText(stripPronunciationControls(options.text)).slice(0, MAX_OPENAI_TTS_CHARS);
  const apiKey = cleanText(options.apiKey || settings.openaiApiKey);
  if (!apiKey) throw new Error("OPENAI_API_KEY / OPENAI_TTS_API_KEY belum diisi untuk TTS Bahasa Indonesia.");
  if (!input) throw new Error("Teks TTS kosong.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || settings.openaiTimeoutMs));
  const model = cleanText(options.model || settings.openaiModel || DEFAULT_OPENAI_TTS_MODEL);
  const voice = cleanText(options.voice || settings.openaiVoice || DEFAULT_OPENAI_TTS_VOICE);
  const speed = clampNumber(Number(options.speed || settings.openaiSpeed || DEFAULT_OPENAI_TTS_SPEED), 0.25, 4);
  const responseFormat = cleanText(options.responseFormat || settings.openaiResponseFormat || "mp3");

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "audio/mpeg, audio/*, application/json"
      },
      body: JSON.stringify({
        model,
        voice,
        input,
        instructions: cleanText(options.instructions || settings.openaiInstructions),
        response_format: responseFormat,
        speed
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OpenAI TTS gagal (${response.status}): ${detail.slice(0, 400)}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer.length) throw new Error("OpenAI TTS mengembalikan audio kosong.");

    return {
      buffer,
      provider: "openai",
      mimeType: response.headers.get("content-type") || "audio/mpeg",
      model,
      voice,
      speed: String(speed),
      requestId: response.headers.get("x-request-id") || "",
      charCount: input.length
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("OpenAI TTS timeout.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function synthesizeThumbnailSpeech(options = {}) {
  const settings = deepgramTtsConfig();
  const primaryProvider = normalizeTtsProvider(settings.provider);
  const fallbackProvider = normalizeTtsProvider(settings.fallbackProvider);

  try {
    return await synthesizeSpeechWithProvider(primaryProvider, options, settings);
  } catch (error) {
    if (!fallbackProvider || fallbackProvider === primaryProvider) throw error;

    const primaryMessage = compactError(error);
    console.warn(`TTS ${primaryProvider} gagal, fallback ke ${fallbackProvider}: ${primaryMessage}`);
    try {
      const speech = await synthesizeSpeechWithProvider(fallbackProvider, options, settings);
      return {
        ...speech,
        fallbackFrom: primaryProvider,
        fallbackError: primaryMessage
      };
    } catch (fallbackError) {
      throw new Error(
        `TTS ${primaryProvider} gagal: ${primaryMessage}; fallback ${fallbackProvider} juga gagal: ${compactError(fallbackError)}`
      );
    }
  }
}

function synthesizeSpeechWithProvider(provider, options, settings) {
  if (provider === "deepgram") {
    return synthesizeDeepgramSpeech({
      ...options,
      model: settings.deepgramModel,
      speed: settings.deepgramSpeed
    });
  }

  return synthesizeOpenAiSpeech({
    ...options,
    model: settings.openaiModel,
    speed: settings.openaiSpeed
  });
}

function normalizeTtsProvider(value) {
  const provider = cleanText(value).toLowerCase();
  if (provider === "deepgram" || provider === "openai") return provider;
  return "";
}

function compactError(error) {
  return String(error?.message || error || "unknown_error")
    .replace(/\s+/g, " ")
    .slice(0, 280);
}

export async function generateThumbnailSpeech({ job, text }) {
  const settings = deepgramTtsConfig();
  if (!settings.enabled) return null;

  const speechText = buildThumbnailSpeechText(text);
  const speech = await synthesizeThumbnailSpeech({
    text: speechText,
    tag: "thumbnail-intro"
  });

  const audioDir = path.join(config.generatedDir, "audio");
  await fs.mkdir(audioDir, { recursive: true });
  const filename = `${job.job_id}-thumbnail-tts.mp3`;
  const outputPath = path.join(audioDir, filename);
  await fs.writeFile(outputPath, speech.buffer);

  return {
    path: outputPath,
    filename,
    provider: speech.provider || settings.provider,
    fallbackFrom: speech.fallbackFrom || "",
    fallbackError: speech.fallbackError || "",
    keyIndex: speech.keyIndex || "",
    text: speechText,
    model: speech.model,
    voice: speech.voice || "",
    speed: speech.speed,
    volume: settings.volume,
    requestId: speech.requestId,
    charCount: speech.charCount,
    mimeType: speech.mimeType
  };
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
