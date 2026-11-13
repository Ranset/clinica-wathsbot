"""Marca de la clinica: nombre y logotipo. Publico para leer, SOLO administrador para cambiar; el logotipo debe ser una imagen
CUADRADA (1:1) PNG/JPG/WebP validada por sus bytes (no por el nombre ni el Content-Type), de 64 a 2048 px y hasta 1 MB."""
import hashlib
import struct
import zlib

import pytest
from sqlalchemy import select

from app.images import MAX_BYTES, ImageError, check_logo, inspect
from app.models import AuditLog, ClinicLogo
from helpers import assert_schema, check_contract


# ------------------------------------------------------------------ imagenes de prueba (solo cabeceras validas; el servidor no decodifica)
def png(w: int, h: int | None = None) -> bytes:
    """Un PNG de verdad (sin interlazado, 8 bits, escala de grises) de w x h: lo decodifica cualquier navegador."""
    h = w if h is None else h

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
    raw = b"".join(b"\x00" + b"\x80" * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def jpeg(w: int, h: int | None = None) -> bytes:
    """Cabecera JPEG con APP0 y SOF0 (lo unico que lee el servidor)."""
    h = w if h is None else h
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    sof = b"\xff\xc0" + struct.pack(">H", 11) + b"\x08" + struct.pack(">HH", h, w) + b"\x01\x01\x11\x00"
    return b"\xff\xd8" + app0 + sof + b"\xff\xd9"


def webp_lossy(w: int, h: int | None = None) -> bytes:
    h = w if h is None else h
    frame = b"\x00\x00\x00" + b"\x9d\x01\x2a" + struct.pack("<HH", w, h) + b"\x00" * 4
    chunk = b"VP8 " + struct.pack("<I", len(frame)) + frame
    return b"RIFF" + struct.pack("<I", 4 + len(chunk)) + b"WEBP" + chunk


def webp_lossless(w: int, h: int | None = None) -> bytes:
    h = w if h is None else h
    bits = (w - 1) | ((h - 1) << 14)
    frame = b"\x2f" + struct.pack("<I", bits) + b"\x00" * 12
    chunk = b"VP8L" + struct.pack("<I", len(frame)) + frame
    return b"RIFF" + struct.pack("<I", 4 + len(chunk)) + b"WEBP" + chunk


def webp_extended(w: int, h: int | None = None) -> bytes:
    h = w if h is None else h
    frame = b"\x00\x00\x00\x00" + (w - 1).to_bytes(3, "little") + (h - 1).to_bytes(3, "little") + b"\x00" * 4
    chunk = b"VP8X" + struct.pack("<I", len(frame)) + frame
    return b"RIFF" + struct.pack("<I", 4 + len(chunk)) + b"WEBP" + chunk


# ------------------------------------------------------------------ lectura de las medidas por los bytes
@pytest.mark.parametrize("data, tipo", [
    (png(128), "image/png"), (jpeg(128), "image/jpeg"), (webp_lossy(128), "image/webp"),
    (webp_lossless(128), "image/webp"), (webp_extended(128), "image/webp")])
def test_lee_tipo_y_medidas_de_la_cabecera(data, tipo):
    assert inspect(data) == (tipo, 128, 128)


def test_mide_imagenes_no_cuadradas_y_el_tamano_exacto():
    assert inspect(png(800, 600)) == ("image/png", 800, 600)
    assert inspect(jpeg(300, 200)) == ("image/jpeg", 300, 200)
    assert inspect(webp_lossless(1, 2048)) == ("image/webp", 1, 2048)
    assert inspect(webp_extended(2048, 64)) == ("image/webp", 2048, 64)
    assert check_logo(png(64)).width == 64 and check_logo(png(2048)).width == 2048          # los extremos valen


def test_jpeg_salta_otros_segmentos_antes_del_sof():
    comentario = b"\xff\xfe" + struct.pack(">H", 8) + b"hola!!"
    data = jpeg(256)
    data = data[:2] + comentario + data[2:]                                                 # COM entre SOI y APP0
    assert inspect(data) == ("image/jpeg", 256, 256)


@pytest.mark.parametrize("data, texto", [
    (png(800, 600), "debe ser cuadrada"), (jpeg(300, 200), "debe ser cuadrada"), (png(63), "muy pequeña"), (png(32), "muy pequeña"),
    (png(2049), "muy grande"), (b"", "No llegó ningún archivo"),
    (b"<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><script>alert(1)</script></svg>", "PNG, JPG o WebP"),
    (b"GIF89a" + b"\x00" * 40, "PNG, JPG o WebP"), (b"%PDF-1.4 hola", "PNG, JPG o WebP"), (b"texto cualquiera", "PNG, JPG o WebP"),
    (b"\x89PNG\r\n\x1a\n" + b"\x00" * 8, "PNG está dañado"), (b"\xff\xd8\xff\xd9", "JPG está dañado"),
    (b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 20, "WebP está dañado")])
def test_rechaza_lo_que_no_sirve_con_el_motivo(data, texto):
    with pytest.raises(ImageError, match=texto):
        check_logo(data)


def test_rechaza_un_archivo_de_mas_de_1_mb_aunque_la_cabecera_sea_buena():
    grande = png(128) + b"\x00" * MAX_BYTES
    with pytest.raises(ImageError, match="más de 1 MB"):
        check_logo(grande)
    assert len(png(128) + b"\x00" * 100) < MAX_BYTES


def test_el_error_dice_las_medidas_que_tiene():
    with pytest.raises(ImageError) as e:
        check_logo(png(800, 600))
    assert "800 × 600" in str(e.value) and "1:1" in str(e.value)


# ------------------------------------------------------------------ API
def put_logo(session, data: bytes, content_type="image/png", csrf=True):
    headers = {"X-CSRF-Token": session.csrf} if csrf else {}
    r = session.client.put("/api/settings/branding/logo", data=data, content_type=content_type, headers=headers)
    check_contract("PUT", "/api/settings/branding/logo", r)
    return r


def test_sin_logotipo_ni_nombre_propio_sale_la_marca_por_defecto_sin_iniciar_sesion(client):
    r = client.get("/api/branding")                                       # publico: lo ve hasta el login
    assert r.status_code == 200 and r.get_json() == {"name": "Clínica CUBAMEX", "logoUrl": None}
    check_contract("GET", "/api/branding", r)
    assert client.get("/api/branding/logo").status_code == 404
    assert client.get("/api/branding/logo").get_json()["error"] == "no_encontrado"


def test_el_administrador_cambia_el_nombre_y_todos_lo_ven_incluso_sin_sesion(login, client, db):
    admin = login("admin")
    r = admin.put("/api/settings/branding", {"name": "  Clínica   Santa  María \n"})
    assert r.status_code == 200 and r.get_json() == {"name": "Clínica Santa María", "logoUrl": None}      # espacios normalizados
    assert_schema("Branding", r.get_json())
    assert client.get("/api/branding").get_json()["name"] == "Clínica Santa María"                        # sin sesion
    assert login("doctor").get("/api/branding").get_json()["name"] == "Clínica Santa María"
    with db() as s:
        a = [x for x in s.scalars(select(AuditLog)) if x.action == "branding.name"][-1]
    assert a.actor_kind == "user" and a.data == {"name": "Clínica Santa María"}


@pytest.mark.parametrize("cuerpo", [{}, {"name": ""}, {"name": "   "}, {"name": 5}, {"name": None}, {"name": "x" * 81}, {"nombre": "x"}])
def test_nombre_invalido_es_422(login, cuerpo):
    r = login("admin").put("/api/settings/branding", cuerpo)
    assert r.status_code == 422 and r.get_json()["error"] == "validacion"
    assert login("admin").put("/api/settings/branding", {"name": "x" * 80}).status_code == 200            # 80 si


@pytest.mark.parametrize("who", ["staff", "doctor", "doctor2"])
def test_solo_el_administrador_cambia_la_marca(login, client, who):
    s = login(who)
    assert s.put("/api/settings/branding", {"name": "Hackeada"}).status_code == 403
    assert put_logo(s, png(128)).status_code == 403
    assert s.delete("/api/settings/branding/logo").status_code == 403
    # sin sesion: 401
    assert client.put("/api/settings/branding", json={"name": "x"}).status_code == 401
    assert client.put("/api/settings/branding/logo", data=png(128), content_type="image/png").status_code == 401
    assert client.get("/api/branding").get_json()["name"] == "Clínica CUBAMEX"                           # nada cambio


def test_sin_csrf_no_se_sube(login):
    admin = login("admin")
    r = put_logo(admin, png(128), csrf=False)
    assert r.status_code == 403 and r.get_json().get("detail") == "csrf"


def test_sube_un_logotipo_cuadrado_se_sirve_igual_y_con_su_huella(login, client, db):
    admin = login("admin")
    data = png(256)
    r = put_logo(admin, data)
    j = r.get_json()
    sha = hashlib.sha256(data).hexdigest()
    assert r.status_code == 200 and j["logoUrl"] == f"/api/branding/logo?v={sha[:12]}" and j["name"] == "Clínica CUBAMEX"
    assert_schema("Branding", j)
    # publico: el login lo muestra sin sesion
    pub = client.get("/api/branding").get_json()
    assert pub["logoUrl"] == j["logoUrl"]
    img = client.get(pub["logoUrl"])
    assert img.status_code == 200 and img.data == data and img.mimetype == "image/png"
    assert img.headers["ETag"] == f'"{sha}"' and "max-age" in img.headers["Cache-Control"]
    assert img.headers["X-Content-Type-Options"] == "nosniff" and "default-src 'none'" in img.headers["Content-Security-Policy"]
    check_contract("GET", "/api/branding/logo", img)
    # ETag: lo mismo = 304 sin cuerpo
    again = client.get("/api/branding/logo", headers={"If-None-Match": img.headers["ETag"]})
    assert again.status_code == 304 and again.data == b""
    # la bitacora guarda medidas y huella, jamas la imagen
    with db() as s:
        a = [x for x in s.scalars(select(AuditLog)) if x.action == "branding.logo_set"][-1]
        fila = s.scalars(select(ClinicLogo)).one()
    assert a.data == {"bytes": len(data), "width": 256, "height": 256, "type": "image/png", "sha256": sha[:12]}
    assert (fila.width, fila.height, fila.content_type, fila.data) == (256, 256, "image/png", data)


@pytest.mark.parametrize("data, tipo", [(jpeg(300), "image/jpeg"), (webp_lossless(300), "image/webp"), (webp_lossy(300), "image/webp"),
                                        (webp_extended(300), "image/webp")])
def test_acepta_jpg_y_webp_y_responde_con_su_tipo_real(login, client, data, tipo):
    assert put_logo(login("admin"), data, content_type=tipo).status_code == 200
    assert client.get("/api/branding/logo").mimetype == tipo


def test_el_tipo_sale_de_los_bytes_no_de_la_cabecera_que_manda_el_cliente(login, client):
    admin = login("admin")
    assert put_logo(admin, jpeg(200), content_type="image/png").status_code == 200               # dice PNG, es JPG
    assert client.get("/api/branding/logo").mimetype == "image/jpeg"
    assert put_logo(admin, png(200), content_type="application/octet-stream").status_code == 200  # no dice nada util
    assert client.get("/api/branding/logo").mimetype == "image/png"


def test_un_logotipo_nuevo_reemplaza_al_anterior_y_cambia_la_direccion(login, client, db):
    admin = login("admin")
    url1 = put_logo(admin, png(128)).get_json()["logoUrl"]
    url2 = put_logo(admin, png(192)).get_json()["logoUrl"]
    assert url1 != url2                                                                          # otra huella: ningun cache muestra el viejo
    assert client.get("/api/branding/logo").data == png(192)
    with db() as s:
        assert len(s.scalars(select(ClinicLogo)).all()) == 1                                      # una sola fila


@pytest.mark.parametrize("data, texto", [
    (png(800, 600), "cuadrada"), (jpeg(300, 200), "cuadrada"), (png(32), "pequeña"), (png(4096), "grande"),
    (b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "PNG, JPG o WebP"), (b"GIF89a..", "PNG, JPG o WebP"),
    (b"", "ningún archivo"), (b'{"name": "x"}', "PNG, JPG o WebP")])
def test_un_logotipo_invalido_es_422_con_el_motivo_y_no_cambia_nada(login, client, db, data, texto):
    admin = login("admin")
    bueno = put_logo(admin, png(128)).get_json()
    r = put_logo(admin, data, content_type="image/png")
    assert r.status_code == 422 and r.get_json()["error"] == "validacion" and texto in r.get_json()["detail"]
    assert client.get("/api/branding").get_json() == bueno                                       # sigue el logotipo anterior
    assert client.get("/api/branding/logo").data == png(128)


def test_un_logotipo_de_exactamente_1_mb_se_sube_aunque_el_tope_general_de_peticiones_sea_menor(login, client):
    justo = png(128) + b"\x00" * (MAX_BYTES - len(png(128)))
    assert len(justo) == MAX_BYTES > 1_000_000                                            # mas que el `MAX_CONTENT_LENGTH` de los webhooks
    assert put_logo(login("admin"), justo).status_code == 200
    assert len(client.get("/api/branding/logo").data) == MAX_BYTES


def test_un_archivo_enorme_se_rechaza_sin_cargarlo_entero(login, client):
    admin = login("admin")
    r = put_logo(admin, png(128) + b"\x00" * (2 * MAX_BYTES))
    assert r.status_code == 422 and "más de 1 MB" in r.get_json()["detail"]
    assert client.get("/api/branding").get_json()["logoUrl"] is None


def test_quitar_el_logotipo_vuelve_al_icono_por_defecto_y_se_puede_repetir(login, client, db):
    admin = login("admin")
    put_logo(admin, png(128))
    r = admin.delete("/api/settings/branding/logo")
    assert r.status_code == 200 and r.get_json()["logoUrl"] is None
    assert client.get("/api/branding").get_json()["logoUrl"] is None
    assert client.get("/api/branding/logo").status_code == 404
    assert admin.delete("/api/settings/branding/logo").status_code == 200                         # sin logotipo tambien vale (idempotente)
    with db() as s:
        assert s.scalars(select(ClinicLogo)).all() == []
        assert [x.action for x in s.scalars(select(AuditLog)) if x.action.startswith("branding.logo")] == ["branding.logo_set", "branding.logo_delete"]


def test_el_nombre_y_el_logotipo_son_independientes(login, client):
    admin = login("admin")
    put_logo(admin, png(128))
    admin.put("/api/settings/branding", {"name": "Otra Clínica"})
    b = client.get("/api/branding").get_json()
    assert b["name"] == "Otra Clínica" and b["logoUrl"] is not None                               # cambiar el nombre no quita el logotipo
    admin.delete("/api/settings/branding/logo")
    assert client.get("/api/branding").get_json() == {"name": "Otra Clínica", "logoUrl": None}    # quitar el logotipo no cambia el nombre
