"""Draw the MoveSafe home-screen icons. Run from the repo root: python3 scripts/generate-icons.py"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / "public" / "icons"
FOREST = (31, 77, 58, 255)
CREAM = (244, 239, 230, 255)
BRASS = (196, 146, 58, 255)
ANY_SIZES = (16, 32, 48, 72, 96, 128, 144, 152, 180, 192, 384, 512)
MASKABLE_SIZES = (192, 512)


def point(box, vx, vy):
    x, y, size = box
    return (x + vx / 64 * size, y + vy / 64 * size)


def house(draw, box):
    x, y, size = box
    shape = [
        point(box, 12, 31.5),
        point(box, 32, 13.5),
        point(box, 52, 31.5),
        point(box, 52, 53),
        point(box, 12, 53),
    ]
    draw.polygon(shape, fill=CREAM)
    door = [point(box, 28.4, 36.2), point(box, 35.6, 53)]
    radius = max(1, size * 0.015)
    draw.rounded_rectangle(door, radius=radius, fill=BRASS)
    if size >= 48:
        for left in (19.5, 38.5):
            window = [point(box, left, 32), point(box, left + 6, 37.2)]
            draw.rounded_rectangle(window, radius=max(1, size * 0.012), fill=FOREST)


def render(size, padding, rounded, opaque_corners):
    scale = 4
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0) if not opaque_corners else FOREST)
    draw = ImageDraw.Draw(image)
    if rounded and not opaque_corners:
        radius = int(canvas * 0.22)
        draw.rounded_rectangle((0, 0, canvas - 1, canvas - 1), radius=radius, fill=FOREST)
    elif opaque_corners:
        draw.rectangle((0, 0, canvas, canvas), fill=FOREST)
    pad = int(canvas * padding)
    house(draw, (pad, pad, canvas - pad * 2))
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    for size in ANY_SIZES:
        render(size, 0.16, rounded=True, opaque_corners=False).save(ROOT / f"icon-{size}.png")
    for size in MASKABLE_SIZES:
        render(size, 0.24, rounded=False, opaque_corners=True).save(ROOT / f"maskable-{size}.png")
    render(180, 0.16, rounded=False, opaque_corners=True).save(ROOT / "apple-touch-icon.png")
    print(f"Wrote icons to {ROOT}")


if __name__ == "__main__":
    main()
