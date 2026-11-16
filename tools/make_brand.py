#!/usr/bin/env python3
"""Draws Festoon's logo: a sheet of paper with a cord across it, a picture and a note hanging
from wooden clips. Writes brand/logo.svg (+ PNGs) and the app icon in extension/assets/icons/.
Needs rsvg-convert for the PNGs.
"""
import pathlib
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
INK = "#1B1A17"
PAPER = "#F4EDE0"
BLUE = "#2F6FDE"
NOTE = "#FFE07A"
WOOD = "#D9A066"
WOOD_DARK = "#B37A40"


def pin(x, y, angle):
    return f"""
  <g transform="translate({x} {y}) rotate({angle})">
    <rect x="-9" y="-30" width="18" height="58" rx="4" fill="{WOOD}" stroke="{INK}" stroke-width="5"/>
    <line x1="0" y1="-26" x2="0" y2="24" stroke="{WOOD_DARK}" stroke-width="3"/>
    <rect x="-13" y="-8" width="26" height="9" rx="4.5" fill="#C9CBC6" stroke="{INK}" stroke-width="4"/>
  </g>"""


def logo():
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect x="8" y="8" width="240" height="240" rx="56" fill="{PAPER}"/>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="none" stroke="#D9CFBD" stroke-width="3"/>
  <!-- the cord -->
  <path d="M8 70 Q128 112 248 70" fill="none" stroke="{INK}" stroke-width="7" stroke-linecap="round"/>
  <!-- a picture, hanging a little crooked -->
  <g transform="rotate(-7 82 92)">
    <rect x="34" y="90" width="98" height="78" rx="12" fill="#fff" stroke="{INK}" stroke-width="6"/>
    <rect x="45" y="101" width="76" height="56" rx="6" fill="{BLUE}"/>
    <path d="M45 146 L70 122 L88 138 L100 128 L121 148 L121 151 Q121 157 115 157 L51 157 Q45 157 45 151 Z" fill="#9EC0F5"/>
    <circle cx="103" cy="114" r="7" fill="{NOTE}"/>
  </g>
  {pin(82, 90, -7)}
  <!-- a note -->
  <g transform="rotate(6 178 92)">
    <rect x="142" y="92" width="74" height="86" rx="9" fill="{NOTE}" stroke="{INK}" stroke-width="6"/>
    <line x1="155" y1="118" x2="203" y2="118" stroke="{INK}" stroke-width="6" stroke-linecap="round"/>
    <line x1="155" y1="138" x2="196" y2="138" stroke="{INK}" stroke-width="4" stroke-linecap="round" opacity="0.45"/>
    <line x1="155" y1="154" x2="188" y2="154" stroke="{INK}" stroke-width="4" stroke-linecap="round" opacity="0.45"/>
  </g>
  {pin(178, 92, 6)}
</svg>
"""


def main():
    brand = ROOT / "brand"
    brand.mkdir(exist_ok=True)
    svg = logo()
    (brand / "logo.svg").write_text(svg)
    icons = ROOT / "extension" / "assets" / "icons"
    (icons / "festoon.svg").write_text(svg)
    if shutil.which("rsvg-convert"):
        for size in (256, 512):
            subprocess.run(["rsvg-convert", "-w", str(size), str(brand / "logo.svg"), "-o", str(brand / f"logo-{size}.png")], check=True)
        docs = ROOT / "docs" / "assets"
        docs.mkdir(parents=True, exist_ok=True)
        subprocess.run(["rsvg-convert", "-w", "64", str(brand / "logo.svg"), "-o", str(docs / "favicon.png")], check=True)
        subprocess.run(["rsvg-convert", "-w", "180", str(brand / "logo.svg"), "-o", str(docs / "apple-touch-icon.png")], check=True)
        shutil.copy(brand / "logo.svg", docs / "logo.svg")
    print("brand written")


if __name__ == "__main__":
    main()
