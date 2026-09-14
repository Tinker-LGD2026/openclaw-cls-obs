// Minimal OTLP/HTTP protobuf sink used to verify real end-to-end export.
//
// Decodes just enough of the OTLP trace protobuf to print the span tree and
// attributes, so end-to-end verification does not depend on CLS credentials.
const http = require("node:http");
const fs = require("node:fs");

const PORT = Number(process.env.SINK_PORT || 4318);
const OUT = process.env.SINK_OUT || "/tmp/oc-sink/spans.jsonl";

fs.mkdirSync(require("node:path").dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, "");

/** Reads a protobuf varint. */
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const byte = buf[pos];
    pos += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7n;
  }
  return [result, pos];
}

/** Walks protobuf fields, invoking a visitor per field. */
function walk(buf, visit) {
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const fieldNo = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (wireType === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      visit(fieldNo, wireType, value);
    } else if (wireType === 1) {
      visit(fieldNo, wireType, buf.subarray(pos, pos + 8));
      pos += 8;
    } else if (wireType === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const end = pos + Number(len);
      visit(fieldNo, wireType, buf.subarray(pos, end));
      pos = end;
    } else if (wireType === 5) {
      visit(fieldNo, wireType, buf.subarray(pos, pos + 4));
      pos += 4;
    } else {
      break;
    }
  }
}

function decodeAnyValue(buf) {
  let out;
  walk(buf, (field, wire, value) => {
    if (field === 1 && wire === 2) {
      out = value.toString("utf8");
    } else if (field === 2) {
      out = Boolean(value);
    } else if (field === 3) {
      out = Number(BigInt.asIntN(64, value));
    } else if (field === 4) {
      out = Number(BigInt.asIntN(64, value));
    } else if (field === 5 && wire === 2) {
      const items = [];
      walk(value, (f2, w2, v2) => {
        if (f2 === 1 && w2 === 2) {
          items.push(decodeAnyValue(v2));
        }
      });
      out = items;
    } else if (field === 6 && wire === 2) {
      const object = {};
      walk(value, (f2, w2, v2) => {
        if (f2 === 1 && w2 === 2) {
          const [key, entryValue] = decodeKeyValue(v2);
          if (key !== undefined) {
            object[key] = entryValue;
          }
        }
      });
      out = object;
    }
  });
  return out;
}

function decodeKeyValue(buf) {
  let key;
  let value;
  walk(buf, (field, wire, raw) => {
    if (field === 1 && wire === 2) {
      key = raw.toString("utf8");
    } else if (field === 2 && wire === 2) {
      value = decodeAnyValue(raw);
    }
  });
  return [key, value];
}

function decodeSpan(buf) {
  const span = { attributes: {} };
  walk(buf, (field, wire, value) => {
    switch (field) {
      case 1:
        span.traceId = value.toString("hex");
        break;
      case 2:
        span.spanId = value.toString("hex");
        break;
      case 4:
        span.parentSpanId = value.toString("hex");
        break;
      case 5:
        span.name = value.toString("utf8");
        break;
      case 6:
        span.kind = Number(value);
        break;
      case 7:
        span.startTimeUnixNano = value.readBigUInt64LE(0).toString();
        break;
      case 8:
        span.endTimeUnixNano = value.readBigUInt64LE(0).toString();
        break;
      case 9: {
        const [k, v] = decodeKeyValue(value);
        if (k !== undefined) {
          span.attributes[k] = v;
        }
        break;
      }
      case 15:
        walk(value, (f2, w2, v2) => {
          if (f2 === 2 && w2 === 2) {
            span.statusMessage = v2.toString("utf8");
          } else if (f2 === 3) {
            span.statusCode = Number(v2);
          }
        });
        break;
      default:
        break;
    }
  });
  return span;
}

function decodeRequest(body) {
  const spans = [];
  walk(body, (f1, w1, resourceSpans) => {
    if (f1 !== 1 || w1 !== 2) {
      return;
    }
    walk(resourceSpans, (f2, w2, scopeSpansOrResource) => {
      if (f2 !== 2 || w2 !== 2) {
        return;
      }
      walk(scopeSpansOrResource, (f3, w3, spanBuf) => {
        if (f3 === 2 && w3 === 2) {
          spans.push(decodeSpan(spanBuf));
        }
      });
    });
  });
  return spans;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    try {
      const spans = decodeRequest(body);
      for (const span of spans) {
        fs.appendFileSync(OUT, `${JSON.stringify(span)}\n`);
      }
      console.log(
        `[sink] ${req.method} ${req.url} bytes=${body.length} spans=${spans.length} auth=${
          req.headers.authorization ? "yes" : "no"
        } topic=${req.headers.topic_id || "-"}`,
      );
    } catch (error) {
      console.error(`[sink] decode failed: ${String(error)}`);
    }
    res.writeHead(200, { "content-type": "application/x-protobuf" });
    res.end(Buffer.alloc(0));
  });
});

server.listen(PORT, () => {
  console.log(`[sink] listening on http://127.0.0.1:${PORT}`);
});
