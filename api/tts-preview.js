import { methodAllowed, readBody, requireAuth, sendJson } from "./_utils.js";
import { buildThumbnailSpeechText, deepgramTtsConfig, stripPronunciationControls, synthesizeThumbnailSpeech } from "../src/deepgram-tts.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  if (!requireAuth(req, res)) return;

  try {
    const body = await readBody(req);
    const text = buildThumbnailSpeechText(String(body.text || ""));
    const speech = await synthesizeThumbnailSpeech({ text, tag: "dashboard-preview" });
    sendJson(res, 200, {
      ok: true,
      text,
      displayText: stripPronunciationControls(text),
      provider: speech.provider || deepgramTtsConfig().provider,
      fallbackFrom: speech.fallbackFrom || "",
      fallbackError: speech.fallbackError || "",
      keyIndex: speech.keyIndex || "",
      mimeType: speech.mimeType,
      model: speech.model,
      voice: speech.voice || "",
      speed: speech.speed,
      volume: deepgramTtsConfig().volume,
      charCount: speech.charCount,
      audioBase64: speech.buffer.toString("base64")
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}
