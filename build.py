"""Build the installable PWA into dist/.

app/index.html is written as a page body (it is also published as-is as a hosted
preview), so this wraps it in a full HTML document with the PWA manifest link.
Usage: python3 build.py   then serve dist/ over HTTPS (or localhost).
"""
import pathlib
import shutil

ROOT = pathlib.Path(__file__).parent
SRC, OUT = ROOT / "app", ROOT / "dist"

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon.svg">
<meta name="apple-mobile-web-app-capable" content="yes">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>
"""

def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    body = (SRC / "index.html").read_text(encoding="utf-8")
    # Head-level tags (title, meta, link, style) stay in <head>; the rest goes in <body>.
    split = body.index('<div id="app">')
    (OUT / "index.html").write_text(HEAD + body[:split] + "</head>\n<body>\n" + body[split:] + "\n</body>\n</html>\n", encoding="utf-8")
    for name in ["kb.js", "engine.js", "app.js", "sw.js", "manifest.webmanifest", "icon.svg"]:
        shutil.copy(SRC / name, OUT / name)
    print(f"Built {OUT}")

if __name__ == "__main__":
    main()
