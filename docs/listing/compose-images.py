"""
Builds the App Store listing images for Anchor.

Two designed images that argue the product, then real screenshots on the same canvas so
the set reads as one thing. House rule from the listing copy applies here too: no em or
en dashes anywhere in the text.
"""

from PIL import Image, ImageDraw, ImageFilter, ImageFont
import os

SP = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(SP, "out")
SHOTS = os.path.join(SP, "shots")
os.makedirs(OUT, exist_ok=True)

NAVY_TOP = (18, 58, 102)
NAVY_BOT = (7, 22, 44)
GOLD = (242, 179, 69)
WHITE = (255, 255, 255)
SUBDUED = (168, 191, 217)
CARD = (255, 255, 255)

FONT_CANDIDATES = [
    ("/System/Library/Fonts/Avenir Next.ttc",
     {"regular": 7, "medium": 5, "demi": 2, "bold": 0, "heavy": 8}),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", None),
]


def fnt(size, weight="regular"):
    path, idx = FONT_CANDIDATES[0]
    if os.path.exists(path) and idx:
        try:
            return ImageFont.truetype(path, size, index=idx.get(weight, 0))
        except Exception:
            pass
    bold = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
    plain = "/System/Library/Fonts/Supplemental/Arial.ttf"
    return ImageFont.truetype(bold if weight in ("bold", "medium") else plain, size)


def background(w, h):
    """Navy ramp with a soft top-left glow, the same light the icon has."""
    base = Image.new("RGB", (1, h))
    px = base.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        px[0, y] = tuple(int(NAVY_TOP[i] + (NAVY_BOT[i] - NAVY_TOP[i]) * (t ** 0.85)) for i in range(3))
    canvas = base.resize((w, h), Image.BILINEAR)

    glow = Image.new("L", (96, 96), 0)
    gd = ImageDraw.Draw(glow)
    for r in range(48, 0, -1):
        gd.ellipse([28 - r, 22 - r, 28 + r, 22 + r], fill=int(70 * (1 - r / 48) ** 1.6))
    glow = glow.resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(24))
    canvas.paste(Image.new("RGB", (w, h), (90, 150, 214)), (0, 0), glow)
    return canvas


def wrap(draw, text, font, max_w):
    words, lines, line = text.split(), [], ""
    for word in words:
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=font) <= max_w:
            line = trial
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def para(draw, text, font, box_x, y, max_w, fill, leading):
    for line in wrap(draw, text, font, max_w):
        draw.text((box_x, y), line, font=font, fill=fill)
        y += leading
    return y


def tracked(draw, text, font, x, y, fill, extra=4):
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + extra


def rounded_mask(size, radius, ss=4):
    w, h = size
    m = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w * ss - 1, h * ss - 1], radius=radius * ss, fill=255)
    return m.resize((w, h), Image.LANCZOS)


def paste_shot(canvas, path, box, radius=18):
    """A screenshot as a rounded card with a soft drop shadow."""
    x, y, w, h = box
    shot = Image.open(path).convert("RGB")
    ratio = min(w / shot.width, h / shot.height)
    size = (int(shot.width * ratio), int(shot.height * ratio))
    shot = shot.resize(size, Image.LANCZOS)
    x += (w - size[0]) // 2
    y += (h - size[1]) // 2

    shadow = Image.new("RGBA", (size[0] + 90, size[1] + 90), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [45, 52, 45 + size[0], 52 + size[1]], radius=radius, fill=(0, 0, 0, 120)
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(22))
    canvas.paste(shadow, (x - 45, y - 45), shadow)

    canvas.paste(shot, (x, y), rounded_mask(size, radius))
    return size


# ----------------------------------------------------------------------------- image 1

