import argparse
import os
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps


def int_env(name, fallback):
    try:
        return int(os.environ.get(name, "") or fallback)
    except (TypeError, ValueError):
        return fallback


def float_env(name, fallback):
    try:
        return float(os.environ.get(name, "") or fallback)
    except (TypeError, ValueError):
        return fallback


CANVAS_W = 1080
CANVAS_H = 1920
ROOT_DIR = Path(__file__).resolve().parent.parent
GOLD = (217, 164, 65)
BRIGHT_GOLD = (242, 199, 102)
DEEP_GOLD = (242, 185, 56)
WHITE = (245, 245, 245)
LIGHT_GRAY = (184, 184, 184)
BLACK = (3, 3, 3)
POSTER_TITLE_FALLBACK = "BAGIAN INI BIKIN PENONTON BERHENTI SCROLL"
PODFLASK_FRAME_ASSET = os.environ.get("PODFLASK_FRAME_ASSET", "assets/branding/frame.png")
PODFLASK_TITLE_X = int_env("PODFLASK_TITLE_X", 88)
PODFLASK_TITLE_Y = int_env("PODFLASK_TITLE_Y", 1110)
PODFLASK_TITLE_WIDTH = int_env("PODFLASK_TITLE_WIDTH", 904)
PODFLASK_TITLE_HEIGHT = int_env("PODFLASK_TITLE_HEIGHT", 286)
PODFLASK_TITLE_MAX_SIZE = int_env("PODFLASK_TITLE_MAX_SIZE", 94)
PODFLASK_TITLE_MIN_SIZE = int_env("PODFLASK_TITLE_MIN_SIZE", 48)
THUMBNAIL_CONTENT_X = int_env("THUMBNAIL_CONTENT_X", 50)
THUMBNAIL_CONTENT_Y = int_env("THUMBNAIL_CONTENT_Y", 243)
THUMBNAIL_CONTENT_WIDTH = int_env("THUMBNAIL_CONTENT_WIDTH", 986)
THUMBNAIL_CONTENT_HEIGHT = int_env("THUMBNAIL_CONTENT_HEIGHT", 796)
THUMBNAIL_SOURCE_CROP_X = int_env("THUMBNAIL_SOURCE_CROP_X", 50)
THUMBNAIL_SOURCE_CROP_Y = int_env("THUMBNAIL_SOURCE_CROP_Y", 243)
THUMBNAIL_SOURCE_CROP_WIDTH = int_env("THUMBNAIL_SOURCE_CROP_WIDTH", 986)
THUMBNAIL_SOURCE_CROP_HEIGHT = int_env("THUMBNAIL_SOURCE_CROP_HEIGHT", 796)
TITLE_FRAME_ASSET = os.environ.get("THUMBNAIL_TITLE_FRAME_ASSET", "assets/branding/framejudulnew.png")
TITLE_FRAME_SOURCE_ASSET = os.environ.get("THUMBNAIL_TITLE_FRAME_SOURCE_ASSET", "assets/branding/framejudulnew-source.png")
TITLE_FRAME_WIDTH = int_env("THUMBNAIL_TITLE_FRAME_WIDTH", 940)
TITLE_FRAME_TOP = int_env("THUMBNAIL_TITLE_FRAME_TOP", 825)
VIDEO_TITLE_FRAME_WIDTH = int_env("VIDEO_TITLE_FRAME_WIDTH", 930)
VIDEO_TITLE_FRAME_TOP = int_env("VIDEO_TITLE_FRAME_TOP", 850)
TITLE_FRAME_TEXT_RECT = (46, 26, 412, 148)
THUMBNAIL_TITLE_BG_OPACITY = max(0.0, min(1.0, float_env("THUMBNAIL_TITLE_BG_OPACITY", 0.30)))
THUMBNAIL_TITLE_FRAME_OPACITY = max(0.0, min(1.0, float_env("THUMBNAIL_TITLE_FRAME_OPACITY", 0.88)))


def clean_text(value, fallback=""):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = re.sub(r"[`*_#]+", "", text)
    return text or fallback


def normalize_brand(value):
    text = clean_text(value, "@PodFlask | Podcast Highlight")
    return re.sub(r"@(?:emsa\.pro|clipperemsapro)\b", "@PodFlask", text, flags=re.IGNORECASE)


