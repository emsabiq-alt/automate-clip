import test from "node:test";
import assert from "node:assert/strict";

import {
  buildThumbnailTitlePrompt,
  fallbackThumbnailText,
  isStrongThumbnailText
} from "../src/caption.js";
import { config } from "../src/config.js";
import { buildYoutubeMetadata } from "../src/youtube-publisher.js";

test("AI title skill prompt avoids repeated secret-style templates", () => {
  const prompt = buildThumbnailTitlePrompt({
    job: { theme: "podcast artis" },
    output: {
      title: "Ngiat Ngobrol soal Pacaran Beda Agama",
      selectedAngle: "Keberanian dan kepercayaan dalam hubungan lintas agama",
      clipTranscript: "Nyaman cerita soal pacaran beda agama, tapi keluarga belum tentu melihatnya sama."
    },
    promptTemplate: { thumbnail_style: "spesifik dan kuat" }
  });

  assert.match(prompt, /AI Title Skill/);
  assert.match(prompt, /jangan mengikuti template tetap/i);
  assert.match(prompt, /RAHASIA, DI BALIK, TERBONGKAR, TAK TERDUGA, BIKIN PENASARAN/);
});

test("thumbnail title validation rejects overused secret hooks", () => {
  assert.equal(
    isStrongThumbnailText("RAHASIA DI BALIK PACARAN BEDA AGAMA YANG TAK TERDUGA"),
    false
  );
  assert.equal(
    isStrongThumbnailText("PACARAN BEDA AGAMA, KELUARGA BAKAL TERIMA?"),
    true
  );
});

test("thumbnail fallback prefers the clip angle over source-like titles", () => {
  assert.equal(
    fallbackThumbnailText({
      title: "Ngiat Ngobrol soal Pacaran Beda Agama",
      selectedAngle: "Pacaran beda agama, keluarga bakal terima?",
      clipTranscript: "Nyaman cerita soal pacaran beda agama, tapi keluarga belum tentu melihatnya sama."
    }),
    "PACARAN BEDA AGAMA, KELUARGA BAKAL TERIMA?"
  );
});

test("YouTube metadata uses the AI title without appending a person suffix", () => {
  config.youtube.titlePrefix = "";
  config.youtube.tagsEnabled = false;

  const metadata = buildYoutubeMetadata({
    job: {
      source_title: "Ngiat Ngobrol soal Pacaran Beda Agama",
      source_url: "https://www.youtube.com/watch?v=OPgd9nnUizI",
      theme: "podcast artis"
    },
    output: {
      thumbnailText: "PACARAN BEDA AGAMA, KELUARGA BAKAL TERIMA?",
      selectedAngle: "Keberanian dan kepercayaan dalam hubungan lintas agama",
      title: "Ngiat Ngobrol soal Pacaran Beda Agama",
      clipTranscript: "Nyaman cerita soal pacaran beda agama, tapi keluarga belum tentu melihatnya sama."
    },
    caption: "Ngiat Ngobrol punya sudut pandang yang bikin kepikiran."
  });

  assert.equal(metadata.title, "PACARAN BEDA AGAMA, KELUARGA BAKAL TERIMA?");
  assert.equal(metadata.title.includes(" - "), false);
});
