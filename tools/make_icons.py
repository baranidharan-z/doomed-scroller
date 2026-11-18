"""Generate the extension icons: a soft-teal hourglass with rose sand on the
timer bar's dark background. Drawn at 512px and downscaled for smooth edges.

Usage (from the repo root):  python tools/make_icons.py
Requires Pillow. Writes icons/icon16.png, icon32.png, icon48.png, icon128.png.
"""
import pathlib

from PIL import Image, ImageDraw

SIZES = (16, 32, 48, 128)
CANVAS = 512
BG = (16, 16, 22, 255)        # timer bar background
GLASS = (31, 46, 46, 255)     # inside of the glass
TEAL = (143, 227, 207, 255)   # frame (calm stage accent)
ROSE = (242, 160, 173, 255)   # sand (stop stage accent)


def draw_icon() -> Image.Image:
    img = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, CANVAS - 1, CANVAS - 1), radius=112, fill=BG)

    glass = [(160, 128), (352, 128), (270, 256), (352, 384), (160, 384), (242, 256)]
    d.polygon(glass, fill=GLASS)
    # Sand: a little left on top, a pile below, a thin stream between.
    d.polygon([(214, 196), (298, 196), (262, 246), (250, 246)], fill=ROSE)
    d.line([(256, 246), (256, 330)], fill=ROSE, width=10)
    d.polygon([(178, 384), (334, 384), (256, 318)], fill=ROSE)
    # Glass outline, then the top and bottom bars.
    d.line(glass + [glass[0]], fill=TEAL, width=18, joint='curve')
    d.rounded_rectangle((128, 92, 384, 132), radius=18, fill=TEAL)
    d.rounded_rectangle((128, 380, 384, 420), radius=18, fill=TEAL)
    return img


def main() -> None:
    out = pathlib.Path(__file__).resolve().parent.parent / 'icons'
    out.mkdir(exist_ok=True)
    big = draw_icon()
    for size in SIZES:
        big.resize((size, size), Image.LANCZOS).save(out / f'icon{size}.png', optimize=True)
        print(f'wrote icons/icon{size}.png')


if __name__ == '__main__':
    main()