def hero(w, h, portrait=False):
    canvas = background(w, h)
    d = ImageDraw.Draw(canvas)
    pad = 96 if not portrait else 72
    col = (w - pad * 2) if portrait else int(w * 0.52)

    y = 120 if not portrait else 150
    tracked(d, "ANCHOR", fnt(24 if not portrait else 26, "bold"), pad, y, GOLD, 6)
    y += 58 if not portrait else 64

    head = fnt(68 if not portrait else 66, "bold")
    y = para(d, "Every price knows where it came from", head, pad, y, col, WHITE,
             82 if not portrait else 80)
    y += 26

    body = fnt(27 if not portrait else 28)
    y = para(
        d,
        "Anchor computes every campaign from a baseline, the price a product would be if "
        "nothing were running. Never from whatever the storefront happens to show today.",
        body, pad, y, col, SUBDUED, 42,
    )
    y += 44

    points = [
        "Apply a campaign twice and nothing happens the second time",
        "Ending a sale restores the right price, even while another campaign runs",
        "Overlapping campaigns resolve to one winner instead of stacking",
    ]
    pf = fnt(26 if not portrait else 27, "demi")
    for point in points:
        d.ellipse([pad + 2, y + 11, pad + 15, y + 24], fill=GOLD)
        for line in wrap(d, point, pf, col - 40):
            d.text((pad + 36, y), line, font=pf, fill=WHITE)
            y += 38
        y += 18

    # The price card: the whole argument in four numbers.
    cw, ch = (470, 392) if not portrait else (w - pad * 2, 392)
    cx = w - pad - cw if not portrait else pad
    cy = (h - ch) // 2 if not portrait else h - 470
    card = Image.new("RGB", (cw, ch), CARD)
    cd = ImageDraw.Draw(card)
    cd.text((36, 34), "Alpine Backpack 133", font=fnt(27, "bold"), fill=(24, 32, 44))
    rows = [
        ("Baseline", "68.86", (110, 122, 138)),
        ("Black Friday 2026, 25% off", "", (110, 122, 138)),
        ("Live now", "51.65", (17, 24, 34)),
    ]
    ry = 96
    for label, value, colour in rows:
        cd.text((36, ry), label, font=fnt(23), fill=colour)
        if value:
            vf = fnt(30, "bold") if label == "Live now" else fnt(26)
            cd.text((cw - 36 - cd.textlength(value, font=vf), ry - 4), value, font=vf, fill=colour)
        ry += 62
    cd.rounded_rectangle([36, ry + 6, cw - 36, ry + 62], radius=10, fill=(245, 248, 252))
    cd.text((52, ry + 22), "Revert recomputes back to 68.86", font=fnt(21), fill=(70, 88, 112))

    shadow = Image.new("RGBA", (cw + 90, ch + 90), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([45, 54, 45 + cw, 54 + ch], radius=20, fill=(0, 0, 0, 130))
    canvas.paste(shadow.filter(ImageFilter.GaussianBlur(22)), (cx - 45, cy - 45), shadow.filter(ImageFilter.GaussianBlur(22)))
    canvas.paste(card, (cx, cy), rounded_mask((cw, ch), 20))
    return canvas


# ----------------------------------------------------------------------------- image 2

TILES = [
    ("Baseline pricing", "Every price is computed from a fixed reference, so campaigns never compound."),
    ("Revert recomputes", "Ending a campaign recalculates the correct price instead of restoring an old one."),
    ("Every market, properly", "Each market priced from its own normal price, in its own currency and rounding."),
    ("The preview is the run", "One planner drives both, so what you approve cannot differ from what gets written."),
    ("Read back and verified", "Every row is written, then read back. A run is clean only when all of them match."),
    ("Undo is never a paid extra", "Preview, guardrails, full history and rollback on every plan, including Free."),
]


def capabilities(w, h, portrait=False):
    canvas = background(w, h)
    d = ImageDraw.Draw(canvas)
    pad = 96 if not portrait else 72

    y = 96 if not portrait else 140
    tracked(d, "WHAT MAKES IT DIFFERENT", fnt(22, "bold"), pad, y, GOLD, 5)
    y += 52
    y = para(d, "Built for campaigns, not for bulk edits", fnt(56 if not portrait else 52, "bold"),
             pad, y, w - pad * 2, WHITE, 68)
    y += 36

    cols = 3 if not portrait else 1
    gap = 34
    tw = (w - pad * 2 - gap * (cols - 1)) // cols
    th = 212 if not portrait else 176

    tf, bf = fnt(27, "bold"), fnt(21 if not portrait else 22)
    for i, (title, blurb) in enumerate(TILES):
        cx = pad + (i % cols) * (tw + gap)
        cy = y + (i // cols) * (th + gap)
        tile = Image.new("RGBA", (tw, th), (255, 255, 255, 18))
        td = ImageDraw.Draw(tile)
        td.rounded_rectangle([0, 0, tw - 1, th - 1], radius=16, fill=(255, 255, 255, 20),
                             outline=(255, 255, 255, 46), width=2)
        td.rounded_rectangle([26, 26, 30, 52], radius=2, fill=GOLD + (255,))
        ty = 72
        for line in wrap(td, title, tf, tw - 52):
            td.text((26, ty), line, font=tf, fill=WHITE + (255,))
            ty += 36
        ty += 6
        for line in wrap(td, blurb, bf, tw - 52):
            td.text((26, ty), line, font=bf, fill=SUBDUED + (255,))
            ty += 30
        canvas.paste(tile, (cx, cy), tile)
    return canvas


# ------------------------------------------------------------------- screenshot frames

def shot_frame(w, h, path, title, blurb, portrait=False):
    canvas = background(w, h)
    d = ImageDraw.Draw(canvas)
    pad = 84 if not portrait else 64

    y = 76 if not portrait else 120
    y = para(d, title, fnt(46 if not portrait else 44, "bold"), pad, y, w - pad * 2, WHITE,
             56 if not portrait else 54)
    y += 12
    y = para(d, blurb, fnt(25 if not portrait else 26), pad, y, int((w - pad * 2) * 0.86), SUBDUED, 38)
    y += 40

    paste_shot(canvas, path, (pad, y, w - pad * 2, h - y - (58 if not portrait else 90)))
    return canvas


DESKTOP = [
    ("03-whats-live", "01-whats-live.jpg",
     "Every live price, and the campaign that set it",
     "One page for base price and every market, next to the baseline each was computed from. "
     "Anything edited outside the app is flagged with both numbers."),
    ("04-preview", "02-new-campaign-live-preview.jpg",
     "See the exact rows before a single one is written",
     "The preview recomputes as you build the rule, showing the baseline and what it becomes. "
     "The same planner does the writing, so the two cannot disagree."),
    ("05-calendar", "03-calendar-overlap.jpg",
     "Two sales on the same products, resolved",
     "The calendar shows which campaigns run together and how many products they share. "
     "The higher priority one wins every shared product, and nothing ever stacks."),
    ("06-ledger", "05-ledger.jpg",
     "A ledger written before the prices were",
     "What each variant was, what was intended, and whether it was read back and verified. "
     "Roll back a single variant or the whole campaign, on every plan."),
]

MOBILE = [
    ("m03-home", "mobile/m01-home.jpg",
     "Everything live, at a glance",
     "What is running, what is scheduled, and what needs attention."),
    ("m04-campaigns", "mobile/m02-campaigns.jpg",
     "Campaigns, not one off edits",
     "Each one has a rule, a scope, a schedule and a priority."),
    ("m05-whats-live", "mobile/m03-whats-live.jpg",
     "Base price and every market",
     "Each surface priced in its own currency, from its own baseline."),
]


def build():
    hero(1600, 900).save(f"{OUT}/desktop-01-hero.png")
    capabilities(1600, 900).save(f"{OUT}/desktop-02-capabilities.png")
    for name, shot, title, blurb in DESKTOP:
        shot_frame(1600, 900, f"{SHOTS}/{shot}", title, blurb).save(f"{OUT}/desktop-{name}.png")

    hero(900, 1600, portrait=True).save(f"{OUT}/mobile-01-hero.png")
    capabilities(900, 1600, portrait=True).save(f"{OUT}/mobile-02-capabilities.png")
    for name, shot, title, blurb in MOBILE:
        shot_frame(900, 1600, f"{SHOTS}/{shot}", title, blurb, portrait=True).save(f"{OUT}/mobile-{name}.png")

    for f in sorted(os.listdir(OUT)):
        if f.endswith(".png"):
            print(f, Image.open(f"{OUT}/{f}").size)


build()
