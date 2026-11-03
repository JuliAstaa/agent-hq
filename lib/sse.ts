/**
 * Frames of a text/event-stream body as {event, data}. Comment lines (": keepalive") are skipped, multi-line data
 * is joined with "\n". Web APIs only, so the bridge (reading Hermes) and the browser (reading the bridge) share it.
 */
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r/g, "");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const c = line.indexOf(":");
          const field = c < 0 ? line : line.slice(0, c);
          let val = c < 0 ? "" : line.slice(c + 1);
          if (val.startsWith(" ")) val = val.slice(1);
          if (field === "event") event = val;
          else if (field === "data") data.push(val);
        }
        if (event || data.length) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
