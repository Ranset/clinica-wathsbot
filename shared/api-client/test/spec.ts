import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse } from "yaml";

/**
 * Ayudas de prueba que leen `docs/openapi.yaml` y comparan contra el, sin tocarlo:
 * `contractFetch(fetch)` envuelve un `fetch` y anota cada incumplimiento del contrato
 * (ruta inexistente, cuerpo de peticion/respuesta que no valida, estado no declarado,
 * falta de `X-CSRF-Token` donde el contrato lo exige).
 */

type Json = any; // el YAML es dinamico; aqui se lee tal cual

// `import.meta.url` no es un `file:` cuando otro paquete (admin-web, entorno jsdom) importa este archivo;
// vite-node siempre define `__dirname`.
const here = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
export const SPEC_PATH = resolve(here, "../../../docs/openapi.yaml");
export const spec: Json = parse(readFileSync(SPEC_PATH, "utf8"));

const SPEC_ID = "https://clinica.test/openapi";
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** `#/components/schemas/X` -> `<id>#/$defs/X`, en todo el arbol. */
function rewriteRefs(node: Json): Json {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === "$ref" && typeof v === "string" ? v.replace("#/components/schemas/", `${SPEC_ID}#/$defs/`) : rewriteRefs(v);
    }
    return out;
  }
  return node;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addFormat("password", true);
ajv.addSchema({ $id: SPEC_ID, $defs: rewriteRefs(spec.components.schemas) });

const compiled = new Map<string, ValidateFunction>();
export function validatorFor(schema: Json, key: string): ValidateFunction {
  let v = compiled.get(key);
  if (!v) {
    v = ajv.compile(rewriteRefs(schema));
    compiled.set(key, v);
  }
  return v;
}

export type SpecOperation = {
  operationId: string;
  method: (typeof METHODS)[number];
  path: string;
  op: Json;
  regex: RegExp;
};

export const operations: SpecOperation[] = Object.entries<Json>(spec.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((method) => ({
    operationId: item[method].operationId as string,
    method,
    path,
    op: { ...item[method], parameters: [...(item.parameters ?? []), ...(item[method].parameters ?? [])] },
    regex: new RegExp("^" + path.replace(/\{\w+\}/g, "[^/]+") + "/?$"),
  }))
);

export function findOperation(method: string, pathname: string): SpecOperation | undefined {
  return operations.find((o) => o.method === method.toLowerCase() && o.regex.test(pathname));
}

/** Resuelve `$ref: "#/components/..."` de primer nivel (respuestas, parametros). */
function deref(node: Json): Json {
  if (node && typeof node.$ref === "string") {
    const parts = node.$ref.replace(/^#\//, "").split("/");
    return parts.reduce((acc: Json, key: string) => acc?.[key], spec);
  }
  return node;
}

export const requiresCsrf = (o: SpecOperation): boolean =>
  (o.op.security ?? spec.security ?? []).some((req: Record<string, unknown>) => "csrf" in req);

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function contractFetch(
  inner: FetchLike,
  opts: { ignoreCsrfHeader?: boolean } = {}
): { fetch: FetchLike; violations: string[]; seen: Set<string> } {
  const violations: string[] = [];
  const seen = new Set<string>();

  const wrapped: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input), "http://mock.local");
    const method = (init.method ?? "GET").toUpperCase();
    const tag = `${method} ${url.pathname}`;
    const found = findOperation(method, url.pathname);
    if (!found) {
      violations.push(`${tag}: la ruta no existe en el contrato`);
      return inner(input, init);
    }
    seen.add(found.operationId);

    const headers = new Headers(init.headers);
    if (requiresCsrf(found) && !opts.ignoreCsrfHeader && !headers.get("X-CSRF-Token")) {
      violations.push(`${tag}: el contrato exige X-CSRF-Token y no se envio`);
    }
    for (const p of found.op.parameters.map(deref)) {
      if (p.in === "query" && p.required && !url.searchParams.has(p.name)) violations.push(`${tag}: falta el parametro obligatorio "${p.name}"`);
    }
    const reqSchema = deref(found.op.requestBody)?.content?.["application/json"]?.schema;
    if (reqSchema) {
      const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
      if (body === undefined) {
        if (found.op.requestBody.required) violations.push(`${tag}: el contrato exige cuerpo`);
      } else {
        const validate = validatorFor(reqSchema, `${found.operationId}:req`);
        if (!validate(body)) violations.push(`${tag}: peticion no cumple el contrato: ${ajv.errorsText(validate.errors)}`);
      }
    }

    const res = await inner(input, init);

    const declared = deref(found.op.responses[String(res.status)]);
    if (!declared) {
      violations.push(`${tag}: responde ${res.status}, que el contrato no declara (declara ${Object.keys(found.op.responses).join(", ")})`);
      return res;
    }
    const respSchema = declared.content?.["application/json"]?.schema;
    if (respSchema) {
      const body = await res.clone().json();
      const validate = validatorFor(respSchema, `${found.operationId}:${res.status}`);
      if (!validate(body)) violations.push(`${tag} -> ${res.status}: respuesta no cumple el contrato: ${ajv.errorsText(validate.errors)}`);
    }
    for (const name of Object.keys(declared.headers ?? {})) {
      if (res.status === 200 && !res.headers.has(name)) violations.push(`${tag} -> ${res.status}: falta la cabecera ${name} que declara el contrato`);
    }
    return res;
  };

  return { fetch: wrapped, violations, seen };
}
