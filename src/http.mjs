import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * A JSON POST built on node:http rather than fetch.
 *
 * fetch would be the obvious choice and it cannot do this job. Node's global
 * fetch is undici, whose `headersTimeout` defaults to 300 seconds and is not
 * settable per request without a dispatcher that core does not expose. A local
 * decision model on CPU routinely takes longer than that to answer one batch,
 * and when it does the request dies as a bare `fetch failed` with the real
 * cause buried in `err.cause` - observed against Open-Jev's 2B checkpoint,
 * which needs about 4.5 seconds per question and serialises requests behind a
 * lock, so a queued batch blows past 300 seconds easily.
 *
 * node:http has no equivalent ceiling: the only clock is the one set here.
 * That is the whole reason this module exists.
 */

/**
 * True for a URL served by this machine.
 *
 * Used to decide that a request was free. A provider's price is a property of
 * the hosted service, not of its wire protocol, and the two come apart the
 * moment someone points a hosted provider's base URL at a local server - a
 * proxy like stuntd, or a mock. Billing list price for those would quietly
 * inflate lifetime cost with money nobody spent.
 */
export function isLocalUrl(url) {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost") ||
      /^127\./.test(hostname)
    );
  } catch {
    return false;
  }
}

/** Thrown for a non-2xx reply, carrying the status so callers can decide. */
export class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export function postJson(url, body, headers = {}, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`invalid provider URL: ${url}`));
      return;
    }
    const payload = Buffer.from(JSON.stringify(body));
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;

    const req = send(
      target,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          Accept: "application/json",
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new HttpError(res.statusCode, text);
            err.retryAfter = res.headers["retry-after"] || null;
            reject(err);
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`provider returned invalid JSON: ${text.slice(0, 200)}`));
          }
        });
      }
    );

    // One clock covering connect, send and the entire wait for a reply. A slow
    // model is not a broken connection, so this is the only limit that applies.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err) => {
      // ECONNREFUSED is by far the most common failure for a local provider and
      // deserves to say what it means rather than print an errno.
      if (err.code === "ECONNREFUSED") {
        reject(new Error(`nothing is listening at ${target.origin} (is the server running?)`));
      } else {
        reject(err);
      }
    });
    req.end(payload);
  });
}