def clean_title(value):
    text = clean_text(value, POSTER_TITLE_FALLBACK).upper()
    words = text.split()
    return " ".join(words[:16]) or POSTER_TITLE_FALLBACK


def clean_quote(value):
    text = clean_text(value, "GUE BARU SADAR SETELAH KEHILANGAN")
    text = text.strip(" \"'.,")
    words = text.split()
    return " ".join(words[:11]).upper() or "GUE BARU SADAR SETELAH KEHILANGAN"


def font_candidates(role="headline"):
    env_font = os.environ.get("THUMBNAIL_FONT_FILE") or os.environ.get("VIDEO_LOWER_THIRD_FONT_FILE")
    primary_env = env_font if role in {"headline", "cta"} else None
    fonts_dir = ROOT_DIR / "assets" / "fonts"
    role_candidates = {
        "sans": [
            str(fonts_dir / "Montserrat-Variable.ttf"),
            r"C:\Windows\Fonts\Montserrat-SemiBold.ttf",
            r"C:\Windows\Fonts\Montserrat-Medium.ttf",
            r"C:\Windows\Fonts\bahnschrift.ttf",
            r"C:\Windows\Fonts\segoeui.ttf",
        ],
        "logo": [
            str(fonts_dir / "Poppins-Bold.ttf"),
            r"C:\Windows\Fonts\Poppins-Bold.ttf",
            r"C:\Windows\Fonts\arialbd.ttf",
        ],
        "cta": [
            str(fonts_dir / "BebasNeue-Regular.otf"),
            r"C:\Windows\Fonts\BebasNeue-Regular.otf",
            str(fonts_dir / "Oswald-Variable.ttf"),
            r"C:\Windows\Fonts\impact.ttf",
        ],
        "headline": [
            str(fonts_dir / "BebasNeue-Regular.otf"),
            r"C:\Windows\Fonts\BebasNeue-Regular.otf",
            str(fonts_dir / "Oswald-Variable.ttf"),
            r"C:\Windows\Fonts\impact.ttf",
        ],
    }
    candidates = [
        primary_env,
        *role_candidates.get(role, role_candidates["headline"]),
        r"C:\Windows\Fonts\ARIALNB.TTF",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\segoeuib.ttf",
        str(Path.home() / ".local/share/fonts/selawik/Selawik-Bold.ttf"),
        str(Path.home() / ".local/share/fonts/selawik/SelawikSemibold.ttf"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    return [item for item in candidates if item]


def apply_variable_weight(font, weight):
    if not weight:
        return font
    try:
        font.set_variation_by_axes([weight])
    except Exception:
        pass
    return font


def load_font(size, role="headline", weight=None):
    for item in font_candidates(role):
        try:
            path = Path(item)
            if path.exists():
                return apply_variable_weight(ImageFont.truetype(str(path), size=size), weight)
        except Exception:
            pass
    return ImageFont.load_default(size=size)


def text_size(draw, text, font, stroke_width=0):
    box = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
    return box[2] - box[0], box[3] - box[1]


def split_title(title):
    words = title.split()
    if len(words) <= 2:
        return [title]
    best = None
    for index in range(1, len(words)):
        left = " ".join(words[:index])
        right = " ".join(words[index:])
        score = abs(len(left) - len(right)) + (0 if 9 <= len(left) <= 18 else 4)
        if best is None or score < best[0]:
            best = (score, left, right)
    return [best[1], best[2]]


def split_word_to_fit(draw, word, font, max_width):
    if text_size(draw, word, font, 2)[0] <= max_width:
        return [word]
    chunks = []
    current = ""
    for char in word:
        candidate = f"{current}{char}"
        if current and text_size(draw, candidate, font, 2)[0] > max_width:
            chunks.append(current)
            current = char
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks or [word]


def ellipsize_to_width(draw, value, font, max_width):
    text = str(value or "").strip()
    if text_size(draw, text, font, 2)[0] <= max_width:
        return text
    suffix = "..."
    while text and text_size(draw, f"{text}{suffix}", font, 2)[0] > max_width:
        text = text[:-1].rstrip()
    return f"{text}{suffix}" if text else suffix


def wrap_text(draw, text, font, max_width, max_lines=2):
    words = []
    for word in text.split():
        words.extend(split_word_to_fit(draw, word, font, max_width))
    lines = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and text_size(draw, candidate, font, 2)[0] > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    if len(lines) <= max_lines:
        return lines
    kept = lines[:max_lines]
    overflow = " ".join(lines[max_lines - 1:])
    kept[-1] = ellipsize_to_width(draw, overflow, font, max_width)
    return kept


def fit_title_layout(draw, title, rect, max_width, max_size=92, min_size=34, vertical_padding=70):
    max_height = (rect[3] - rect[1]) - vertical_padding
    for max_lines in (4, 3):
        size = max_size
        while size >= min_size:
            font = load_font(size)
            lines = wrap_text(draw, title, font, max_width, max_lines=max_lines)
            line_gap = max(8, int(size * 0.14))
            heights = [text_size(draw, line, font, 4)[1] for line in lines]
            total_h = sum(heights) + line_gap * (len(lines) - 1)
            width_ok = all(text_size(draw, line, font, 4)[0] <= max_width for line in lines)
            if width_ok and total_h <= max_height:
                return lines, font, size, line_gap, heights, total_h
            size -= 2

    font = load_font(min_size)
    lines = wrap_text(draw, title, font, max_width, max_lines=4)
    lines = [ellipsize_to_width(draw, line, font, max_width) for line in lines]
    line_gap = 8
    heights = [text_size(draw, line, font, 4)[1] for line in lines]
    total_h = sum(heights) + line_gap * (len(lines) - 1)
    return lines, font, min_size, line_gap, heights, total_h


def resolve_asset_path(value):
    path = Path(value)
    if path.is_absolute():
        return path
    return ROOT_DIR / path


def load_podflask_frame(transparent_video=True):
    path = resolve_asset_path(PODFLASK_FRAME_ASSET)
    if not path.exists():
        return None
    frame = Image.open(path).convert("RGBA")
    if frame.size != (CANVAS_W, CANVAS_H):
        frame = frame.resize((CANVAS_W, CANVAS_H), Image.Resampling.LANCZOS)
    if transparent_video:
        return frame

    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (*BLACK, 255))
    canvas.alpha_composite(frame)
    return canvas


def load_title_frame(target_width=None):
    path = resolve_asset_path(TITLE_FRAME_ASSET)
    if not path.exists():
        return None, None
    frame = Image.open(path).convert("RGBA")
    source_size = frame.size
    width = min(CANVAS_W - 80, max(420, target_width or TITLE_FRAME_WIDTH))
    height = int(frame.height * (width / frame.width))
    return frame.resize((width, height), Image.Resampling.LANCZOS), source_size


def load_thumbnail_title_frame():
    source_path = resolve_asset_path(TITLE_FRAME_SOURCE_ASSET)
    path = source_path if source_path.exists() else resolve_asset_path(TITLE_FRAME_ASSET)
    if not path.exists():
        return None, None
    frame = Image.open(path).convert("RGBA")
    source_size = frame.size
    px = frame.load()
    for y in range(frame.height):
        for x in range(frame.width):
            r, g, b, a = px[x, y]
            if not a:
                continue
            if r < 58 and g < 58 and b < 58:
                px[x, y] = (r, g, b, int(a * THUMBNAIL_TITLE_BG_OPACITY))
            else:
                px[x, y] = (r, g, b, int(a * THUMBNAIL_TITLE_FRAME_OPACITY))
    width = min(CANVAS_W - 80, max(420, TITLE_FRAME_WIDTH))
    height = int(frame.height * (width / frame.width))
    return frame.resize((width, height), Image.Resampling.LANCZOS), source_size


def scaled_title_text_rect(frame_x, frame_y, frame_size, source_size):
    sx = frame_size[0] / source_size[0]
    sy = frame_size[1] / source_size[1]
    return (
        int(frame_x + TITLE_FRAME_TEXT_RECT[0] * sx),
        int(frame_y + TITLE_FRAME_TEXT_RECT[1] * sy),
        int(frame_x + TITLE_FRAME_TEXT_RECT[2] * sx),
        int(frame_y + TITLE_FRAME_TEXT_RECT[3] * sy),
    )


def add_glow(base, rect, radius, color=GOLD, strength=150):
    glow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for offset, alpha in [(16, 20), (10, 34), (5, 58)]:
        expanded = (rect[0] - offset, rect[1] - offset, rect[2] + offset, rect[3] + offset)
        gd.rounded_rectangle(expanded, radius=radius + offset, outline=(*color, min(strength, alpha)), width=4)
    glow = glow.filter(ImageFilter.GaussianBlur(9))
    base.alpha_composite(glow)


def draw_panel(draw, rect, radius, fill_alpha=232):
    draw.rounded_rectangle(rect, radius=radius, fill=(*BLACK, fill_alpha), outline=(*GOLD, 245), width=4)
    inset = 16
    inner = (rect[0] + inset, rect[1] + inset, rect[2] - inset, rect[3] - inset)
    draw.rounded_rectangle(inner, radius=max(8, radius - inset), outline=(*GOLD, 130), width=2)


def draw_transparent_panel(draw, rect, radius, fill_alpha=142):
    draw.rounded_rectangle(rect, radius=radius, fill=(*BLACK, fill_alpha), outline=(*GOLD, 225), width=4)
    inset = 16
    inner = (rect[0] + inset, rect[1] + inset, rect[2] - inset, rect[3] - inset)
    draw.rounded_rectangle(inner, radius=max(8, radius - inset), outline=(255, 255, 255, 90), width=2)


def draw_highlight(base, rect):
    shine = Image.new("RGBA", base.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shine)
    cx = (rect[0] + rect[2]) // 2
    sd.rounded_rectangle((cx - 180, rect[1] - 5, cx + 180, rect[1] + 6), radius=6, fill=(255, 220, 120, 150))
    sd.rounded_rectangle((cx - 190, rect[3] - 5, cx + 190, rect[3] + 6), radius=6, fill=(255, 184, 31, 110))
    base.alpha_composite(shine.filter(ImageFilter.GaussianBlur(5)))


def bool_env(name, fallback=False):
    value = os.environ.get(name)
    if value is None or value == "":
        return fallback
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def draw_glow_line(base, y, x1=110, x2=970, color=GOLD):
    glow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.rounded_rectangle((x1, y - 3, x2, y + 3), radius=3, fill=(*color, 90))
    base.alpha_composite(glow.filter(ImageFilter.GaussianBlur(7)))
    draw = ImageDraw.Draw(base)
    draw.line((x1, y, x2, y), fill=(*color, 210), width=2)
    draw.ellipse(((x1 + x2) // 2 - 6, y - 6, (x1 + x2) // 2 + 6, y + 6), fill=(255, 246, 220, 245))


def draw_centered_text(draw, text, y, font, fill, stroke_width=0, stroke_fill=(0, 0, 0, 0), x1=0, x2=CANVAS_W):
    width, height = text_size(draw, text, font, stroke_width)
    x = x1 + ((x2 - x1) - width) / 2
    draw.text((x, y), text, font=font, fill=fill, stroke_width=stroke_width, stroke_fill=stroke_fill)
    return height


def tracked_text_width(draw, text, font, tracking=0):
    chars = list(str(text or ""))
    if not chars:
        return 0
    return sum(text_size(draw, char, font, 0)[0] for char in chars) + tracking * (len(chars) - 1)


def draw_tracked_centered_text(draw, text, y, font, fill, tracking=0, x1=0, x2=CANVAS_W):
    chars = list(str(text or ""))
    total_w = tracked_text_width(draw, text, font, tracking)
    x = x1 + ((x2 - x1) - total_w) / 2
    for char in chars:
        draw.text((x, y), char, font=font, fill=fill)
        x += text_size(draw, char, font, 0)[0] + tracking
    return text_size(draw, text, font, 0)[1]


def fit_single_line(draw, text, max_width, max_size, min_size, role="headline", weight=None, tracking=0):
    size = max_size
    while size >= min_size:
        font = load_font(size, role=role, weight=weight)
        width = tracked_text_width(draw, text, font, tracking) if tracking else text_size(draw, text, font, 2)[0]
        if width <= max_width:
            return font
        size -= 2
    return load_font(min_size, role=role, weight=weight)


def fit_poster_title(draw, title, max_width, max_height, max_size=94, min_size=52):
    size = max_size
    while size >= min_size:
        font = load_font(size, role="headline")
        lines = wrap_text(draw, title, font, max_width, max_lines=3)
        line_gap = max(8, int(size * 0.07))
        heights = [text_size(draw, line, font, 4)[1] for line in lines]
        total_h = sum(heights) + line_gap * (len(lines) - 1)
        width_ok = all(text_size(draw, line, font, 4)[0] <= max_width for line in lines)
        if width_ok and total_h <= max_height:
            return lines, font, line_gap, heights, total_h
        size -= 2
    font = load_font(min_size, role="headline")
    lines = wrap_text(draw, title, font, max_width, max_lines=3)
    line_gap = 8
    heights = [text_size(draw, line, font, 4)[1] for line in lines]
    total_h = sum(heights) + line_gap * (len(lines) - 1)
    return lines, font, line_gap, heights, total_h


def poster_title_lines(title):
    words = clean_title(title).split()
    sample = ["BAGIAN", "INI", "BIKIN", "PENONTON", "BERHENTI", "SCROLL"]
    if words == sample:
        return ["BAGIAN INI BIKIN", "PENONTON BERHENTI", "SCROLL"]
    if len(words) >= 7:
        first = " ".join(words[:3])
        middle_count = max(2, min(4, len(words) - 5))
        middle = " ".join(words[3:3 + middle_count])
        last = " ".join(words[3 + middle_count:])
        return [first, middle, last]
    if len(words) >= 5:
        return [" ".join(words[:2]), " ".join(words[2:4]), " ".join(words[4:])]
    return wrap_text(ImageDraw.Draw(Image.new("RGBA", (CANVAS_W, CANVAS_H))), " ".join(words), load_font(86), 900, max_lines=3)


def fit_poster_title_fonts(draw, lines, max_width, max_height):
    sizes = [88, 110, 82]
    while min(sizes) >= 46:
        fonts = [load_font(size, role="headline") for size in sizes[:len(lines)]]
        heights = [text_size(draw, line, font, 4)[1] for line, font in zip(lines, fonts)]
        gaps = [-2, 0] if len(lines) >= 3 else [6]
        total_h = sum(heights) + sum(gaps[:max(0, len(lines) - 1)])
        width_ok = all(text_size(draw, line, font, 4)[0] <= max_width for line, font in zip(lines, fonts))
        if width_ok and total_h <= max_height:
            return fonts, gaps, heights, total_h
        sizes = [size - 2 for size in sizes]
    fonts = [load_font(max(42, size), role="headline") for size in sizes[:len(lines)]]
    heights = [text_size(draw, line, font, 4)[1] for line, font in zip(lines, fonts)]
    gaps = [-2, 0] if len(lines) >= 3 else [6]
    total_h = sum(heights) + sum(gaps[:max(0, len(lines) - 1)])
    return fonts, gaps, heights, total_h


def fit_podflask_title(draw, title, rect):
    max_width = rect[2] - rect[0]
    max_height = rect[3] - rect[1]
    title = clean_title(title)
    for max_lines in (3, 2, 4):
        size = PODFLASK_TITLE_MAX_SIZE
        while size >= PODFLASK_TITLE_MIN_SIZE:
            font = load_font(size, role="headline")
            lines = wrap_text(draw, title, font, max_width, max_lines=max_lines)
            line_gap = max(2, int(size * 0.04))
            boxes = [draw.textbbox((0, 0), line, font=font, stroke_width=4) for line in lines]
            heights = [box[3] - box[1] for box in boxes]
            total_h = sum(heights) + line_gap * (len(lines) - 1)
            width_ok = all((box[2] - box[0]) <= max_width for box in boxes)
            if width_ok and total_h <= max_height:
                return lines, font, line_gap, boxes, total_h
            size -= 2

    font = load_font(PODFLASK_TITLE_MIN_SIZE, role="headline")
    lines = wrap_text(draw, title, font, max_width, max_lines=3)
    boxes = [draw.textbbox((0, 0), line, font=font, stroke_width=4) for line in lines]
    total_h = sum(box[3] - box[1] for box in boxes) + 2 * (len(lines) - 1)
    return lines, font, 2, boxes, total_h


def draw_podflask_title(canvas, title):
    rect = (
        PODFLASK_TITLE_X,
        PODFLASK_TITLE_Y,
        min(CANVAS_W - 64, PODFLASK_TITLE_X + PODFLASK_TITLE_WIDTH),
        min(CANVAS_H - 420, PODFLASK_TITLE_Y + PODFLASK_TITLE_HEIGHT),
    )
    draw = ImageDraw.Draw(canvas)
    lines, font, line_gap, boxes, total_h = fit_podflask_title(draw, title, rect)
    y = rect[1] + ((rect[3] - rect[1]) - total_h) / 2
    for index, (line, box) in enumerate(zip(lines, boxes)):
        width = box[2] - box[0]
        height = box[3] - box[1]
        x = rect[0] + ((rect[2] - rect[0]) - width) / 2
        fill = DEEP_GOLD if index == 1 and len(lines) > 1 else WHITE
        draw.text(
            (x - box[0], y - box[1]),
            line,
            font=font,
            fill=fill,
            stroke_width=4,
            stroke_fill=(0, 0, 0, 235),
        )
        y += height + line_gap


def cut_transparent_round_rect(image, rect, radius):
    alpha = image.getchannel("A")
    mask = Image.new("L", image.size, 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle(rect, radius=radius, fill=255)
    alpha.paste(0, (0, 0), mask)
    image.putalpha(alpha)


def draw_podcast_reference_layout(canvas, title, transparent_video=False):
    title = clean_title(title)
    draw = ImageDraw.Draw(canvas)

    if transparent_video:
        cut_transparent_round_rect(canvas, (40, 228, 1040, 1024), 60)
    else:
        draw.rounded_rectangle((40, 228, 1040, 1024), radius=60, fill=(0, 0, 0, 244))

    pill = (318, 128, 762, 196)
    add_glow(canvas, pill, 30, GOLD, 100)
    draw.rounded_rectangle(pill, radius=34, fill=(5, 5, 5, 225), outline=(*BRIGHT_GOLD, 245), width=3)
    draw.ellipse((356, 158, 370, 172), fill=(255, 244, 206, 255))
    label_font = fit_single_line(draw, "PODCAST HIGHLIGHT", 320, 28, 20, role="sans", weight=600, tracking=6)
    draw_tracked_centered_text(draw, "PODCAST HIGHLIGHT", 151, label_font, BRIGHT_GOLD, tracking=6, x1=390, x2=724)

    video_rect = (32, 216, 1048, 1038)
    add_glow(canvas, video_rect, 64, GOLD, 125)
    draw.rounded_rectangle(video_rect, radius=66, outline=(*GOLD, 245), width=4)
    draw.rounded_rectangle((48, 232, 1032, 1022), radius=54, outline=(*GOLD, 130), width=2)
    draw_highlight(canvas, video_rect)

    title_area = (80, 1080, 1000, 1396)
    lines = poster_title_lines(title)
    fonts, gaps, heights, total_h = fit_poster_title_fonts(draw, lines, title_area[2] - title_area[0], title_area[3] - title_area[1])
    y = title_area[1] + ((title_area[3] - title_area[1]) - total_h) // 2
    for index, line in enumerate(lines):
        fill = DEEP_GOLD if index == 1 else WHITE
        h = draw_centered_text(
            draw,
            line,
            y,
            fonts[index],
            fill,
            stroke_width=4,
            stroke_fill=(0, 0, 0, 235),
            x1=title_area[0],
            x2=title_area[2],
        )
        y += h + (gaps[index] if index < len(lines) - 1 else 0)

    draw_glow_line(canvas, 1450, 130, 950)
    brand_line = "PodFlask | Podcast Highlight | Viral Recap"
    meta_font = fit_single_line(draw, brand_line, 760, 29, 19, role="sans", weight=500, tracking=3)
    draw_tracked_centered_text(draw, brand_line, 1481, meta_font, GOLD, tracking=3)

    logo_rect = (50, 1532, 276, 1770)
    add_glow(canvas, logo_rect, 60, GOLD, 80)
    draw.ellipse(logo_rect, fill=(5, 5, 5, 218), outline=(*BRIGHT_GOLD, 235), width=4)
    logo_font = fit_single_line(draw, "PodFlask", 160, 42, 28, role="logo", weight=700)
    pod_w, _ = text_size(draw, "Pod", logo_font, 0)
    flask_w, _ = text_size(draw, "Flask", logo_font, 0)
    logo_x = (logo_rect[0] + logo_rect[2] - pod_w - flask_w) / 2
    logo_y = 1647
    draw.text((logo_x, logo_y), "Pod", font=logo_font, fill=WHITE)
    draw.text((logo_x + pod_w, logo_y), "Flask", font=logo_font, fill=GOLD)
    subtitle_font = fit_single_line(draw, "Podcast Highlight", 150, 17, 12, role="sans", weight=500)
    draw_centered_text(draw, "Podcast Highlight", 1697, subtitle_font, LIGHT_GRAY, x1=logo_rect[0], x2=logo_rect[2])

    support_rect = (300, 1546, 1030, 1770)
    add_glow(canvas, support_rect, 30, GOLD, 90)
    draw.rounded_rectangle(support_rect, radius=34, fill=(0, 0, 0, 210), outline=(*GOLD, 220), width=3)
    draw.line((390, 1588, 500, 1588), fill=(*GOLD, 130), width=2)
    draw.line((850, 1588, 910, 1588), fill=(*GOLD, 130), width=2)
    small_font = fit_single_line(draw, "SUPPORT PODFLASK", 330, 27, 18, role="sans", weight=600, tracking=5)
    draw_tracked_centered_text(draw, "SUPPORT PODFLASK", 1573, small_font, GOLD, tracking=5, x1=support_rect[0], x2=support_rect[2])
    cta_font = fit_single_line(draw, "LIKE • SHARE • COMMENT", 640, 62, 42, role="cta", weight=700, tracking=2)
    draw_centered_text(draw, "LIKE  •  SHARE  •  COMMENT", 1630, cta_font, WHITE, 3, (0, 0, 0, 220), x1=support_rect[0], x2=support_rect[2])
    join_font = fit_single_line(draw, "JOIN THE CONVERSATION", 430, 27, 18, role="sans", weight=500, tracking=5)
    draw_tracked_centered_text(draw, "JOIN THE CONVERSATION", 1718, join_font, GOLD, tracking=5, x1=support_rect[0], x2=support_rect[2])

    bottom_rect = (60, 1802, 1020, 1868)
    draw.rounded_rectangle(bottom_rect, radius=28, fill=(0, 0, 0, 190), outline=(*GOLD, 190), width=2)
    footer = "DENGARKAN • RESAPI • DAPATKAN INSPIRASI"
    bottom_font = fit_single_line(draw, footer, 800, 25, 16, role="sans", weight=500, tracking=5)
    draw_tracked_centered_text(draw, footer, 1822, bottom_font, GOLD, tracking=5, x1=bottom_rect[0], x2=bottom_rect[2])


def add_vignette(image):
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    px = overlay.load()
    cx, cy = image.size[0] / 2, image.size[1] / 2
    max_dist = (cx * cx + cy * cy) ** 0.5
    for y in range(0, image.size[1], 2):
        for x in range(0, image.size[0], 2):
            dist = (((x - cx) ** 2 + (y - cy) ** 2) ** 0.5) / max_dist
            alpha = int(max(0, min(120, (dist - 0.35) * 190)))
            if alpha:
                px[x, y] = (0, 0, 0, alpha)
                if x + 1 < image.size[0]:
                    px[x + 1, y] = (0, 0, 0, alpha)
                if y + 1 < image.size[1]:
                    px[x, y + 1] = (0, 0, 0, alpha)
                if x + 1 < image.size[0] and y + 1 < image.size[1]:
                    px[x + 1, y + 1] = (0, 0, 0, alpha)
    image.alpha_composite(overlay)


def save_jpeg_under_limit(image, output):
    rgb = image.convert("RGB")
    quality = 94
    while quality >= 80:
        rgb.save(output, "JPEG", quality=quality, optimize=True, progressive=True)
        if Path(output).stat().st_size <= 1_950_000:
            return
        quality -= 4
    rgb.save(output, "JPEG", quality=78, optimize=True, progressive=True)


def render_thumbnail(args):
    title = clean_title(args.title)
    if not bool_env("THUMBNAIL_USE_SOURCE_IMAGE", True):
        canvas = load_podflask_frame(transparent_video=False)
        if canvas is None:
            canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (*BLACK, 255))
            draw_podcast_reference_layout(canvas, title, transparent_video=False)
        else:
            draw_podflask_title(canvas, title)
        save_jpeg_under_limit(canvas, args.output)
        return

    base = Image.open(args.input).convert("RGB").resize((CANVAS_W, CANVAS_H), Image.Resampling.LANCZOS)
    crop_left = max(0, min(CANVAS_W - 1, THUMBNAIL_SOURCE_CROP_X))
    crop_top = max(0, min(CANVAS_H - 1, THUMBNAIL_SOURCE_CROP_Y))
    crop_right = max(crop_left + 1, min(CANVAS_W, crop_left + THUMBNAIL_SOURCE_CROP_WIDTH))
    crop_bottom = max(crop_top + 1, min(CANVAS_H, crop_top + THUMBNAIL_SOURCE_CROP_HEIGHT))
    source = base.crop((crop_left, crop_top, crop_right, crop_bottom))
    source = ImageOps.fit(
        source,
        (THUMBNAIL_CONTENT_WIDTH, THUMBNAIL_CONTENT_HEIGHT),
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    )
    source = ImageEnhance.Contrast(source).enhance(1.08)
    source = ImageEnhance.Color(source).enhance(1.10)

    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (*BLACK, 255))
    canvas.alpha_composite(source.convert("RGBA"), (THUMBNAIL_CONTENT_X, THUMBNAIL_CONTENT_Y))
    frame = load_podflask_frame(transparent_video=True)
    if frame is None:
        draw_podcast_reference_layout(canvas, title, transparent_video=True)
    else:
        canvas.alpha_composite(frame)
        draw_podflask_title(canvas, title)

    save_jpeg_under_limit(canvas, args.output)


def render_video_frame(args):
    canvas = load_podflask_frame(transparent_video=True)
    if canvas is None:
        canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (*BLACK, 255))
        draw_podcast_reference_layout(canvas, clean_title(args.title), transparent_video=True)
    else:
        draw_podflask_title(canvas, clean_title(args.title))
    canvas.save(args.output, "PNG")


def render_lower_third(args):
    quote = clean_quote(args.quote)
    brand = normalize_brand(args.brand or os.environ.get("VIDEO_LOWER_THIRD_BRAND"))
    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    rect = (92, 1542, 988, 1748)
    add_glow(canvas, rect, 26, GOLD, 120)
    draw.rounded_rectangle(rect, radius=26, fill=(0, 0, 0, 150), outline=(*GOLD, 180), width=2)
    draw.rounded_rectangle((rect[0] + 14, rect[1] + 14, rect[2] - 14, rect[3] - 14), radius=18, outline=(255, 255, 255, 45), width=1)

    max_width = rect[2] - rect[0] - 96
    quote_size = 48
    font = load_font(quote_size)
    lines = wrap_text(draw, f"\"{quote}\"", font, max_width, 2)
    while len(lines) > 1 and text_size(draw, lines[0], font, 2)[0] > max_width:
        quote_size = max(32, quote_size - 2)
        font = load_font(quote_size)
        lines = wrap_text(draw, f"\"{quote}\"", font, max_width, 2)
    line_h = font.size + 8
    y = rect[1] + 32
    for line in lines:
        width, _ = text_size(draw, line, font, 2)
        draw.text(((CANVAS_W - width) / 2, y), line, font=font, fill=WHITE, stroke_width=2, stroke_fill=(0, 0, 0, 210))
        y += line_h

    brand_font = load_font(29)
    brand_w, _ = text_size(draw, brand, brand_font, 1)
    draw.text(((CANVAS_W - brand_w) / 2, rect[3] - 45), brand, font=brand_font, fill=(215, 183, 122, 220), stroke_width=1, stroke_fill=(0, 0, 0, 190))
    draw.rounded_rectangle((180, rect[3] - 9, 900, rect[3] - 3), radius=4, fill=(255, 190, 18, 160))
    canvas.save(args.output, "PNG")


def main(argv):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    thumb = sub.add_parser("thumbnail")
    thumb.add_argument("--input", required=True)
    thumb.add_argument("--output", required=True)
    thumb.add_argument("--title", required=True)
    thumb.add_argument("--pill", default="")

    lower = sub.add_parser("lower-third")
    lower.add_argument("--output", required=True)
    lower.add_argument("--quote", required=True)
    lower.add_argument("--brand", default="")

    frame = sub.add_parser("video-frame")
    frame.add_argument("--output", required=True)
    frame.add_argument("--title", required=True)

    args = parser.parse_args(argv)
    if args.command == "thumbnail":
        render_thumbnail(args)
    elif args.command == "lower-third":
        render_lower_third(args)
    elif args.command == "video-frame":
        render_video_frame(args)


if __name__ == "__main__":
    main(sys.argv[1:])
