/**
 * Copia `text` al portapapeles. Devuelve `false` si el navegador no lo permite (página sin HTTPS, permiso negado...): quien llama debe
 * dejar el texto a la vista para que se copie a mano. Primero la API moderna; si no existe o falla, el método antiguo (un campo oculto).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* sigue con el método antiguo */
  }
  const box = document.createElement("textarea");
  try {
    box.value = text;
    box.setAttribute("readonly", "");
    box.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(box);
    box.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    box.remove(); // el campo oculto no se queda aunque falle
  }
}
