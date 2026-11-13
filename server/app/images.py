"""Validacion de imagenes SIN decodificarlas (solo se lee la cabecera): tipo real, ancho y alto.

Se usa para el logotipo de la clinica. No hace falta Pillow: PNG, JPEG y WebP guardan sus medidas en la cabecera. El tipo se
deduce de los BYTES, nunca de lo que diga el nombre del archivo ni la cabecera `Content-Type` (el cliente miente). SVG no se
acepta a proposito: puede llevar scripts.
"""
from __future__ import annotations

from typing import NamedTuple

MAX_BYTES = 1024 * 1024          # 1 MB
MIN_SIDE = 64                    # px
MAX_SIDE = 2048                  # px

CONTENT_TYPES = ("image/png", "image/jpeg", "image/webp")


class ImageError(ValueError):
    """La imagen no sirve; el mensaje se le muestra al administrador (en espanol)."""


class ImageInfo(NamedTuple):
    content_type: str
    width: int
    height: int


def _be16(b: bytes, i: int) -> int:
    return int.from_bytes(b[i:i + 2], "big")


def _png(data: bytes) -> ImageInfo:
    # firma (8) + longitud (4) + "IHDR" (4) + ancho (4) + alto (4)
    if len(data) < 24 or data[12:16] != b"IHDR":
        raise ImageError("El archivo PNG está dañado.")
    return ImageInfo("image/png", int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big"))


_JPEG_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}   # (sin DHT, JPG, DAC)


def _jpeg(data: bytes) -> ImageInfo:
    i, n = 2, len(data)
    while i + 4 <= n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker == 0xFF:                       # relleno
            i += 1
            continue
        if marker in (0x01, 0xD8) or 0xD0 <= marker <= 0xD7:   # marcadores sin longitud
            i += 2
            continue
        seg = _be16(data, i + 2)
        if seg < 2:
            break
        if marker in _JPEG_SOF:
            if i + 9 > n:
                break
            return ImageInfo("image/jpeg", _be16(data, i + 7), _be16(data, i + 5))
        i += 2 + seg
    raise ImageError("El archivo JPG está dañado.")


def _webp(data: bytes) -> ImageInfo:
    if len(data) < 30:
        raise ImageError("El archivo WebP está dañado.")
    kind = data[12:16]
    if kind == b"VP8 ":                          # con pérdida
        if data[23:26] != b"\x9d\x01\x2a":
            raise ImageError("El archivo WebP está dañado.")
        return ImageInfo("image/webp", int.from_bytes(data[26:28], "little") & 0x3FFF, int.from_bytes(data[28:30], "little") & 0x3FFF)
    if kind == b"VP8L":                          # sin pérdida
        if data[20] != 0x2F:
            raise ImageError("El archivo WebP está dañado.")
        bits = int.from_bytes(data[21:25], "little")
        return ImageInfo("image/webp", (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
    if kind == b"VP8X":                          # extendido (animado, con transparencia…)
        return ImageInfo("image/webp", int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1)
    raise ImageError("El archivo WebP está dañado.")


def inspect(data: bytes) -> ImageInfo:
    """Tipo y medidas de la imagen, o `ImageError`. NO revisa el tamano en pixeles ni si es cuadrada: eso es `check_logo`."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return _png(data)
    if data[:3] == b"\xff\xd8\xff":
        return _jpeg(data)
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return _webp(data)
    raise ImageError("Sube una imagen PNG, JPG o WebP.")


def check_logo(data: bytes) -> ImageInfo:
    """Valida el logotipo: <= 1 MB, PNG/JPG/WebP, CUADRADO (1:1) y de 64 a 2048 px por lado. Devuelve sus medidas."""
    if not data:
        raise ImageError("No llegó ningún archivo.")
    if len(data) > MAX_BYTES:
        raise ImageError(f"La imagen pesa más de {MAX_BYTES // (1024 * 1024)} MB.")
    info = inspect(data)
    if info.width != info.height:
        raise ImageError(f"La imagen debe ser cuadrada (1:1); esta mide {info.width} × {info.height} px.")
    if info.width < MIN_SIDE:
        raise ImageError(f"La imagen es muy pequeña: mínimo {MIN_SIDE} × {MIN_SIDE} px (esta mide {info.width} × {info.height}).")
    if info.width > MAX_SIDE:
        raise ImageError(f"La imagen es muy grande: máximo {MAX_SIDE} × {MAX_SIDE} px (esta mide {info.width} × {info.height}).")
    return info
