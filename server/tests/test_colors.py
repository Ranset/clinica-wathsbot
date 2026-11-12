"""Color elegido de un doctor: la regla de legibilidad (la misma que `isReadableOnWhite` de shared/calendar)."""
import pytest

from app.colors import HEX, contrast_with_white, is_readable_on_white

# Paleta automatica de la web (`DOCTOR_COLORS`): todos deben ser validos para guardarse como color elegido.
PALETA = ["#1d4ed8", "#c2410c", "#7e22ce", "#0e7490", "#be185d", "#4d7c0f", "#92400e", "#b91c1c", "#a16207", "#475569"]


@pytest.mark.parametrize("color", PALETA)
def test_los_colores_de_la_paleta_se_leen_con_texto_blanco(color):
    assert contrast_with_white(color) >= 4.5 and is_readable_on_white(color)


@pytest.mark.parametrize("color", ["#ffffff", "#ffff00", "#cccccc", "#a3e635", "#fde68a", "#777777", "#22c55e"])
def test_los_colores_claros_no_se_leen_con_texto_blanco(color):
    assert not is_readable_on_white(color), color


def test_el_borde_es_el_de_wcag_aa():
    # los dos grises clasicos de la frontera: #767676 da 4.54:1 (pasa) y #777777 da 4.48:1 (no)
    assert round(contrast_with_white("#767676"), 2) == 4.54 and is_readable_on_white("#767676")
    assert round(contrast_with_white("#777777"), 2) == 4.48 and not is_readable_on_white("#777777")
    assert round(contrast_with_white("#000000"), 1) == 21.0 and round(contrast_with_white("#ffffff"), 1) == 1.0


@pytest.mark.parametrize("texto", ["#1d4ed8", "#1D4ED8", "#000000"])
def test_formato_valido(texto):
    assert HEX.match(texto)


@pytest.mark.parametrize("texto", ["1d4ed8", "#1d4ed", "#1d4ed88", "#12345g", "azul", "", "#1d4ed8 ", "rgb(0,0,0)"])
def test_formato_invalido(texto):
    assert not HEX.match(texto)
