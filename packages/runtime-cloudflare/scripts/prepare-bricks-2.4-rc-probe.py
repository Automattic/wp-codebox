#!/usr/bin/env python3
"""Build the exact Bricks 2.4-rc compatibility artifact used by this probe."""

from __future__ import annotations

import argparse
import hashlib
import tempfile
import zipfile
from pathlib import Path

SOURCE_SHA256 = "a97171e889ff82a92949dff994f10ceeb38cc70d46d7df3d97d3522562c2e887"
OUTPUT_SHA256 = "fb36858225fbf4511d22684046bcbec275f84689fdd2f0e80f312da4fd72527a"

REPLACEMENTS = {
    "bricks/includes/abilities/site-foundation.php": [
        (
            "\t\t\t\t\t\t\t'buttons'    => [ 'background' => [ 'color' => [ 'raw' => \"var(--{$primary})\" ] ] ],",
            "\t\t\t\t\t\t\t'button'     => [ 'background' => [ 'color' => [ 'raw' => \"var(--{$primary})\" ] ] ],",
        )
    ],
    "bricks/includes/html-to-bricks/element-mapper.php": [
        (
            """\t\t\t$bricks_element['settings']['_importImage'] = [
\t\t\t\t'url' => $src,
\t\t\t\t'alt' => $alt ? $alt : '',
\t\t\t];

\t\t\t$bricks_element['settings']['image'] = [
\t\t\t\t'url'           => $src,
\t\t\t\t'isPlaceholder' => true,
\t\t\t];""",
            """\t\t\t$bricks_element['settings']['image'] = [
\t\t\t\t'url'      => $src,
\t\t\t\t'external' => true,
\t\t\t];""",
        )
    ],
    "bricks/includes/abilities/workspace.php": [
        (
            """\t\t$previous_global_data = \\Bricks\\Database::$global_data;
\t\t$previous_asset_state = ( new \\ReflectionClass( \\Bricks\\Assets::class ) )->getStaticProperties();
\t\t$previous_theme_state = ( new \\ReflectionClass( \\Bricks\\Theme_Styles::class ) )->getStaticProperties();""",
            """\t\t$previous_global_data = \\Bricks\\Database::$global_data;
\t\t$asset_reflection      = new \\ReflectionClass( \\Bricks\\Assets::class );
\t\t$theme_reflection      = new \\ReflectionClass( \\Bricks\\Theme_Styles::class );
\t\t$previous_asset_state  = $asset_reflection->getStaticProperties();
\t\t$previous_theme_state  = $theme_reflection->getStaticProperties();""",
        ),
        (
            "\t\t\t\t\\Bricks\\Assets::${$property} = $value;",
            "\t\t\t\t$asset_reflection->getProperty( $property )->setValue( null, $value );",
        ),
        (
            "\t\t\t\t\\Bricks\\Theme_Styles::${$property} = $value;",
            "\t\t\t\t$theme_reflection->getProperty( $property )->setValue( null, $value );",
        ),
    ],
}


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    source = args.source.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if digest(source) != SOURCE_SHA256:
        raise SystemExit(f"unexpected source SHA-256: {digest(source)}")

    with tempfile.TemporaryDirectory(prefix="bricks-2.4-rc-probe-") as temporary:
        root = Path(temporary)
        with zipfile.ZipFile(source) as archive:
            archive.extractall(root)
        for relative, replacements in REPLACEMENTS.items():
            path = root / relative
            text = path.read_text()
            for old, new in replacements:
                if text.count(old) != 1:
                    raise SystemExit(f"expected exactly one patch target in {relative}")
                text = text.replace(old, new)
            path.write_text(text)

        output.parent.mkdir(parents=True, exist_ok=True)
        # Keep the source artifact's entry order and metadata so the output hash
        # is reproducible and directly comparable with the probe artifact.
        with zipfile.ZipFile(source) as original, zipfile.ZipFile(output, "w") as patched:
            for info in original.infolist():
                path = root / info.filename
                data = b"" if info.is_dir() else path.read_bytes()
                patched.writestr(info, data)

    actual = digest(output)
    if actual != OUTPUT_SHA256:
        raise SystemExit(f"unexpected output SHA-256: {actual}")
    print(f"{actual}  {output}")


if __name__ == "__main__":
    main()
