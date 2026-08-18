import type { SessionCookieConfig } from './session-config.js';

/* -------------------------------------------------------------------------- */
/* Framework-independent cookie manager.                                       */
/*                                                                             */
/* Produces and parses Set-Cookie / Cookie header strings so the session       */
/* subsystem never depends on a web framework. The raw session token is the    */
/* cookie value; the cookie is HttpOnly + Secure by default.                   */
/* -------------------------------------------------------------------------- */

export interface SerializeCookieOptions {
  /** Overrides the Max-Age (seconds). Defaults to config.maxAge. */
  maxAge?: number;
  /** Overrides the Path attribute. */
  path?: string;
}

/** Structured Set-Cookie attributes, mirroring the serialized header. */
export interface SerializedCookieAttributes {
  path: string;
  domain?: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  maxAge?: number;
}

/**
 * A serialized cookie: the `Set-Cookie` header string plus the same
 * attributes as structured fields for frameworks that need the pieces
 * (or for tests asserting the exact shape).
 */
export interface SerializedCookie {
  /** The full `Set-Cookie` header value. */
  header: string;
  /** The cookie name. */
  name: string;
  /** The cookie value — the raw session token. */
  value: string;
  /** Structured attributes mirroring the header. */
  attributes: SerializedCookieAttributes;
}

/**
 * Builds Set-Cookie values and reads Cookie headers for session tokens.
 */
export class SessionCookieManager {
  private readonly config: SessionCookieConfig;

  constructor(config: SessionCookieConfig) {
    this.config = config;
  }

  /** The configured cookie name. */
  get name(): string {
    return this.config.name;
  }

  /**
   * Builds the `Set-Cookie` header value for a freshly created session.
   *
   * @example
   * ```ts
   * const header = cookies.serialize(token, { maxAge: ttlSeconds });
   * res.setHeader('Set-Cookie', header);
   * ```
   */
  serialize(token: string, options: SerializeCookieOptions = {}): string {
    return this.serializeWithAttributes(token, options).header;
  }

  /**
   * Like {@link serialize}, but returns the header string together with the
   * structured cookie object.
   *
   * @example
   * ```ts
   * const cookie = cookies.serializeWithAttributes(token, { maxAge: ttlSeconds });
   * res.setHeader('Set-Cookie', cookie.header);
   * console.log(cookie.attributes.sameSite);
   * ```
   */
  serializeWithAttributes(token: string, options: SerializeCookieOptions = {}): SerializedCookie {
    const path = options.path ?? this.config.path;
    const maxAge = options.maxAge ?? this.config.maxAge;
    const header = this.buildHeader(token, path, maxAge);

    const attributes: SerializedCookieAttributes = {
      path,
      httpOnly: this.config.httpOnly,
      secure: this.config.secure,
      sameSite: this.config.sameSite,
    };
    if (this.config.domain) attributes.domain = this.config.domain;
    if (maxAge !== undefined) attributes.maxAge = Math.max(0, Math.floor(maxAge));

    return { header, name: this.config.name, value: token, attributes };
  }

  private buildHeader(token: string, path: string, maxAge?: number): string {
    const parts: string[] = [`${this.config.name}=${token}`];

    parts.push(`Path=${path}`);

    if (this.config.domain) {
      parts.push(`Domain=${this.config.domain}`);
    }

    if (this.config.httpOnly) parts.push('HttpOnly');
    if (this.config.secure) parts.push('Secure');

    parts.push(`SameSite=${capitalize(this.config.sameSite)}`);

    if (maxAge !== undefined) {
      parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
    }

    return parts.join('; ');
  }

  /**
   * Builds the `Set-Cookie` header value that expires the cookie immediately.
   */
  clear(options: SerializeCookieOptions = {}): string {
    const parts: string[] = [`${this.config.name}=`];

    parts.push(`Path=${options.path ?? this.config.path}`);
    if (this.config.domain) {
      parts.push(`Domain=${this.config.domain}`);
    }
    parts.push('Max-Age=0');
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');

    return parts.join('; ');
  }

  /**
   * Extracts the session token from a `Cookie` request header, or null when
   * the cookie is absent or its value is empty.
   */
  parse(header: string | null | undefined): string | null {
    if (!header) return null;

    const prefix = `${this.config.name}=`;
    for (const part of header.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith(prefix)) {
        const value = trimmed.slice(prefix.length);
        return value.length > 0 ? value : null;
      }
    }
    return null;
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}