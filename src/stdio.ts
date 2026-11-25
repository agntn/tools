/**
 * Stdio entry. Antigravity follows its 2026 discover with a bare notification, and the SDK's
 * `serveStdio` takes that for a 2025 client: no capabilities, so no `ask`.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type McpServerFactory,
  type Transport,
} from "@modelcontextprotocol/server";
import {
  serveStdio as serveEras,
  StdioServerTransport,
  type ServeStdioOptions,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";

export type { ServeStdioOptions, StdioServerHandle } from "@modelcontextprotocol/server/stdio";

/** The `_meta` keys that make a message 2026 traffic. */
const ENVELOPE = [PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY];

/**
 * The SDK's `serveStdio`, except a bare notification borrows the last 2026 envelope.
 *
 * @param factory - A fresh server per connection and per discover probe.
 * @param options - The SDK's options; a given `transport` gets wrapped too.
 * @returns {StdioServerHandle} What closes the connection.
 */
export function serveStdio(
  factory: McpServerFactory,
  options: ServeStdioOptions = {},
): StdioServerHandle {
  const transport = keepEnvelope(options.transport ?? new StdioServerTransport());
  return serveEras(factory, { ...options, transport });
}

/**
 * Lends each bare notification the envelope of the last 2026 message.
 *
 * @param inner - The transport on the wire; its handlers get taken over.
 * @returns {Transport} The transport `serveStdio` gets.
 */
function keepEnvelope(inner: Transport): Transport {
  const envelopes = new Envelopes();
  const outer: Transport = {
    start: async () => inner.start(),
    send: async (message, options) => inner.send(message, options),
    close: async () => inner.close(),
    setProtocolVersion: (version) => inner.setProtocolVersion?.(version),
  };
  const relay: NonNullable<Transport["onmessage"]> = (message, extra) => {
    if ("method" in message) {
      const params = envelopes.stamp(message.params, !("id" in message));
      if (params !== undefined) {
        outer.onmessage?.({ ...message, params }, extra);
        return;
      }
    }
    outer.onmessage?.(message, extra);
  };
  const fail: NonNullable<Transport["onerror"]> = (error) => outer.onerror?.(error);
  inner.onmessage = relay;
  inner.onerror = fail;
  inner.onclose = () => outer.onclose?.();
  return outer;
}

/** The envelope of the last 2026 message on one connection. */
class Envelopes {
  #last: Readonly<Record<string, unknown>> | undefined;

  /**
   * Reads one message's params and says what they should be.
   *
   * @param params - The `params` of a request or notification.
   * @param notification - Whether it is a notification, the only kind that borrows.
   * @returns {Readonly<Record<string, unknown>> | undefined} New params, if any.
   */
  stamp(params: unknown, notification: boolean): Readonly<Record<string, unknown>> | undefined {
    const fields = objectOf(params);
    const meta = objectOf(fields._meta);
    if (typeof meta[PROTOCOL_VERSION_META_KEY] === "string") {
      this.#last = Object.fromEntries(
        ENVELOPE.filter((key) => key in meta).map((key) => [key, meta[key]]),
      );
      return undefined;
    }
    if (!notification || this.#last === undefined) return undefined;
    return { ...fields, _meta: { ...meta, ...this.#last } };
  }
}

/**
 * A value as a plain record, or an empty one.
 *
 * @param value - Anything off the wire.
 * @returns {Readonly<Record<string, unknown>>} The object itself, or `{}` for anything else.
 */
function objectOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
