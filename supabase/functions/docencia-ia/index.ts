import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// docencia-ia — Proxy a Claude para la demo de docencia (WHITEMOON-DOCENCIA).
//
// Antes, la demo pedia al VISITANTE su propia API key de Anthropic por prompt(),
// la guardaba en localStorage y llamaba a api.anthropic.com desde el navegador
// con `anthropic-dangerous-direct-browser-access: true`. Eso expone la clave del
// visitante en el cliente (cualquier extension, XSS o quien mire el devtools la
// lee) y encima la deja persistida en su navegador.
//
// Ahora la clave es la ANTHROPIC_API_KEY del servidor y jamas sale de aqui.
//
// Recibe (POST JSON): { messages: [{role, content}], system?, max_tokens? }
//   `content` puede ser texto plano o bloques (para la correccion por imagen).
// Devuelve: { text } | { error }
//
// Desplegar con:
//   supabase functions deploy docencia-ia --no-verify-jwt --project-ref mlaqtniujnvfxcvcourm

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS_CAP = 2000;
const MAX_MESSAGES = 12;

// La clave la paga WhiteMoon, no el visitante: restringimos quien puede gastarla.
// Sin allowlist, cualquiera podria usar esta funcion como proxy gratuito a Claude.
const ALLOWED_ORIGINS = [
  "https://nexusforgeia.github.io",
  "https://whitemoon.es",
  "https://www.whitemoon.es",
];

const SYSTEM_POR_DEFECTO =
  "Eres un asistente especializado para docentes espanoles. Responde siempre " +
  "en espanol. Sigue la normativa educativa espanola LOMLOE. Sin saludos ni " +
  "texto de relleno.";

function isAllowed(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Desarrollo local (127.0.0.1 / localhost en cualquier puerto).
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": isAllowed(origin) ? (origin as string) : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    "Content-Type": "application/json",
  };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const CORS = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!isAllowed(origin)) {
    return new Response(
      JSON.stringify({ error: "origin_not_allowed" }),
      { status: 403, headers: CORS }
    );
  }

  if (!ANTHROPIC_API_KEY) {
    console.error("docencia-ia: ANTHROPIC_API_KEY ausente en Secrets");
    return new Response(
      JSON.stringify({ error: "IA no configurada en el servidor." }),
      { status: 500, headers: CORS }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (messages.length === 0) {
      return new Response(
        JSON.stringify({ error: "messages_required" }),
        { status: 400, headers: CORS }
      );
    }

    const maxTokens = Math.min(
      Number(body?.max_tokens) || 1500,
      MAX_TOKENS_CAP
    );

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: typeof body?.system === "string" && body.system.trim()
          ? body.system
          : SYSTEM_POR_DEFECTO,
        messages: messages.slice(-MAX_MESSAGES),
      }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      // El detalle del error de Anthropic puede incluir contexto de la cuenta:
      // lo registramos server-side y al cliente solo le damos el status.
      console.error("docencia-ia: Anthropic fallo", resp.status, JSON.stringify(data));
      return new Response(
        JSON.stringify({ error: "Error " + resp.status + " al generar la respuesta." }),
        { status: 200, headers: CORS }
      );
    }

    const text = data?.content?.[0]?.text ?? "";
    return new Response(
      JSON.stringify({ text: text || "Error: respuesta vacia de la IA." }),
      { status: 200, headers: CORS }
    );
  } catch (err) {
    console.error("docencia-ia: server_error", String(err));
    return new Response(
      JSON.stringify({ error: "Error de conexion con la IA." }),
      { status: 200, headers: CORS }
    );
  }
});
