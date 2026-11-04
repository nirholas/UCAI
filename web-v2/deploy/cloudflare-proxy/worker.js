// Reverse proxy from a custom domain to a Cloud Run service.
// Cloud Run domain mappings need Search Console verification for each domain;
// this Worker serves the hostname on Cloudflare and forwards to the run.app URL.
export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    const origin = new URL(env.ORIGIN);
    const target = new URL(incoming.pathname + incoming.search, origin);

    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Host", incoming.host);
    headers.set("X-Forwarded-Proto", "https");

    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });

    const location = response.headers.get("Location");
    if (!location) return response;

    const rewritten = new URL(location, origin);
    if (rewritten.host !== origin.host) return response;
    rewritten.protocol = "https:";
    rewritten.host = incoming.host;
    const out = new Response(response.body, response);
    out.headers.set("Location", rewritten.toString());
    return out;
  },
};
