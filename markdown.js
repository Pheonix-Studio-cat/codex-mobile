// A small Markdown renderer for agent messages.
//
// It builds DOM nodes and never assigns HTML strings, so text from the model
// cannot inject markup. Supported: fenced code, headings, lists, block quotes,
// paragraphs, inline code, bold, italics and http(s) links. Everything else
// is shown as text.
"use strict";

(function (global) {
  function renderMarkdown(source) {
    const fragment = document.createDocumentFragment();
    const lines = String(source || "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
      if (fence) {
        const marker = fence[1];
        const code = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith(marker)) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1; // closing fence (or end of text while streaming)
        const pre = document.createElement("pre");
        const el = document.createElement("code");
        if (fence[2]) el.dataset.lang = fence[2];
        el.textContent = code.join("\n");
        pre.appendChild(el);
        fragment.appendChild(pre);
        continue;
      }

      if (!line.trim()) {
        i += 1;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = Math.min(heading[1].length + 1, 4);
        const el = document.createElement("h" + level);
        appendInline(el, heading[2]);
        fragment.appendChild(el);
        i += 1;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        const el = document.createElement("blockquote");
        el.appendChild(renderMarkdown(quote.join("\n")));
        fragment.appendChild(el);
        continue;
      }

      const bullet = /^\s*[-*+]\s+/;
      const numbered = /^\s*\d+[.)]\s+/;
      if (bullet.test(line) || numbered.test(line)) {
        const ordered = numbered.test(line);
        const pattern = ordered ? numbered : bullet;
        const list = document.createElement(ordered ? "ol" : "ul");
        while (i < lines.length && pattern.test(lines[i])) {
          const item = document.createElement("li");
          let text = lines[i].replace(pattern, "");
          i += 1;
          // Continuation lines are indented and belong to the item.
          while (
            i < lines.length &&
            /^\s{2,}\S/.test(lines[i]) &&
            !pattern.test(lines[i])
          ) {
            text += " " + lines[i].trim();
            i += 1;
          }
          appendInline(item, text);
          list.appendChild(item);
        }
        fragment.appendChild(list);
        continue;
      }

      // The first line always belongs to the paragraph. Without that, a line
      // that looks almost like a fence ("```js extra") would be consumed by
      // nothing, and the loop would never advance.
      const paragraph = [line];
      i += 1;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(```|~~~)/.test(lines[i]) &&
        !/^#{1,6}\s/.test(lines[i]) &&
        !bullet.test(lines[i]) &&
        !numbered.test(lines[i]) &&
        !/^\s*>/.test(lines[i])
      ) {
        paragraph.push(lines[i]);
        i += 1;
      }
      const p = document.createElement("p");
      paragraph.forEach(function (text, index) {
        if (index > 0) p.appendChild(document.createElement("br"));
        appendInline(p, text);
      });
      fragment.appendChild(p);
    }
    return fragment;
  }

  // Inline: `code`, **bold**, *italic*, [text](http...). Order matters: code
  // spans first, so nothing inside them is interpreted.
  const INLINE_SOURCE =
    /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/
      .source;

  function appendInline(parent, text) {
    // A fresh expression per call: bold and italics recurse, and a shared
    // global expression would have its position reset by the inner call —
    // an endless loop on the first "**bold**".
    const inline = new RegExp(INLINE_SOURCE, "g");
    let last = 0;
    let match;
    while ((match = inline.exec(text)) !== null) {
      if (match.index > last)
        parent.appendChild(
          document.createTextNode(text.slice(last, match.index)),
        );
      if (match[1]) {
        const code = document.createElement("code");
        code.textContent = match[2];
        parent.appendChild(code);
      } else if (match[3] || match[4]) {
        const strong = document.createElement("strong");
        appendInline(strong, match[3] || match[4]);
        parent.appendChild(strong);
      } else if (match[5]) {
        const em = document.createElement("em");
        appendInline(em, match[5]);
        parent.appendChild(em);
      } else if (match[6]) {
        parent.appendChild(link(match[6], match[7]));
      }
      last = inline.lastIndex;
    }
    if (last < text.length)
      parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function link(label, href) {
    // Only web links become clickable. `javascript:` and friends stay text.
    if (!/^https?:\/\//i.test(href))
      return document.createTextNode(label + " (" + href + ")");
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label;
    return a;
  }

  global.renderMarkdown = renderMarkdown;
})(typeof window !== "undefined" ? window : globalThis);
