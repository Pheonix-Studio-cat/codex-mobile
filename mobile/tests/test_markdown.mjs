// Checks for web/markdown.js, run with plain Node (no browser, no packages):
//
//   node mobile/tests/test_markdown.mjs
//
// A minimal DOM stand-in is enough: the renderer only creates elements and
// text nodes. The most important check is the fuzz at the end — a renderer
// that loops forever freezes the phone, and an agent message can contain
// anything.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));

function element(tag) {
  return {
    tag,
    children: [],
    dataset: {},
    attributes: {},
    set textContent(value) {
      this.children = [{ tag: "#text", text: String(value) }];
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    set href(value) {
      this.attributes.href = value;
    },
    set target(value) {
      this.attributes.target = value;
    },
    set rel(value) {
      this.attributes.rel = value;
    },
  };
}

const document = {
  createDocumentFragment: () => element("#fragment"),
  createElement: (tag) => element(tag),
  createTextNode: (text) => ({ tag: "#text", text }),
};
const sandbox = { document, window: {} };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  readFileSync(resolve(here, "../web/markdown.js"), "utf8"),
  sandbox,
  { timeout: 1000 },
);

function render(source) {
  // A hard limit per call: an endless loop fails the test instead of hanging it.
  sandbox.__source = source;
  return vm.runInContext("renderMarkdown(__source)", sandbox, { timeout: 500 });
}

function html(node) {
  if (node.tag === "#text") return node.text;
  const inner = node.children.map(html).join("");
  if (node.tag === "#fragment") return inner;
  const href = node.attributes.href ? ` href="${node.attributes.href}"` : "";
  return `<${node.tag}${href}>${inner}</${node.tag}>`;
}

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    console.log("ok   " + name);
  } else {
    failures += 1;
    console.log(
      `FAIL ${name}\n     expected ${expected}\n     actual   ${actual}`,
    );
  }
}

check("paragraph", html(render("hello")), "<p>hello</p>");
check("bold", html(render("a **b** c")), "<p>a <strong>b</strong> c</p>");
check(
  "bold then italic",
  html(render("**b** and *i*")),
  "<p><strong>b</strong> and <em>i</em></p>",
);
check(
  "inline code keeps stars",
  html(render("`**x**`")),
  "<p><code>**x**</code></p>",
);
check(
  "list",
  html(render("- one\n- two")),
  "<ul><li>one</li><li>two</li></ul>",
);
check(
  "ordered list",
  html(render("1. one\n2. two")),
  "<ol><li>one</li><li>two</li></ol>",
);
check(
  "fence",
  html(render("```js\nlet a = 1;\n```")),
  "<pre><code>let a = 1;</code></pre>",
);
check(
  "unclosed fence while streaming",
  html(render("```\npartial")),
  "<pre><code>partial</code></pre>",
);
check(
  "almost a fence is a paragraph",
  html(render("```js extra")).startsWith("<p>"),
  true,
);
check("heading", html(render("# Title")), "<h2>Title</h2>");
check(
  "web link",
  html(render("[site](https://example.com)")),
  '<p><a href="https://example.com">site</a></p>',
);
check(
  "script link stays text",
  html(render("[x](javascript:alert(1))")),
  "<p>x (javascript:alert(1))</p>",
);
check(
  "html stays text",
  html(render("<img src=x onerror=alert(1)>")),
  "<p><img src=x onerror=alert(1)></p>",
);

// The case that froze the phone: every prefix of a streamed message.
const streamed =
  "Done. I created **codex-mobile-e2e.txt** with `touch`.\n\n- step one\n- step two";
let prefixesOk = true;
for (let n = 0; n <= streamed.length; n += 1) {
  try {
    render(streamed.slice(0, n));
  } catch (error) {
    prefixesOk = false;
    console.log(`     prefix ${n}: ${error.message}`);
    break;
  }
}
check("every prefix of a streamed message renders", prefixesOk, true);

// Fuzz: random text made of the characters the renderer cares about.
const alphabet = [
  "*",
  "**",
  "_",
  "`",
  "```",
  "~~~",
  "#",
  "-",
  "1.",
  ">",
  "[",
  "]",
  "(",
  ")",
  "http://a",
  " ",
  "\n",
  "a",
  "b",
];
let seed = 12345;
function random() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
let fuzzOk = true;
for (let round = 0; round < 3000 && fuzzOk; round += 1) {
  let text = "";
  const length = Math.floor(random() * 40);
  for (let k = 0; k < length; k += 1)
    text += alphabet[Math.floor(random() * alphabet.length)];
  try {
    render(text);
  } catch (error) {
    fuzzOk = false;
    console.log(`     input ${JSON.stringify(text)}: ${error.message}`);
  }
}
check("3000 random inputs render without hanging", fuzzOk, true);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
