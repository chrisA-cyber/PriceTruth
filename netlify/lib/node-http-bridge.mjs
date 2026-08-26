import { Readable, Writable } from 'node:stream';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function requestHeaders(request, context, url) {
  const headers = Object.fromEntries(
    [...request.headers.entries()].map(([name, value]) => [name.toLowerCase(), value]),
  );
  // These values come from Netlify's trusted request context, never from a
  // caller-supplied forwarding header.
  headers.host = url.host;
  headers['x-forwarded-host'] = url.host;
  headers['x-forwarded-proto'] = url.protocol.slice(0, -1);
  if (context?.ip) headers['x-forwarded-for'] = String(context.ip);
  else delete headers['x-forwarded-for'];
  if (context?.requestId) headers['x-request-id'] = String(context.requestId);
  return headers;
}

async function createNodeRequest(request, context = {}) {
  const url = new URL(request.url);
  // Preserve the Fetch body as a stream. The application-level parsers then
  // enforce their 32 KiB JSON and 128/256 KiB webhook limits while bytes are
  // arriving, instead of this bridge first allocating the entire platform
  // request in memory.
  const nodeRequest = request.body
    ? Readable.fromWeb(request.body, { objectMode: false })
    : Readable.from([], { objectMode: false });
  nodeRequest.method = request.method.toUpperCase();
  nodeRequest.url = `${url.pathname}${url.search}`;
  nodeRequest.headers = requestHeaders(request, context, url);
  nodeRequest.rawHeaders = Object.entries(nodeRequest.headers).flatMap(([name, value]) => [name, String(value)]);
  nodeRequest.httpVersion = '1.1';
  nodeRequest.httpVersionMajor = 1;
  nodeRequest.httpVersionMinor = 1;
  nodeRequest.complete = true;
  nodeRequest.socket = { remoteAddress: context?.ip ? String(context.ip) : '127.0.0.1' };
  return nodeRequest;
}

class CollectingServerResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.statusMessage = '';
    this._headers = new Map();
    this._headersSent = false;
    this._chunks = [];
    this.completed = new Promise((resolve, reject) => {
      this.once('finish', resolve);
      this.once('error', reject);
    });
  }

  get headersSent() {
    return this._headersSent;
  }

  setHeader(name, value) {
    if (this._headersSent) throw new Error('headers have already been sent');
    this._headers.set(String(name).toLowerCase(), { name: String(name), value });
    return this;
  }

  getHeader(name) {
    return this._headers.get(String(name).toLowerCase())?.value;
  }

  getHeaders() {
    return Object.fromEntries([...this._headers.values()].map(({ name, value }) => [name.toLowerCase(), value]));
  }

  hasHeader(name) {
    return this._headers.has(String(name).toLowerCase());
  }

  removeHeader(name) {
    if (this._headersSent) throw new Error('headers have already been sent');
    this._headers.delete(String(name).toLowerCase());
  }

  writeHead(statusCode, statusMessage, headers) {
    if (typeof statusMessage !== 'string') {
      headers = statusMessage;
      statusMessage = '';
    }
    this.statusCode = Number(statusCode);
    this.statusMessage = statusMessage || '';
    if (headers) {
      if (Array.isArray(headers)) {
        for (let index = 0; index < headers.length; index += 2) {
          this.setHeader(headers[index], headers[index + 1]);
        }
      } else {
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      }
    }
    this._headersSent = true;
    return this;
  }

  _write(chunk, encoding, callback) {
    this._headersSent = true;
    this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }

  _final(callback) {
    this._headersSent = true;
    callback();
  }

  toWebResponse(method = 'GET') {
    const headers = new Headers();
    for (const [lowerName, { name, value }] of this._headers) {
      if (HOP_BY_HOP_HEADERS.has(lowerName) || value === undefined) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) headers.append(name, String(entry));
    }
    const bodyForbidden = method === 'HEAD' || [204, 205, 304].includes(this.statusCode);
    return new Response(bodyForbidden ? null : Buffer.concat(this._chunks), {
      status: this.statusCode,
      ...(this.statusMessage ? { statusText: this.statusMessage } : {}),
      headers,
    });
  }
}

async function invokeNodeHandler(request, context, handler) {
  if (typeof handler !== 'function') throw new TypeError('a Node request handler is required');
  const nodeRequest = await createNodeRequest(request, context);
  const nodeResponse = new CollectingServerResponse();
  try {
    await handler(nodeRequest, nodeResponse);
    await nodeResponse.completed;
  } catch (error) {
    nodeRequest.destroy();
    if (!nodeResponse.destroyed) nodeResponse.destroy(error);
    await nodeResponse.completed.catch(() => {});
    throw error;
  }
  return nodeResponse.toWebResponse(nodeRequest.method);
}

export { CollectingServerResponse, createNodeRequest, invokeNodeHandler };
